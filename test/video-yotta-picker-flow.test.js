'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, ask, request } = require('./video-picker-world');
const { entries } = require('../src/video/catalog');
const { byId } = require('../src/video/picker/entries');
const child = require('../src/video/picker/child');
const item = [...byId(entries()).values()].find(x => x.route === 'yotta');

test('Yotta quote and completed purchase name the provider and submit only once', async t => {
  assert.ok(item);
  const w = world(t);
  w.more[item.id] = item;
  w.offer = () => ({ok:true, amount:item.usdMicros, unit:'usd_micros', published:'2026-11-26'});
  const turns = [['user', 'A red ball rolls slowly']];
  const quote = await ask(w, request(item.id, turns));
  assert.match(quote, /not checked with Yotta/);
  turns.push(['assistant', quote], ['user', 'yes']);
  const result = await ask(w, request(item.id, turns));
  assert.match(result, /Yotta sets the final charge/);
  assert.equal(w.calls.submit.length, 1);
  assert.equal(w.calls.submit[0].route, 'yotta');
  await ask(w, request(item.id, turns));
  assert.equal(w.calls.submit.length, 1);
});

test('Yotta child-command path rejects clips outside the exact catalog preset before network', async () => {
  const command = require('../src/video/command');
  assert.ok(item);
  let calls = 0;
  for (const changed of [{resolution:'1080p'}, {model:'wan-3.0'}]) {
    await assert.rejects(async () => {
      const args = child.argsFor('submit', {...item, ...changed}, {prompt:'A red ball', cap:'1'});
      await command.run(args, () => {}, {env:{YOTTA_API_KEY:'synthetic-key'}, fetchImpl:async () => { calls++; throw new Error('unexpected network'); }});
    }, /Unsupported video|Invalid video|invalid entry/i);
  }
  assert.throws(() => child.argsFor('submit', {...item, unit:'krea_units'}, {prompt:'A red ball', cap:'1'}));
  assert.equal(calls, 0);
});
