'use strict';
// The purchase record's own rules, at their edges. Throwaway folders only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/video/picker/store');
const child = require('../src/video/picker/child');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-picker-store-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const ID = 'Q-ABCDEFGHJKMNPQRS';
const line = (claimedAt) => JSON.stringify({ id: ID, nonce: '0123456789abcdef0123456789abcdef', entry: 'seedance-2.5/720p/krea', amount: 856, unit: 'krea_units', cap: '856', claimedAt });

test('a journal line with a time before 1970 is not a claim record: nobody holds it, and it cannot fall out of the ceiling as "long ago"', (t) => {
  const now = Date.now();
  for (const [claimedAt, held] of [[now, true], [0, true], [-1, false], [-1e15, false], [1.5, false], ['1', false]]) {
    const home = tempHome(t);
    const files = store.open(home);
    files.init(now);
    fs.appendFileSync(files.journal, `\n${line(claimedAt)}\n`);
    const found = files.claims().get(ID);
    assert.ok(found, `the line names the quote, so the quote is used (claimedAt ${claimedAt})`);
    assert.equal(found.record !== null, held, `claimedAt ${JSON.stringify(claimedAt)}`);
  }
});

test('every cap the record accepts is a cap the video command takes, and nothing larger is quoted', () => {
  const entries = {
    krea_units: { model: 'seedance-2.5', resolution: '720p', route: 'krea', unit: 'krea_units' },
    usd_micros: { model: 'wan-3.0', resolution: '1080p', route: 'videorouter', unit: 'usd_micros' },
    callirra_credits: { model: 'minimax-h3', resolution: '768p', route: 'callirra', unit: 'callirra_credits' }
  };
  const largest = { krea_units: 999999999, usd_micros: 999999999999, callirra_credits: 999999 };
  for (const [unit, amount] of Object.entries(largest)) {
    const cap = store.capOf(unit, amount);
    assert.equal(typeof cap, 'string', `${unit}: the largest amount has a cap`);
    assert.doesNotThrow(() => child.argsFor('submit', entries[unit], { prompt: 'A red ball', cap }), `${unit}: cap ${cap} is taken`);
    assert.equal(store.capOf(unit, amount + 1), null, `${unit}: one more is not quoted`);
  }
  // Small amounts, as real prices are.
  for (const [unit, amount, text] of [['krea_units', 856, '856'], ['krea_units', 380.33333333333326, '380.333334'], ['usd_micros', 702125, '0.702125'], ['usd_micros', 1, '0.000001'], ['callirra_credits', 10, '10']]) {
    assert.equal(store.capOf(unit, amount), text);
    assert.doesNotThrow(() => child.argsFor('submit', entries[unit], { prompt: 'A red ball', cap: text }));
  }
});