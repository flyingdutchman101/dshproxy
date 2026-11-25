'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startInstall, readResult } = require('../src/self-update/install');
test('install refuses mutable refs and unsupported layouts without changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-install-'));
  try {
    for (const sha of ['main', 'HEAD', '--help', 'a'.repeat(39), 'z'.repeat(40)]) {
      const result = await startInstall({ root, sha });
      assert.equal(result.status, 'unavailable');
      assert.match(result.message, /SHA/);
    }
    assert.equal((await startInstall({root, sha: 'a'.repeat(40)})).status, 'unavailable');
    assert.deepEqual(await fs.readdir(root), []);
    assert.equal((await readResult({root})).status, 'unavailable');
  } finally { await fs.rm(root, {recursive:true, force:true}); }
});
