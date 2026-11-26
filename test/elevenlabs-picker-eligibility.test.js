'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const entries = require('../src/video/picker/entries');

test('unknown-price or asset-only models cannot be offered by the text-only, capped picker', () => {
  const row = { model: 'test', resolution: '720p', route: 'elevenlabs' };
  for (const extra of [{ priceBasis: 'unavailable' }, { inputMode: 'image-audio' }]) {
    assert.equal(entries.byId([{ ...row, ...extra }]).size, 0);
  }
});
