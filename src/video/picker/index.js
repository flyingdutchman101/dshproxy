'use strict';
// Video entries in the chat model picker: a typed prompt gets a price quote, a
// confirming reply buys one clip, and a quote buys at most once.
//
//   create(options) -> { answer(body, write) }
//
// `answer` takes a parsed request body (Anthropic messages shape) and writes
// the answer as pieces of text through `write`; its promise resolves when the
// answer is complete and never rejects. Nothing that decides a purchase is
// kept in memory between requests: a second create() on the same folder is a
// faithful restart.
//
// Options:
//   home      the data folder; the picker keeps its files in <home>/video-picker
//   ops       { quote, submit, status }: the only way out to a provider
//   entries   () => Map(id -> { model, resolution, route, label, unit }), the
//             entries that are switched on now; asked at every request
//   exposed   () => false unless a DeepSeek Harness profile lets agents pick
//             the paid route; anything but false means no purchase
//   clock     { now, sleep, after }, random(count) and log(line): for tests.
//             after(ms, fn) calls fn once after ms and returns a function
//             that cancels it; a clock without it gets one made from sleep.
//
// Whether a confirmation may buy at all, and how much in 24 hours, is in
// <home>/video-picker/settings.json (settings.js), changed with
// `dshproxy video picker` (cli.js) and read at every request.
//
// See flow.js for what ops are called with and may answer, and store.js for
// the record that makes a quote buy at most once.
const crypto = require('node:crypto');
const store = require('./store');
const settings = require('./settings');
const flow = require('./flow');

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  }
};

// A timer for a clock that has none of its own. It cannot take its sleep
// back, so a cancelled one runs out unheard.
function afterBy(sleep) {
  return (ms, fn) => {
    let live = true;
    Promise.resolve().then(() => sleep(ms)).then(() => {
      if (live) fn();
    }, () => {});
    return () => { live = false; };
  };
}

function create(options) {
  const { home, ops, entries, exposed = () => true, clock = realClock, random = (count) => crypto.randomBytes(count), log = () => {} } = options || {};
  if (!ops || ['quote', 'submit', 'status'].some((name) => typeof ops[name] !== 'function')) throw new Error('The video picker needs ops: quote, submit and status.');
  if (typeof entries !== 'function') throw new Error('The video picker needs entries: a function that returns the entries switched on.');
  if (typeof exposed !== 'function' || typeof random !== 'function' || typeof log !== 'function') throw new Error('The video picker takes exposed, random and log as functions.');
  if (!clock || typeof clock.now !== 'function' || typeof clock.sleep !== 'function' || (clock.after !== undefined && typeof clock.after !== 'function')) {
    throw new Error('The video picker takes clock as { now, sleep } with an optional after.');
  }
  const timing = { now: () => clock.now(), sleep: (ms) => clock.sleep(ms), after: clock.after === undefined ? afterBy((ms) => clock.sleep(ms)) : (ms, fn) => clock.after(ms, fn) };

  // Makes the folders and, when there is none, the journal of purchases with
  // its header. A journal made just now refuses purchases for its first minute.
  const files = store.open(home);
  files.init(timing.now());
  const deps = { store: files, settings: () => settings.read(home), ops, entries, exposed, clock: timing, random, log };

  // Old files are deleted now and at most once a day after; never the journal.
  let cleaned = NaN;
  const tidy = () => {
    try {
      const now = timing.now();
      if (Math.abs(now - cleaned) < store.DAY_MS) return;
      cleaned = now;
      files.cleanUp(now);
    } catch {
      // clean-up is a courtesy; the next one tries again
    }
  };
  tidy();

  return {
    answer(body, write) {
      if (typeof write !== 'function') return Promise.reject(new TypeError('answer(body, write) needs write as a function.'));
      tidy();
      return flow.answer(deps, body, write);
    }
  };
}

module.exports = { create };
