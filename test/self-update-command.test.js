const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../src/cli');

test('self-update rejects an unpinned install with a machine-readable result', async () => {
  const lines = [];
  await main(['self-update', 'install', '--sha', 'main'], line => lines.push(line));
  assert.match(lines[0] || '', /^\{"status":"unavailable"/);
  assert.match(JSON.parse(lines[0]).message, /revision/i);
});
