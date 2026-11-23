'use strict';
// What the video picker keeps on disk, in <home>/video-picker/:
//
//   claims.log            the journal: one line for every quote that was used
//   quotes/<id>.json      written once, when a quote is issued
//   outcomes/<id>.json    written once: what the one attempt led to
//   results/<id>.json     written once: the job's final state and link
//
// A quote can lead to at most one paid request because of the journal alone.
// To use a quote, a caller appends one line to the journal, flushes it, reads
// the whole journal again and looks for the FIRST line that names the quote.
// Only the caller whose line that is may send. The journal is only ever
// appended to: nothing here truncates, rewrites, renames or deletes it, and a
// claim never creates it. There is no lock and nothing to take over, so a
// claim has no time limit and no owner to steal it from.
//
// Every other file is created exclusively and never changed. Losing one of
// them fails closed: no quote, no purchase; no outcome, "unknown".
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FOLDER = 'video-picker';
const JOURNAL = 'claims.log';
const KINDS = ['quotes', 'outcomes', 'results'];

// 30 characters, none of which is easily misread. An id is long and random
// enough that looking for it in a line cannot match by accident.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const ID_PATTERN = `Q-[${ALPHABET}]{16}`;
const ID = new RegExp(`^${ID_PATTERN}$`);
const NONCE = /^[0-9a-f]{32}$/;
const ENTRY = /^[a-z0-9][a-z0-9./-]{2,79}$/;
const UNIT = /^[a-z][a-z0-9_]{0,31}$/;
const CAP = /^\d{1,9}(?:\.\d{1,6})?$/;
const SHA = /^[0-9a-f]{64}$/;
const JOB = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATUS = /^[a-z][a-z0-9_-]{0,63}$/;
// Failures known to happen before the paid request is sent.
const NOT_SENT_REASONS = ['sign-in', 'refused', 'bad-request', 'over-cap', 'no-key', 'ceiling'];

const MIN_JOURNAL_AGE_MS = 60000;
const MAX_RECORD_BYTES = 4096;
const QUOTE_LIFE_MS = 600000;

function plain(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// `random(count)` gives that many random bytes. Bytes that would favour some
// characters are thrown away, so every id is equally likely.
function newId(random) {
  let id = 'Q-';
  for (let draws = 0; draws < 64 && id.length < 18; draws += 1) {
    const bytes = random(16);
    if (!(bytes instanceof Uint8Array) || bytes.length !== 16) break;
    for (const byte of bytes) {
      if (byte < 240 && id.length < 18) id += ALPHABET[byte % ALPHABET.length];
    }
  }
  if (!ID.test(id)) throw new Error('No quote id could be drawn.');
  return id;
}

// One journal line as a claim record, or null when it is not one.
function recordOf(line) {
  if (line.length > MAX_RECORD_BYTES) return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!plain(value)) return null;
  const { id, nonce, entry, amount, unit, cap, claimedAt } = value;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return null;
  if (typeof entry !== 'string' || !ENTRY.test(entry)) return null;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
  if (typeof unit !== 'string' || !UNIT.test(unit)) return null;
  if (typeof cap !== 'string' || !CAP.test(cap)) return null;
  if (!Number.isSafeInteger(claimedAt)) return null;
  return { id, nonce, entry, amount, unit, cap, claimedAt };
}

// The claim of a quote is the FIRST journal line that names it. A line that
// names the quote but is not a record of it (torn, damaged, or anything else)
// is a claim that nobody holds: `record` is null and the answer is "unknown".
function firstClaim(text, id) {
  for (const line of text.split('\n')) {
    if (!line.includes(id)) continue;
    const record = recordOf(line);
    return { id, record: record !== null && record.id === id ? record : null };
  }
  return null;
}

function quoteOf(value, id) {
  if (!plain(value) || value.v !== 1 || value.id !== id) return null;
  const { entry, model, resolution, route, label, prompt, promptSha, amount, unit, cap, estimated, issuedAt, expiresAt, answerSha } = value;
  for (const text of [model, route, label, prompt]) if (typeof text !== 'string' || text === '') return null;
  if (typeof entry !== 'string' || !ENTRY.test(entry)) return null;
  if (resolution !== null && typeof resolution !== 'string') return null;
  if (typeof promptSha !== 'string' || promptSha !== sha256(prompt)) return null;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
  if (typeof unit !== 'string' || !UNIT.test(unit)) return null;
  // The cap is what is sent as the spending limit; it is never below the quote.
  if (typeof cap !== 'string' || !CAP.test(cap) || Number(cap) < amount) return null;
  if (typeof estimated !== 'boolean') return null;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt - issuedAt !== QUOTE_LIFE_MS) return null;
  if (typeof answerSha !== 'string' || !SHA.test(answerSha)) return null;
  return Object.freeze({ v: 1, id, entry, model, resolution, route, label, prompt, promptSha, amount, unit, cap, estimated, issuedAt, expiresAt, answerSha });
}

// An outcome as one of a closed set. It must carry the nonce of the claim it
// belongs to; anything else, and anything not understood, is "unknown".
function outcomeOf(value, nonce) {
  const unknown = { state: 'unknown' };
  if (!plain(value) || typeof nonce !== 'string' || !NONCE.test(nonce) || value.nonce !== nonce) return unknown;
  if (value.state === 'submitted') {
    if (typeof value.jobId !== 'string' || !JOB.test(value.jobId) || typeof value.status !== 'string' || !STATUS.test(value.status)) return unknown;
    return { state: 'submitted', jobId: value.jobId, status: value.status };
  }
  if (value.state === 'not-sent') return NOT_SENT_REASONS.includes(value.reason) ? { state: 'not-sent', reason: value.reason } : unknown;
  if (value.state === 'rehearsal' || value.state === 'declined') return { state: value.state };
  return unknown;
}

function resultOf(value, jobId) {
  if (!plain(value) || value.jobId !== jobId) return null;
  if (value.state === 'completed' && (value.url === null || typeof value.url === 'string')) return { state: 'completed', url: value.url };
  if (value.state === 'failed') return { state: 'failed' };
  return null;
}

// Created once and never changed: of any number of callers in any number of
// processes one creates the file and the others are told it exists (false).
function writeOnce(file, object) {
  const data = Buffer.from(`${JSON.stringify(object)}\n`, 'utf8');
  let handle;
  try {
    handle = fs.openSync(file, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    let done = 0;
    while (done < data.length) done += fs.writeSync(handle, data, done, data.length - done);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return true;
}

// { found: false } when there is no file; `value` is undefined when the file
// is there but does not hold JSON (half written, or damaged).
function readOnce(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { found: false };
    throw error;
  }
  try {
    return { found: true, value: JSON.parse(text) };
  } catch {
    return { found: true, value: undefined };
  }
}

function open(home) {
  if (typeof home !== 'string' || !home.trim()) throw new Error('The video picker needs the data folder as a path.');
  const folder = path.join(home, FOLDER);
  const journal = path.join(folder, JOURNAL);
  // Only an id of the exact form ever becomes part of a path.
  const fileOf = (kind, id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Not a quote id.');
    return path.join(folder, kind, `${id}.json`);
  };

  // Makes the folders, and the journal when there is none: created
  // exclusively and flushed. An existing journal is left exactly as it is.
  function init() {
    for (const kind of KINDS) fs.mkdirSync(path.join(folder, kind), { recursive: true });
    try {
      const handle = fs.openSync(journal, 'wx');
      try {
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (!fs.statSync(journal).isFile()) throw new Error('The purchase record of the video picker is not a file.');
  }

  // How long the journal has existed at `now`, by the file's creation time.
  // NaN when that cannot be told, which counts as too young.
  function journalAge(now) {
    const stat = fs.statSync(journal);
    const born = stat.birthtimeMs;
    if (!stat.isFile() || !Number.isFinite(born) || born <= 0 || !Number.isFinite(now)) return NaN;
    return now - born;
  }

  // null, or { id, record } for the first line that names the quote.
  function claimOf(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Not a quote id.');
    return firstClaim(fs.readFileSync(journal, 'utf8'), id);
  }

  // Uses the quote. Returns
  //   { held: true, nonce, record }   this caller, and no other, may send;
  //   { held: false, claim }          the quote was already used;
  //   { held: false, young: true }    the journal is younger than a minute:
  //                                   nothing was written.
  // Throws when the claim could not be recorded and read back; `appended`
  // on the error says whether the line may be in the journal all the same,
  // in which case the quote is spent. After a throw nothing may be sent.
  function claim({ id, entry, amount, unit, cap, claimedAt }) {
    const failure = (appended) => Object.assign(new Error('The claim could not be recorded.'), { code: 'VIDEO_PICKER_CLAIM', appended });
    // 128 bits from the system, never from an injected source: two callers
    // must not be able to write the same nonce.
    const nonce = crypto.randomBytes(16).toString('hex');
    const record = { id, nonce, entry, amount, unit, cap, claimedAt };
    const line = JSON.stringify(record);
    let appended = false;
    let first;
    try {
      if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES || recordOf(line) === null) throw new Error('not a record');
      if (!(journalAge(claimedAt) >= MIN_JOURNAL_AGE_MS)) return { held: false, young: true };
      // The line starts with a line break of its own, so it can never be
      // joined to a torn line left at the end of the journal.
      const data = Buffer.from(`\n${line}\n`, 'utf8');
      // Append only, and never create: a journal that is gone is an error.
      const handle = fs.openSync(journal, fs.constants.O_WRONLY | fs.constants.O_APPEND);
      try {
        appended = true;
        if (fs.writeSync(handle, data, 0, data.length) !== data.length) throw new Error('short write');
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      first = firstClaim(fs.readFileSync(journal, 'utf8'), id);
    } catch {
      throw failure(appended);
    }
    if (first === null) throw failure(true);
    if (first.record !== null && first.record.nonce === nonce) return { held: true, nonce, record: first.record };
    return { held: false, claim: first };
  }

  function writeQuote(record) {
    const clean = quoteOf(record, record && record.id);
    if (clean === null) throw new Error('Not a quote record.');
    return writeOnce(fileOf('quotes', clean.id), clean);
  }

  // The quote, or null when it is missing or does not read cleanly.
  function readQuote(id) {
    const read = readOnce(fileOf('quotes', id));
    return read.found ? quoteOf(read.value, id) : null;
  }

  function writeOutcome(id, outcome) {
    return writeOnce(fileOf('outcomes', id), outcome);
  }

  // null when there is no outcome file; { state: 'damaged' } while it does
  // not hold JSON; otherwise the outcome for the claim with that nonce.
  function readOutcome(id, nonce) {
    const read = readOnce(fileOf('outcomes', id));
    if (!read.found) return null;
    return read.value === undefined ? { state: 'damaged' } : outcomeOf(read.value, nonce);
  }

  function writeResult(id, result) {
    return writeOnce(fileOf('results', id), result);
  }

  // The stored final state of that job, or null: an unreadable result is ignored.
  function readResult(id, jobId) {
    const read = readOnce(fileOf('results', id));
    return read.found ? resultOf(read.value, jobId) : null;
  }

  return {
    folder, journal, init, journalAge, claimOf, claim,
    writeQuote, readQuote, writeOutcome, readOutcome, writeResult, readResult,
    outcomeFile: (id) => fileOf('outcomes', id)
  };
}

module.exports = { open, newId, sha256, ID_PATTERN, ENTRY, UNIT, QUOTE_LIFE_MS, MIN_JOURNAL_AGE_MS, NOT_SENT_REASONS };
