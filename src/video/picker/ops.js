'use strict';
// The real ops of the video picker: the only way from the gateway out to a
// provider. Each call is one child process (child.js) that runs the video
// command once, so the gateway process never loads a provider key or the Krea
// sign-in. See flow.js for what the picker expects of quote, submit and status.
//
//   real({ home, spawnChild }) -> { quote, submit, status }
//
// `home` is the gateway's data folder; the child works in it. `spawnChild` is
// child.spawnChild unless a test replaces it.
//
// Nothing here sends twice. A submit is one child, started once, never timed
// out and never stopped. When the child could not even be started, nothing was
// sent, and that is recorded as the quote's outcome; in every other case the
// child writes the outcome itself, and a child that ends without one leaves
// the outcome unknown (flow.js).
const fs = require('node:fs');
const catalog = require('../catalog');
const child = require('./child');
const { unitOf } = require('./entries');

// The Krea helper allows itself 90 seconds; an API request 30 and a saved key
// 20 to unlock. A quote or a status that has not answered by then is given up.
const QUOTE_MS = 120000;
const STATUS_MS = 120000;

// Providers name the end of a job differently. The picker ends a job on
// `completed`, `failed`, `cancelled` and `canceled`.
const SAME_AS = { succeeded: 'completed', expired: 'failed' };

// The catalog's entry for what an order names, with the unit the picker counts
// in; null when the catalog no longer lists that combination.
function entryFor(order) {
  try {
    const found = catalog.entry(order.model, order.resolution, order.route);
    return { ...found, unit: unitOf(found) };
  } catch {
    return null;
  }
}

// "Nothing was sent" as the outcome of a quote, for an order whose child was
// never started. Written once; an outcome that is already there stays.
function recordNotSent(order) {
  let handle;
  try {
    handle = fs.openSync(order.outcomeFile, 'wx');
    fs.writeSync(handle, `${JSON.stringify({ nonce: order.nonce, state: 'not-sent', reason: 'bad-request' })}\n`);
    fs.fsyncSync(handle);
  } catch {
    // without it the outcome reads as unknown, which is never sent again either
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* nothing to release */ }
    }
  }
}

function real({ home, spawnChild = child.spawnChild } = {}) {
  if (typeof home !== 'string' || !home) throw new Error('The video picker needs the data folder as a path.');
  if (typeof spawnChild !== 'function') throw new Error('The video picker takes spawnChild as a function.');

  // Krea: a free preflight in the signed-in workspace. Every other route: the
  // published price from the catalog, read by the child without any request.
  async function quote(order) {
    const entry = entryFor(order);
    if (entry === null) return { ok: false, reason: 'failed' };
    let args;
    try {
      args = child.argsFor('quote', entry, entry.unit === 'krea_units' ? { prompt: order.prompt } : {});
    } catch {
      return { ok: false, reason: 'failed' };
    }
    const ran = await spawnChild({ kind: 'quote', args }, { home, timeoutMs: QUOTE_MS });
    if (!ran || ran.ok !== true || !ran.result) return { ok: false, reason: 'failed' };
    const line = ran.result;
    if (line.ok !== true) return { ok: false, reason: line.reason };
    if (line.unit !== entry.unit) return { ok: false, reason: 'failed' };
    if (entry.unit === 'krea_units') {
      // The workspace cannot pay for it: no quote, and the two numbers.
      if (line.affordable !== true) return { ok: false, reason: 'balance', needs: line.amount, has: line.available };
      return { ok: true, amount: line.amount, unit: line.unit, estimated: line.estimated, available: line.available };
    }
    return { ok: true, amount: line.amount, unit: line.unit, published: line.verifiedOn };
  }

  // The one paid request of a quote. The picker has claimed the quote before
  // it calls this, and looks only at the outcome file afterwards.
  async function submit(order) {
    const entry = entryFor(order);
    let args = null;
    if (entry !== null && entry.unit === order.unit) {
      try {
        args = child.argsFor('submit', entry, { prompt: order.prompt, cap: order.cap });
      } catch {
        args = null;
      }
    }
    if (args === null) return recordNotSent(order);
    const ran = await spawnChild({ kind: 'submit', args, outcomeFile: order.outcomeFile, nonce: order.nonce }, { home });
    // started: false is the one answer that says no process ran at all.
    if (ran && ran.ok === false && ran.started === false) recordNotSent(order);
    return undefined;
  }

  async function status(order) {
    const entry = entryFor(order);
    if (entry === null) return { ok: false, reason: 'unreachable' };
    let args;
    try {
      args = child.argsFor('status', entry, { jobId: order.jobId });
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
    const ran = await spawnChild({ kind: 'status', args }, { home, timeoutMs: STATUS_MS });
    if (!ran || ran.ok !== true || !ran.result) return { ok: false, reason: 'unreachable' };
    const line = ran.result;
    if (line.ok !== true) return { ok: false, reason: line.reason === 'sign-in' ? 'sign-in' : 'unreachable' };
    if (line.jobId !== order.jobId) return { ok: false, reason: 'unreachable' };
    const state = Object.hasOwn(SAME_AS, line.status) ? SAME_AS[line.status] : line.status;
    return { ok: true, status: state, links: typeof line.outputUrl === 'string' ? [line.outputUrl] : [] };
  }

  return { quote, submit, status };
}

module.exports = { real, QUOTE_MS, STATUS_MS };
