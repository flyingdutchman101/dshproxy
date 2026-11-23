'use strict';
// Every test file that can reach the macOS key wrapper requires this first.
// On macOS it makes a throwaway keychain file in the temporary folder and names
// it in DSHPROXY_KEYCHAIN, so this process and every child it starts with its
// environment use that file and never a login Keychain. The keychain is
// unlocked and never locks itself; it is deleted when the process ends.
// On Windows it does nothing.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SECURITY = '/usr/bin/security';

function security(args) {
  const done = spawnSync(SECURITY, args, { env: { HOME: process.env.HOME }, encoding: 'utf8', timeout: 10000 });
  if (done.status !== 0) throw new Error(`security ${args[0]} failed (exit ${done.status}${done.error ? `, ${done.error.code}` : ''}): ${String(done.stderr).trim()}`);
}

// A new unlocked keychain file in its own temporary folder. Returns its path
// and a function that deletes it.
function makeKeychain(name = 'dshproxy-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-keychain-'));
  const file = path.join(dir, `${name}.keychain-db`);
  const password = crypto.randomBytes(16).toString('hex');
  security(['create-keychain', '-p', password, file]);
  // No setting: the keychain does not lock after a while or on sleep.
  security(['set-keychain-settings', file]);
  security(['unlock-keychain', '-p', password, file]);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    spawnSync(SECURITY, ['delete-keychain', file], { env: { HOME: process.env.HOME }, timeout: 10000 });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { file, password, remove };
}

if (process.platform === 'darwin' && !process.env.DSHPROXY_KEYCHAIN) {
  const made = makeKeychain();
  process.env.DSHPROXY_KEYCHAIN = made.file;
  process.on('exit', made.remove);
}

module.exports = { makeKeychain, keychain: process.env.DSHPROXY_KEYCHAIN || null, SECURITY };
