'use strict';
// The key wrapper on macOS: what DPAPI is on Windows. It ties DSHProxy's
// master key to the user's account through the Keychain.
//
// One random 32-byte wrapping key per user is kept in a Keychain as a generic
// password (service "DSHProxy", account "key-wrapper", 64 hex characters),
// made on first use. `wrap` and `unwrap` are AES-256-GCM with it, in Node.
// The Keychain is reached through /usr/bin/security, part of macOS:
//
//   read   security find-generic-password -s DSHProxy -a key-wrapper -w [keychain]
//          the key on standard output; exit 44 when there is none yet
//   write  security -i, with the one command on standard input, so the key is
//          in no argument list; exit 45 when one exists already
//
// The program gets only HOME in its environment. Every call ends after 10
// seconds: a locked Keychain makes macOS ask for its password and `security`
// waits for the answer. Which keychain: the login Keychain, or the file named
// in DSHPROXY_KEYCHAIN (tests use a throwaway one).
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SECURITY = '/usr/bin/security';
const SERVICE = 'DSHProxy';
const ACCOUNT = 'key-wrapper';
const TIMEOUT_MS = 10 * 1000;
// A Keychain that could not be read is not asked again for this long, so one
// command waits for it once.
const FAILURE_KEEP_MS = 60 * 1000;
const PREFIX = 'kc1:';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const NOT_FOUND = 44;
const EXISTS = 45;

class KeychainError extends Error {
  constructor(message) {
    super(message);
    this.code = 'DSHPROXY_KEYCHAIN';
  }
}

function call(security, args, { input = null, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(security, args, { env: { HOME: process.env.HOME || '' }, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
    } catch (error) {
      resolve({ code: null, out: '', error: error.code || 'ESPAWN' });
      return;
    }
    let out = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone already */ }
      finish({ code: null, out: '', error: 'ETIMEDOUT' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (error) => finish({ code: null, out: '', error: error.code || 'ESPAWN' }));
    child.on('close', (code) => finish({ code, out, error: null }));
    if (input !== null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

function failure(result, timeoutMs) {
  if (result.error === 'ETIMEDOUT') return new KeychainError(`The macOS Keychain did not answer within ${Math.round(timeoutMs / 1000)} seconds; it is probably locked. Unlock it (log in again, or unlock it in Keychain Access) and try again. Nothing was saved.`);
  if (result.error) return new KeychainError(`${SECURITY} could not be started (${result.error}), so DSHProxy cannot reach the macOS Keychain. Nothing was saved.`);
  return new KeychainError(`The macOS Keychain did not give DSHProxy its key (security ended with code ${result.code}). Nothing was saved.`);
}

function insideTemporaryFolder(file) {
  const real = (dir) => {
    try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
  };
  const folders = [path.resolve(os.tmpdir()), real(os.tmpdir())];
  const targets = [path.resolve(file), path.join(real(path.dirname(path.resolve(file))), path.basename(file))];
  // Both spellings must agree, so a link inside the temporary folder that
  // points elsewhere does not pass.
  return targets.every((target) => folders.some((folder) => target.startsWith(folder + path.sep)));
}

function createKeywrap({ security = SECURITY, keychain, timeoutMs = TIMEOUT_MS, env = process.env, now = Date.now } = {}) {
  const chosen = keychain === undefined ? env.DSHPROXY_KEYCHAIN || null : keychain;
  if (chosen !== null && /["\\\n\r]/.test(chosen)) throw new KeychainError('DSHPROXY_KEYCHAIN names a file whose path DSHProxy cannot pass to the Keychain (it holds a quote, a backslash or a line break).');
  // What was read, for the life of this wrapper: one per process in use.
  let seen = null;
  const where = chosen ? [chosen] : [];

  // Under the test runner only a keychain file in the temporary folder is
  // used, so no test can reach a login Keychain, whatever it was given.
  const guard = () => {
    if (!env.NODE_TEST_CONTEXT) return;
    if (!chosen) throw new KeychainError('DSHProxy runs under the test runner without DSHPROXY_KEYCHAIN; it will not use a login Keychain.');
    if (!insideTemporaryFolder(chosen)) throw new KeychainError('DSHProxy runs under the test runner; it will not use a keychain outside the temporary folder.');
  };

  async function read() {
    const result = await call(security, ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', ...where], { timeoutMs });
    if (result.code === NOT_FOUND) return null;
    const hex = result.code === 0 ? result.out.trim() : '';
    if (!/^[0-9a-f]{64}$/.test(hex)) throw failure(result.code === 0 ? { code: 'with a value that is not a key', error: null } : result, timeoutMs);
    return Buffer.from(hex, 'hex');
  }

  async function write(key) {
    const line = `add-generic-password -s ${SERVICE} -a ${ACCOUNT} -w ${key.toString('hex')}${chosen ? ` "${chosen}"` : ''}\n`;
    const result = await call(security, ['-i'], { input: line, timeoutMs });
    if (result.code === 0) return true;
    if (result.code === EXISTS) return false;
    throw failure(result, timeoutMs);
  }

  // The wrapping key. With `create`, one is made when the Keychain has none;
  // without it, none is "cannot be read". Of several processes that find none
  // at the same moment, one write succeeds and every one uses what is stored.
  async function wrappingKey(create) {
    guard();
    if (seen?.key) return seen.key;
    if (seen?.error && now() - seen.at < FAILURE_KEEP_MS) throw seen.error;
    try {
      let key = await read();
      if (!key) {
        if (!create) throw new KeychainError('The key DSHProxy keeps in the macOS Keychain (DSHProxy, key-wrapper) is not there, so the saved keys cannot be unlocked on this account. Nothing was changed.');
        // false: another process stored one first; either way, use what is stored.
        await write(crypto.randomBytes(KEY_BYTES));
        key = await read();
        if (!key) throw new KeychainError('The macOS Keychain did not keep the key DSHProxy stored in it. Nothing was saved.');
      }
      seen = { key };
      return key;
    } catch (error) {
      if (error instanceof KeychainError && !/is not there/.test(error.message)) seen = { error, at: now() };
      throw error;
    }
  }

  async function wrap(bytes) {
    const key = await wrappingKey(true);
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return `${PREFIX}${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')}`;
  }

  // The bytes, or null when `text` was not wrapped with this account's key.
  // A Keychain that cannot be read is an error, never null.
  async function unwrap(text) {
    const value = String(text || '').trim();
    if (!value.startsWith(PREFIX)) return null;
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    if (raw.length < NONCE_BYTES + TAG_BYTES + 1) return null;
    const key = await wrappingKey(false);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE_BYTES));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
    } catch {
      return null;
    }
  }

  return { wrap, unwrap };
}

let shared = null;
function defaultKeywrap() {
  const keychain = process.env.DSHPROXY_KEYCHAIN || null;
  if (!shared || shared.keychain !== keychain) shared = { keychain, keywrap: createKeywrap({ keychain }) };
  return shared.keywrap;
}

module.exports = { createKeywrap, defaultKeywrap, KeychainError, SERVICE, ACCOUNT };
