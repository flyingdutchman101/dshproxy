'use strict';
require("./support/keychain"); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
// Changes to video-keys.json and video-settings.json from several commands at
// once: none may be lost, and none may be reported as saved when it was not.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// The default data folder of this process is a throwaway one that must stay
// empty, and the network throws. Windows is asked to protect a key only by
// the child processes further down, each in its own throwaway data folder.
const guard = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-concurrency-guard-'));
process.env.DSHPROXY_HOME = guard;
globalThis.fetch = () => { throw new Error('network is forbidden in this test'); };
after(() => {
  try {
    assert.deepEqual(fs.readdirSync(guard), []);
  } finally {
    fs.rmSync(guard, { recursive: true, force: true });
  }
});

const keys = require('../src/video/keys');
const settings = require('../src/video/settings');
const secrets = require('../src/secrets');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-concurrency-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const names = (home) => fs.readdirSync(home).sort();
const snapshot = (home) => names(home).map((name) => [name, fs.readFileSync(path.join(home, name), 'utf8')]);
function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { open, opened };
}

// Stands in for secrets.loadMasterKey with that function's contract; what it
// writes to master.key is a marker, not the key.
function masterKey() {
  const key = crypto.randomBytes(32);
  const calls = [];
  const load = async (file, { create = false } = {}) => {
    calls.push({ file, create });
    if (fs.existsSync(file)) return key;
    if (!create) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'synthetic-wrapped-master-key\n');
    return key;
  };
  return { key, calls, load };
}

// A lock file as another DSHProxy command leaves it while it works.
function placeLock(target, { pid = process.pid, at = Date.now() } = {}) {
  const text = `${JSON.stringify({ id: 'a1b2c3d4e5f6a7b8c9d0e1f2', pid, at })}\n`;
  fs.writeFileSync(`${target}.lock`, text);
  return text;
}
function deadPid() {
  return spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
}
// Time that passes only while a command waits.
function fakeClock() {
  const clock = { time: 1_700_000_000_000, sleeps: [], now: () => clock.time, sleep: async (ms) => { clock.sleeps.push(ms); clock.time += ms; } };
  return clock;
}
const total = (clock) => clock.sleeps.reduce((sum, ms) => sum + ms, 0);

const KEY = 'synthetic-VKEY-7c1e9a_not.a-real+key/1=';
const OTHER = 'synthetic-VKEY-second-0042';
const keysFile = (home) => path.join(home, 'video-keys.json');
const settingsFile = (home) => path.join(home, 'video-settings.json');
const busy = (target) => `Another DSHProxy command is changing ${target} and did not finish within 10 seconds, so nothing was saved.`;
const unconfirmed = (target) => `The change to ${target} could not be confirmed: reading the file back did not show it. Run the command again.`;
const wan = { models: { 'wan-3.0': { enabled: true, route: 'kovapi' } } };
const enabledModels = async (home) => Object.entries((await settings.read(home)).models).filter(([, entry]) => entry.enabled).map(([model, entry]) => `${model}=${entry.route}`);

// A data folder with one saved key and one enabled model, and the changes
// this file is about, each with the file it changes.
async function prepared(t) {
  const home = tempHome(t);
  const master = masterKey();
  const read = { env: {}, loadMasterKey: master.load };
  await keys.set(home, 'kovapi', OTHER, read);
  await settings.write(home, { models: { 'minimax-h3': { enabled: true, route: 'callirra' } } });
  const changes = [
    { name: 'saving a key', target: keysFile(home), run: (io, more = {}) => keys.set(home, 'callirra', KEY, { loadMasterKey: master.load, ...more, io }) },
    { name: 'replacing a key', target: keysFile(home), run: (io) => keys.set(home, 'kovapi', 'synthetic-VKEY-replacement', { loadMasterKey: master.load, io }) },
    { name: 'removing a key', target: keysFile(home), run: (io) => keys.remove(home, 'kovapi', { io }) },
    { name: 'changing a video setting', target: settingsFile(home), run: (io) => settings.write(home, wan, { io }) }
  ];
  return { home, master, read, changes };
}

// ------------------------------- another command is at work -------------------------------

test('while another command is changing the file, a change waits 10 seconds and then refuses with one sentence; nothing is changed', async (t) => {
  const { home, master, changes } = await prepared(t);
  for (const change of changes) {
    const clock = fakeClock();
    placeLock(change.target, { at: clock.now() });
    const before = snapshot(home);
    const unlocks = master.calls.length;
    let unlocksAtFirstWait = null;
    const sleep = async (ms) => {
      unlocksAtFirstWait ??= master.calls.length;
      await clock.sleep(ms);
    };
    await assert.rejects(change.run({ now: clock.now, sleep }), { message: busy(change.target) }, change.name);
    assert.equal(total(clock), 10000, change.name);
    assert.deepEqual(snapshot(home), before, change.name);
    // The master key was unlocked before the wait began, not after it.
    if (change.name === 'saving a key') assert.deepEqual([unlocksAtFirstWait, master.calls.length], [unlocks + 1, unlocks + 1]);
    fs.rmSync(`${change.target}.lock`);
  }
});

test('a change waits for the other command to finish and then builds on what that command saved', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const read = { env: {}, loadMasterKey: master.load };
  await keys.set(home, 'videorouter', 'synthetic-VKEY-first', read);

  // The other command: it holds the lock, saves its own change, lets go.
  const others = (target, text) => {
    const clock = fakeClock();
    placeLock(target, { at: clock.now() });
    let steps = 0;
    const sleep = async (ms) => {
      await clock.sleep(ms);
      steps += 1;
      if (steps === 2) {
        fs.writeFileSync(target, text);
        fs.rmSync(`${target}.lock`);
      }
    };
    return { now: clock.now, sleep };
  };

  const first = JSON.parse(fs.readFileSync(keysFile(home), 'utf8')).providers.videorouter;
  const theirKeys = JSON.stringify({ providers: { videorouter: first, kovapi: { keyEnc: secrets.encryptWithKey(master.key, OTHER) } } });
  assert.deepEqual(await keys.set(home, 'callirra', KEY, { loadMasterKey: master.load, io: others(keysFile(home), theirKeys) }), { provider: 'callirra', saved: true });
  assert.equal(await keys.resolve(home, 'videorouter', read), 'synthetic-VKEY-first');
  assert.equal(await keys.resolve(home, 'kovapi', read), OTHER);
  assert.equal(await keys.resolve(home, 'callirra', read), KEY);

  const theirSettings = JSON.stringify({ models: { 'seedance-2.0': { enabled: true, route: 'videorouter' } } });
  await settings.write(home, wan, { io: others(settingsFile(home), theirSettings) });
  assert.deepEqual(await enabledModels(home), ['seedance-2.0=videorouter', 'wan-3.0=kovapi']);
  assert.deepEqual(names(home), ['master.key', 'video-keys.json', 'video-settings.json']);
});

test('a lock left behind by a command that died is taken over at once, and no lock stays behind', async (t) => {
  const { home, read, changes } = await prepared(t);
  const gone = deadPid();
  for (const change of changes) {
    const clock = fakeClock();
    placeLock(change.target, { pid: gone, at: clock.now() });
    await change.run({ now: clock.now, sleep: clock.sleep });
    assert.deepEqual(clock.sleeps, [], change.name);
    assert.deepEqual(names(home), ['master.key', 'video-keys.json', 'video-settings.json'], change.name);
  }
  assert.equal(await keys.resolve(home, 'callirra', read), KEY);
  assert.deepEqual((await keys.list(home, read)).map((row) => row.saved), [false, false, true]);
  assert.deepEqual(await enabledModels(home), ['minimax-h3=callirra', 'wan-3.0=kovapi']);
});

// ------------------------------- what the lock covers -------------------------------

test('the master key is unlocked before the lock is taken, and a second change cannot read the file until the first has written it', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const read = { env: {}, loadMasterKey: master.load };
  const lock = `${keysFile(home)}.lock`;
  const seen = { order: [] };
  const slowUnlock = async (file, options) => {
    const key = await master.load(file, options);
    await new Promise((resolve) => setImmediate(resolve));
    seen.lockedDuringUnlock = fs.existsSync(lock);
    return key;
  };
  let second;
  const rename = (from, to) => {
    seen.lockedDuringWrite = fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid;
    // A second change begins while the first is in the middle of its write.
    second = keys.set(home, 'kovapi', OTHER, { loadMasterKey: master.load }).then(() => seen.order.push('second'));
    fs.renameSync(from, to);
  };
  await keys.set(home, 'callirra', KEY, { loadMasterKey: slowUnlock, io: { rename } }).then(() => seen.order.push('first'));
  await second;
  assert.deepEqual(seen, { order: ['first', 'second'], lockedDuringUnlock: false, lockedDuringWrite: true });
  assert.equal(await keys.resolve(home, 'callirra', read), KEY);
  assert.equal(await keys.resolve(home, 'kovapi', read), OTHER);
  assert.deepEqual(names(home), ['master.key', 'video-keys.json']);
});

test('the same holds for the video settings: the second change builds on the first', async (t) => {
  const home = tempHome(t);
  const lock = `${settingsFile(home)}.lock`;
  const seen = { order: [] };
  let second;
  const rename = (from, to) => {
    seen.lockedDuringWrite = fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid;
    second = settings.write(home, { models: { 'seedance-2.5': { enabled: true, route: 'kovapi' } } }).then((state) => { seen.order.push('second'); return state; });
    fs.renameSync(from, to);
  };
  await settings.write(home, wan, { io: { rename } }).then(() => seen.order.push('first'));
  const last = await second;
  assert.deepEqual(seen, { order: ['first', 'second'], lockedDuringWrite: true });
  assert.deepEqual(await enabledModels(home), ['seedance-2.5=kovapi', 'wan-3.0=kovapi']);
  assert.deepEqual(last, await settings.read(home));
  assert.deepEqual(names(home), ['video-settings.json']);
});

test('saved is answered only when a read after the write shows the change', async (t) => {
  const { home, changes } = await prepared(t);
  for (const change of changes) {
    const before = snapshot(home);
    const old = fs.readFileSync(change.target, 'utf8');
    let writes = 0;
    // The write goes through, and something puts the old content back.
    const rename = (from, to) => {
      writes += 1;
      fs.renameSync(from, to);
      fs.writeFileSync(to, old);
    };
    await assert.rejects(change.run({ rename }), { message: unconfirmed(change.target) }, change.name);
    assert.equal(writes, 1, change.name);
    assert.deepEqual(snapshot(home), before, change.name);
  }
});

test('a write that Windows refuses for a moment is tried again; one that stays refused is a refusal and nothing is changed', async (t) => {
  const { home, read, changes } = await prepared(t);
  const refusal = (code) => Object.assign(new Error(`${code}: operation not permitted, rename synthetic`), { code });
  for (const change of changes) {
    const before = snapshot(home);
    await assert.rejects(change.run({ rename: () => { throw refusal('EBUSY'); }, sleep: async () => {} }), { message: `${change.target} could not be replaced (EBUSY): another program may have it open. Nothing was saved.` }, change.name);
    assert.deepEqual(snapshot(home), before, change.name);
  }
  for (const change of changes) {
    let attempts = 0;
    const rename = (from, to) => {
      attempts += 1;
      if (attempts < 3) throw refusal('EPERM');
      fs.renameSync(from, to);
    };
    await change.run({ rename, sleep: async () => {} });
    assert.equal(attempts, 3, change.name);
  }
  assert.equal(await keys.resolve(home, 'callirra', read), KEY);
  assert.deepEqual((await keys.list(home, read)).map((row) => row.saved), [false, false, true]);
  assert.deepEqual(await enabledModels(home), ['minimax-h3=callirra', 'wan-3.0=kovapi']);
  assert.deepEqual(names(home), ['master.key', 'video-keys.json', 'video-settings.json']);
});

test('changes started together in one process, each with a slow master key, are all kept', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const read = { env: {}, loadMasterKey: master.load };
  // Every save is inside its unlock before any of them goes on.
  const all = gate();
  let unlocking = 0;
  const slow = async (file, options) => {
    const key = await master.load(file, options);
    unlocking += 1;
    if (unlocking === 3) all.open();
    await all.opened;
    return key;
  };
  const results = await Promise.all([
    keys.set(home, 'videorouter', 'synthetic-VKEY-a', { loadMasterKey: slow }),
    keys.set(home, 'kovapi', 'synthetic-VKEY-b', { loadMasterKey: slow }),
    keys.set(home, 'callirra', 'synthetic-VKEY-c', { loadMasterKey: slow }),
    settings.write(home, { models: { 'seedance-2.5': { enabled: true, route: 'kovapi' } } }),
    settings.write(home, { models: { 'seedance-2.0': { enabled: true, route: 'videorouter' } } }),
    settings.write(home, { models: { 'minimax-h3': { enabled: true, route: 'callirra' } } }),
    settings.write(home, wan)
  ]);
  assert.deepEqual(results.slice(0, 3), [{ provider: 'videorouter', saved: true }, { provider: 'kovapi', saved: true }, { provider: 'callirra', saved: true }]);
  assert.equal(await keys.resolve(home, 'videorouter', read), 'synthetic-VKEY-a');
  assert.equal(await keys.resolve(home, 'kovapi', read), 'synthetic-VKEY-b');
  assert.equal(await keys.resolve(home, 'callirra', read), 'synthetic-VKEY-c');
  assert.deepEqual(await enabledModels(home), ['seedance-2.5=kovapi', 'seedance-2.0=videorouter', 'minimax-h3=callirra', 'wan-3.0=kovapi']);
  assert.deepEqual(names(home), ['master.key', 'video-keys.json', 'video-settings.json']);
});

test('reading takes no lock: keys and settings are read while another command holds the lock', async (t) => {
  const { home, read } = await prepared(t);
  const before = [placeLock(keysFile(home)), placeLock(settingsFile(home))];
  assert.equal(await keys.resolve(home, 'kovapi', read), OTHER);
  assert.deepEqual((await keys.list(home, read)).map((row) => row.readable), [false, true, false]);
  assert.deepEqual(await enabledModels(home), ['minimax-h3=callirra']);
  assert.deepEqual(await settings.offered(home), [{ model: 'minimax-h3', route: 'callirra' }]);
  // Removing a key that is not saved changes nothing and waits for nobody.
  assert.deepEqual(await keys.remove(home, 'callirra'), { provider: 'callirra', saved: false, removed: false });
  assert.deepEqual([fs.readFileSync(`${keysFile(home)}.lock`, 'utf8'), fs.readFileSync(`${settingsFile(home)}.lock`, 'utf8')], before);
});

// ------------------------------- several processes -------------------------------

// The installed program in its own process, with a throwaway data folder. The
// real master key is used here: Windows protects a key made for this folder.
function cli(home, args, input = '') {
  assert.equal(path.dirname(home), os.tmpdir());
  const env = { ...process.env, DSHPROXY_HOME: home, DSH_HOME: path.join(home, 'no-deepseek-harness') };
  for (const name of ['VIDEOROUTER_API_KEY', 'KOVAPI_API_KEY', 'CALLIRRA_API_KEY']) delete env[name];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'dshproxy.js'), 'video', ...args], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}
const PROVIDER_KEYS = { videorouter: 'synthetic-VKEY-router-11', kovapi: 'synthetic-VKEY-kov-22', callirra: 'synthetic-VKEY-call-33' };
const setAll = (home) => Promise.all(Object.entries(PROVIDER_KEYS).map(([provider, key]) => cli(home, ['key', 'set', provider], `${key}\n`)));

// Every command answered saved, and every key can be read back: by the
// program, and here with the master key that is in the folder.
async function assertAllKeysSaved(home, results) {
  assert.deepEqual(results.map((result) => [result.status, result.stderr, JSON.parse(result.stdout || 'null')]), Object.keys(PROVIDER_KEYS).map((provider) => [0, '', { provider, saved: true }]));
  assert.deepEqual(names(home), ['master.key', 'video-keys.json']);
  assert.equal(fs.statSync(path.join(home, 'master.key')).nlink, 1);
  const master = await secrets.loadMasterKey(path.join(home, 'master.key'));
  const saved = JSON.parse(fs.readFileSync(keysFile(home), 'utf8')).providers;
  assert.deepEqual(Object.fromEntries(Object.keys(PROVIDER_KEYS).map((provider) => [provider, saved[provider] ? secrets.decryptWithKey(master, saved[provider].keyEnc) : 'not saved'])), PROVIDER_KEYS);
  const listed = await cli(home, ['key', 'list']);
  assert.deepEqual(JSON.parse(listed.stdout).providers.map((row) => [row.provider, row.saved, row.readable]), [['videorouter', true, true], ['kovapi', true, true], ['callirra', true, true]]);
  for (const name of names(home)) for (const key of Object.values(PROVIDER_KEYS)) assert.equal(fs.readFileSync(path.join(home, name)).includes(key), false);
}

test('three keys saved at the same moment in a fresh data folder are all kept under one master key', async (t) => {
  const home = tempHome(t);
  await assertAllKeysSaved(home, await setAll(home));
});

test('three keys saved at the same moment, with the master key already there, are all kept', async (t) => {
  const home = tempHome(t);
  const first = await cli(home, ['key', 'set', 'kovapi'], 'synthetic-VKEY-replaced-00\n');
  assert.equal(first.status, 0, first.stderr);
  const masterFile = fs.readFileSync(path.join(home, 'master.key'), 'utf8');
  await assertAllKeysSaved(home, await setAll(home));
  assert.equal(fs.readFileSync(path.join(home, 'master.key'), 'utf8'), masterFile);
});

test('four video settings changed at the same moment are all kept', async (t) => {
  const home = tempHome(t);
  const wanted = [['seedance-2.5', 'kovapi'], ['seedance-2.0', 'videorouter'], ['minimax-h3', 'callirra'], ['wan-3.0', 'videorouter-replicate']];
  const results = await Promise.all(wanted.map(([model, route]) => cli(home, ['settings', 'set', model, route, 'enabled'])));
  for (const [index, result] of results.entries()) {
    assert.deepEqual([result.status, result.stderr], [0, ''], wanted[index][0]);
    // Each command prints the state it saved, with its own change in it.
    const own = JSON.parse(result.stdout).models.find((row) => row.model === wanted[index][0]);
    assert.deepEqual([own.enabled, own.route], [true, wanted[index][1]]);
  }
  const read = await cli(home, ['settings']);
  assert.deepEqual(JSON.parse(read.stdout).models.map((row) => [row.model, row.route, row.enabled]), [...wanted.map(([model, route]) => [model, route, true]), ['flux-3', null, false]]);
  assert.deepEqual(names(home), ['video-settings.json']);
});

test('the command line refuses after 10 seconds while another command holds the lock: one sentence, exit code 1, nothing printed, nothing changed', async (t) => {
  const home = tempHome(t);
  fs.writeFileSync(keysFile(home), JSON.stringify({ providers: { kovapi: { keyEnc: secrets.encryptWithKey(crypto.randomBytes(32), OTHER) } } }));
  fs.writeFileSync(settingsFile(home), JSON.stringify({ models: { 'minimax-h3': { enabled: true, route: 'callirra' } } }));
  placeLock(keysFile(home));
  placeLock(settingsFile(home));
  const before = snapshot(home);
  const started = Date.now();
  const [removed, changed] = await Promise.all([cli(home, ['key', 'remove', 'kovapi']), cli(home, ['settings', 'set', 'wan-3.0', 'kovapi', 'enabled'])]);
  assert.ok(Date.now() - started >= 10000, 'the commands did not wait');
  assert.deepEqual([removed.status, removed.stdout, removed.stderr], [1, '', `DSHProxy: ${busy(keysFile(home))}\n`]);
  assert.deepEqual([changed.status, changed.stdout, changed.stderr], [1, '', `DSHProxy: ${busy(settingsFile(home))}\n`]);
  assert.deepEqual(snapshot(home), before);
});
