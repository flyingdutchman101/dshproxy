'use strict';
// The Krea sign-in store as it really is on Windows (a file encrypted for the
// current user, and the lock beside it), used by separate processes at the
// same moment. Each test has its own throwaway LOCALAPPDATA. The network is
// fake and every token is invented.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const modulePath = path.resolve(__dirname, '../src/krea-helper/oauth.js');
const resource = 'https://api.krea.ai/mcp';
const NOW = 1000000;
// Windows data protection is reached through PowerShell, which takes a second
// here and more than the helper's ten seconds on a cold build machine. These
// tests are about the file and its lock between processes, so the file's key
// is wrapped by this stand-in instead; everything else is the real store.
const protect = async (mode, bytes) => Buffer.from(bytes).map((byte) => byte ^ 0x5a);
const ended = { resource, accessToken: 'invented-old-access', refreshToken: 'invented-old-refresh', clientId: 'invented-client', tokenEndpoint: 'https://api.krea.ai/token', expiresAt: NOW - 1000 };

if (process.argv[2] === 'worker') {
  // A helper in its own process. It says what it does and waits to be told to go on.
  const { access, login, windowsStore } = require(modulePath);
  const told = () => new Promise((resolve) => process.once('message', resolve));
  const jobs = {
    // Renews; the fake token endpoint answers when the test says so.
    renew: () => access(windowsStore({ protect }), () => NOW, { fetchImpl: async (url, options) => {
      process.send(`fetch ${new URLSearchParams(options.body).get('refresh_token')}`);
      await told();
      return Response.json({ access_token: 'invented-new-access', refresh_token: 'invented-new-refresh', token_type: 'Bearer', expires_in: 3600 });
    } }).then((token) => process.send(`token ${token}`)),
    logout: () => windowsStore({ protect }).clear(),
    // A sign-in that waits at the consent page until the test says so.
    login: () => {
      const issuer = 'https://api.krea.ai';
      const redirect = 'http://127.0.0.1:12345/callback';
      const replies = [{ resource, authorization_servers: [issuer] }, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, code_challenge_methods_supported: ['S256'], response_types_supported: ['code'] }, { client_id: 'invented-client', token_endpoint_auth_method: 'none', redirect_uris: [redirect] }, { access_token: 'invented-login-access', token_type: 'Bearer', expires_in: 3600 }];
      let count = 0;
      return login({ store: windowsStore({ protect }), now: () => NOW, fetchImpl: async () => Response.json(replies[count++]), showUrl: () => {}, openCallback: async (state) => ({ redirectUri: redirect, wait: async () => { process.send('consent'); await told(); return { state, code: 'invented-code' }; }, close() {} }) });
    }
  };
  process.send('started');
  jobs[process.argv[3]]().then(() => { process.send('done'); process.disconnect(); }, (error) => { process.send(`failed ${error && error.message}`); process.disconnect(); });
} else {
  // A throwaway LOCALAPPDATA for one test, with the helpers started in it.
  async function world(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-renewal-'));
    const original = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = dir;
    const children = [];
    t.after(async () => {
      for (const child of children) if (child.exitCode === null) child.kill();
      if (original === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = original;
      await fs.rm(dir, { recursive: true, force: true });
    });
    const oauth = require(modulePath);
    const start = (job) => {
      const child = fork(__filename, ['worker', job], { env: { ...process.env, LOCALAPPDATA: dir }, silent: true });
      child.messages = [];
      child.on('message', (message) => child.messages.push(message));
      children.push(child);
      return child;
    };
    // Resolves with the first message that starts with `want`; rejects when the helper fails first.
    const heard = (child, want) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "${want}" from the helper; it said: ${child.messages.join(', ')}`)), 30000);
      const look = () => {
        const found = child.messages.find((message) => message.startsWith(want));
        const failed = child.messages.find((message) => message.startsWith('failed'));
        if (!found && !failed) return;
        clearTimeout(timer);
        child.off('message', look);
        if (found) resolve(found); else reject(new Error(`the helper ${failed}`));
      };
      child.on('message', look);
      look();
    });
    return { dir, oauth, store: oauth.windowsStore({ protect }), start, heard, folder: path.join(dir, 'DSHProxy', 'KreaOAuth') };
  }

  test('the real store renews a sign-in whose hour has ended, and what it stored can be read back', { skip: process.platform === "darwin" ? "macOS: video comes with stage B of 0014 (docs/work/0014-macos-port); until then test/not-yet-darwin.test.js" : false }, async (t) => {
    const w = await world(t);
    await w.store.save(ended);
    const sent = [];
    const token = await w.oauth.access(w.store, () => NOW, { fetchImpl: async (url, options) => { sent.push(new URLSearchParams(options.body).get('refresh_token')); return Response.json({ access_token: 'invented-new-access', refresh_token: 'invented-new-refresh', token_type: 'Bearer', expires_in: 3600 }); } });
    assert.equal(token, 'invented-new-access');
    assert.deepEqual(sent, ['invented-old-refresh']);
    assert.deepEqual(await w.store.load(), { ...ended, accessToken: 'invented-new-access', refreshToken: 'invented-new-refresh', expiresAt: NOW + 3600000 });
    assert.deepEqual(await w.oauth.status(w.store, () => NOW), { signedIn: true, expiresAt: NOW + 3600000, canRenew: true });
    // Nothing is left beside the sign-in: no lock, no half-written file.
    assert.deepEqual(await fs.readdir(w.folder), ['session.v1']);
    // The file holds no token in the clear.
    assert.ok(!(await fs.readFile(path.join(w.folder, 'session.v1'), 'utf8')).includes('invented-'));
  });

  test('two helpers at the same moment: one renews, the other waits and uses what the first stored', { skip: process.platform === "darwin" ? "macOS: video comes with stage B of 0014 (docs/work/0014-macos-port); until then test/not-yet-darwin.test.js" : false }, async (t) => {
    const w = await world(t);
    await w.store.save(ended);
    const first = w.start('renew');
    await w.heard(first, 'fetch');
    const second = w.start('renew');
    await w.heard(second, 'started');
    // Long enough for the second to have asked Krea, had nothing stopped it.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.deepEqual(second.messages.filter((message) => message.startsWith('fetch')), [], 'the second waits for the first');
    first.send('go');
    assert.equal(await w.heard(first, 'token'), 'token invented-new-access');
    assert.equal(await w.heard(second, 'token'), 'token invented-new-access');
    await Promise.all([w.heard(first, 'done'), w.heard(second, 'done')]);
    assert.deepEqual(second.messages.filter((message) => message.startsWith('fetch')), [], 'one renewal between the two');
    assert.equal((await w.store.load()).refreshToken, 'invented-new-refresh');
  });

  test('a helper that dies in the middle of a renewal holds nothing up: the next call renews at once, with nobody clearing anything by hand', { skip: process.platform === "darwin" ? "macOS: video comes with stage B of 0014 (docs/work/0014-macos-port); until then test/not-yet-darwin.test.js" : false }, async (t) => {
    const w = await world(t);
    await w.store.save(ended);
    const doomed = w.start('renew');
    await w.heard(doomed, 'fetch');
    const gone = new Promise((resolve) => doomed.once('exit', resolve));
    doomed.kill();
    await gone;
    assert.ok((await fs.readdir(w.folder)).includes('session.v1.lock'), 'the dead helper left its lock');
    assert.deepEqual(await w.store.load(), ended, 'and the sign-in as it was');

    const next = w.start('renew');
    const began = Date.now();
    assert.equal(await w.heard(next, 'fetch'), 'fetch invented-old-refresh');
    assert.ok(Date.now() - began < 15000, `the next helper waited ${Date.now() - began} ms for a lock nobody holds`);
    next.send('go');
    assert.equal(await w.heard(next, 'token'), 'token invented-new-access');
    await w.heard(next, 'done');
    assert.deepEqual(await fs.readdir(w.folder), ['session.v1']);
  });

  test('the lock of a helper that is alive is left alone for two minutes, longer than any renewal takes', { skip: process.platform === "darwin" ? "macOS: video comes with stage B of 0014 (docs/work/0014-macos-port); until then test/not-yet-darwin.test.js" : false }, async (t) => {
    const w = await world(t);
    await w.store.save(ended);
    const lock = path.join(w.folder, 'session.v1.lock');
    const held = (age) => fs.writeFile(lock, `${JSON.stringify({ id: 'a'.repeat(24), pid: process.pid, at: Date.now() - age })}\n`);
    const impatient = w.oauth.windowsStore({ lockWaitMs: 300, protect });
    let asked = 0;
    const fetchImpl = async () => { asked += 1; return Response.json({ access_token: 'invented-new-access', refresh_token: 'invented-new-refresh', token_type: 'Bearer', expires_in: 3600 }); };

    // Held for 40 seconds by a process that is running: this helper waits, gives up, and asks nobody.
    await held(40000);
    await assert.rejects(w.oauth.access(impatient, () => NOW, { fetchImpl }), /^Error: KREA_REFUSED$/);
    assert.equal(asked, 0);
    assert.deepEqual(await w.store.load(), ended);

    // Held for more than two minutes: nobody renews that long. Taken over.
    await held(121000);
    assert.equal(await w.oauth.access(impatient, () => NOW, { fetchImpl }), 'invented-new-access');
    assert.equal(asked, 1);
  });

  test('a sign-out during a renewal waits for it and then removes the sign-in', { skip: process.platform === "darwin" ? "macOS: video comes with stage B of 0014 (docs/work/0014-macos-port); until then test/not-yet-darwin.test.js" : false }, async (t) => {
    const w = await world(t);
    await w.store.save(ended);
    const renewing = w.start('renew');
    await w.heard(renewing, 'fetch');
    const logout = w.start('logout');
    await w.heard(logout, 'started');
    renewing.send('go');
    await Promise.all([w.heard(renewing, 'done'), w.heard(logout, 'done')]);
    await assert.rejects(w.store.load(), (error) => error.code === 'ENOENT');
  });

  test('a sign-in waiting at the consent page holds nothing up: calls with the present sign-in go on', { skip: process.platform === "darwin" ? "macOS: video comes with stage B of 0014 (docs/work/0014-macos-port); until then test/not-yet-darwin.test.js" : false }, async (t) => {
    const w = await world(t);
    const good = { ...ended, expiresAt: NOW + 3000000 };
    await w.store.save(good);
    const signingIn = w.start('login');
    await w.heard(signingIn, 'consent');
    const began = Date.now();
    assert.equal(await w.oauth.access(w.store, () => NOW, { fetchImpl: async () => { throw new Error('nobody is asked'); } }), 'invented-old-access');
    // The store itself is free too: something can be saved while the consent page is open.
    await w.store.save(good);
    assert.ok(Date.now() - began < 15000);
    signingIn.send('go');
    await w.heard(signingIn, 'done');
    assert.equal((await w.store.load()).accessToken, 'invented-login-access');
  });
}
