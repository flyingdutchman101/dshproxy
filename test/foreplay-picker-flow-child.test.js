'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execute, runPaid } = require('../src/provider-picker/foreplay-child');

test('child paid seam sends fixed search once and caps synthetic results', async () => {
  let calls = 0;
  const result = await execute({ operation: 'search', query: 'shoes', home: '/unused' }, {
    env: { FOREPLAY_API_KEY: 'synthetic' },
    fetch: async url => {
      calls++;
      assert.equal(url.origin, 'https://public.api.foreplay.co');
      assert.equal(url.searchParams.get('query'), 'shoes');
      assert.equal(url.searchParams.get('limit'), '10');
      return new Response(JSON.stringify({ metadata: { success: true }, data: Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: 'Sample' })) }), { headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.items.length, 10);
});

test('aborted child operation cannot start', async () => {
  await assert.rejects(runPaid({ operation: 'boards' }, { signal: AbortSignal.abort() }), /Cancelled/);
});

test('child rejects arbitrary command without network', async () => {
  await assert.rejects(execute({ operation: 'key' }), /Invalid operation/);
});
