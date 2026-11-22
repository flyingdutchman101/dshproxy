'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { models, quote } = require('../src/video/catalog');

test('public models and pinned default benchmark quotes', () => {
  assert.deepEqual(models, ['seedance-2.5', 'seedance-2.0', 'minimax-h3', 'wan-3.0']);
  for (const [model, route, modelId, usdMicros, resolution] of [
    ['seedance-2.5', 'videorouter', 'bytedance/seedance-2.5/socheap-overseas', 702125, '720p'],
    ['seedance-2.0', 'videorouter', 'bytedance/seedance-2.0/socheap-overseas', 459200, '720p'],
    ['minimax-h3', 'kovapi', 'minimax-h3', 125000, '768p'],
    ['wan-3.0', 'videorouter', 'alibaba/wan-3.0/botsmart', 226013, '720p'],
  ]) {
    const q = quote(model);
    assert.deepEqual([q.model, q.route, q.modelId, q.usdMicros, q.resolution], [model, route, modelId, usdMicros, resolution]);
    assert.deepEqual([q.durationSeconds, q.aspectRatio, q.verifiedOn], [5, '16:9', '2026-11-21']);
    assert.ok(q.sourceUrls.length && q.sourceUrls.every(url => url.startsWith('https://')));
    assert.deepEqual(quote(model, route), q);
  }
});
const alternative = (model, route, modelId, usdMicros) => {
  const q = quote(model, route);
  assert.deepEqual([q.model, q.route, q.modelId, q.usdMicros], [model, route, modelId, usdMicros]);
};
test('explicit fallback quotes keep distinct provider model IDs and prices', () => {
  alternative('seedance-2.5', 'kovapi', 'seedance-2.5', 790000);
  alternative('seedance-2.0', 'kovapi', 'seedance-2.0', 525000);
  alternative('wan-3.0', 'kovapi', 'wan3.0-video', 325000);
  alternative('wan-3.0', 'videorouter-replicate', 'alibaba/wan-3.0/replicate', 256250);
});
test('Callirra is a full-use effective rate, not a per-job USD debit', () => {
  alternative('minimax-h3', 'callirra', 'minimax-h3', 99667);
  const q = quote('minimax-h3', 'callirra');
  assert.equal(q.priceBasis, 'effective');
  assert.equal(q.credits, 10);
  assert.match(q.assumption, /full use/i);
});
test('workspace route choices contain exact supported models and Krea', () => {
  const {routesFor}=require('../src/video/catalog');
  assert.deepEqual(routesFor('wan-3.0'),['videorouter','videorouter-replicate','kovapi','krea']);
  assert.deepEqual(routesFor('minimax-h3'),['kovapi','callirra','krea']);
  assert.throws(()=>routesFor('__proto__'),/model/);
});
test('rejects unsupported pairs, unknown keys and inherited object properties', () => {
  for (const model of ['constructor', '__proto__', 'wan-3.0-prime']) assert.throws(() => quote(model), /model/i);
  for (const route of ['toString', 'krea', null, '', 'callirra']) assert.throws(() => quote('wan-3.0', route), /route/i);
});
