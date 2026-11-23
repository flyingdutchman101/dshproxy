'use strict';
// Video entries in the chat model picker: a typed prompt gets a price quote, a
// confirming reply buys one clip, and a quote buys at most once.
//
//   create(options) -> { answer(body, write) }
//
// `answer` takes a parsed request body (Anthropic messages shape) and writes
// the answer as pieces of text through `write`; its promise resolves when the
// answer is complete and never rejects. Nothing is kept in memory between
// requests: a second create() on the same folder is a faithful restart.
//
// Options:
//   home      the data folder; the picker keeps its files in <home>/video-picker
//   ops       { quote, submit, status }: the only way out to a provider
//   entries   () => Map(id -> { model, resolution, route, label, unit }), the
//             entries that are switched on now; asked at every request
//   exposed   () => false unless a DeepSeek Harness profile lets agents pick
//             the paid route; anything but false means no purchase
//   clock     { now, sleep }, random(count) and log(line): for tests
//
// See flow.js for what ops are called with and may answer, and store.js for
// the record that makes a quote buy at most once.
const crypto = require('node:crypto');
const store = require('./store');
const flow = require('./flow');

const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) };

function create(options) {
  const { home, ops, entries, exposed = () => true, clock = realClock, random = (count) => crypto.randomBytes(count), log = () => {} } = options || {};
  if (!ops || ['quote', 'submit', 'status'].some((name) => typeof ops[name] !== 'function')) throw new Error('The video picker needs ops: quote, submit and status.');
  if (typeof entries !== 'function') throw new Error('The video picker needs entries: a function that returns the entries switched on.');
  if (typeof exposed !== 'function' || typeof random !== 'function' || typeof log !== 'function') throw new Error('The video picker takes exposed, random and log as functions.');
  if (!clock || typeof clock.now !== 'function' || typeof clock.sleep !== 'function') throw new Error('The video picker takes clock as { now, sleep }.');

  // Makes the folders and, when there is none, the journal of purchases. A
  // journal made just now refuses purchases for its first minute.
  const files = store.open(home);
  files.init();
  const deps = { store: files, ops, entries, exposed, clock, random, log };

  return {
    answer(body, write) {
      if (typeof write !== 'function') return Promise.reject(new TypeError('answer(body, write) needs write as a function.'));
      return flow.answer(deps, body, write);
    }
  };
}

module.exports = { create };
