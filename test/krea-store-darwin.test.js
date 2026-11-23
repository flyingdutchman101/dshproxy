'use strict';
require('./support/keychain'); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
// The Krea sign-in store on macOS (docs/work/0014-macos-port, stage B, B1):
// the same file as on Windows, in ~/Library/Application Support/DSHProxy/KreaOAuth,
// private to the account, its key wrapped through the Keychain. Every token
// here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeKeychain } = require('./support/keychain');

const macOnly = process.platform === 'darwin' ? {} : { skip: 'macOS store; Windows keeps its own, tested in krea-renewal-process.test.js' };
const session = { resource: 'https://api.krea.ai/mcp', accessToken: 'invented-access-token', refreshToken: 'invented-refresh-token', clientId: 'invented-client', tokenEndpoint: 'https://api.krea.ai/token', expiresAt: 4102444800000 };

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-krea-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const folderOf = (dir) => path.join(dir, 'Library', 'Application Support', 'DSHProxy', 'KreaOAuth');

test('on macOS the sign-in is kept in Application Support, private to the account, with no token in the clear', macOnly, async (t) => {
  const { macStore } = require('../src/krea-helper/oauth');
  const dir = home(t);
  const store = macStore({ home: dir });
  await store.save(session);
  const folder = folderOf(dir);
  assert.deepEqual(fs.readdirSync(folder), ['session.v1']);
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(folder, 'session.v1')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(folder, 'session.v1'), 'utf8').includes('invented-'));
  assert.deepEqual(await macStore({ home: dir }).load(), session);
  await store.clear();
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('on macOS a sign-in saved under one Keychain cannot be read with another', macOnly, async (t) => {
  const { macStore } = require('../src/krea-helper/oauth');
  const { createKeywrap } = require('../src/keywrap-darwin');
  const other = makeKeychain('other');
  t.after(other.remove);
  const dir = home(t);
  await macStore({ home: dir }).save(session);
  const stranger = createKeywrap({ keychain: other.file });
  await assert.rejects(macStore({ home: dir, keywrap: stranger }).load(), /KREA_REFUSED/);
});

test('on macOS the store needs a home folder, and is refused on other systems', macOnly, () => {
  const { macStore } = require('../src/krea-helper/oauth');
  assert.throws(() => macStore({ home: '' }), /KREA_REFUSED/);
  assert.throws(() => macStore({ home: 'relative/folder' }), /KREA_REFUSED/);
});

test('on macOS the key handed to the Keychain wrapper is wiped after saving, also when wrapping fails', macOnly, async (t) => {
  const { macStore } = require('../src/krea-helper/oauth');
  const dir = home(t);
  const handed = [];
  const keywrap = (fail) => ({
    wrap: async (bytes) => { handed.push(bytes); if (fail) throw new Error('locked'); return 'kc1:AAAA'; },
    unwrap: async () => null
  });
  await macStore({ home: dir, keywrap: keywrap(false) }).save(session);
  await assert.rejects(macStore({ home: dir, keywrap: keywrap(true) }).save(session), /KREA_REFUSED/);
  assert.equal(handed.length, 2);
  for (const bytes of handed) assert.ok(Buffer.isBuffer(bytes) && bytes.length === 32 && bytes.every((byte) => byte === 0), 'a copy of the key was left in memory');
});
