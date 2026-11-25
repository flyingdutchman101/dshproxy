'use strict';
// The master key on macOS, wrapped through the Keychain (spec 0014, design 1;
// criteria C7, C8, C9). Two kinds of test:
//
//  - with a stand-in for /usr/bin/security that records what it was given and
//    plays the Keychain's answers (no key yet, already there, no answer);
//  - with the real /usr/bin/security and throwaway keychain files.
//
// No test here reads, writes or deletes anything in a login Keychain. A test
// that locks a real keychain makes macOS put a password dialog on the screen,
// so it runs only on CI or when DSHPROXY_TEST_LOCKED_KEYCHAIN=1.
const { keychain: testKeychain, makeKeychain, SECURITY } = require('./support/keychain');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const secrets = require('../src/secrets');

const onMac = process.platform === 'darwin';
const macOnly = onMac ? {} : { skip: 'macOS key wrapper; Windows uses DPAPI, tested by the master key tests in test/backend.test.js' };
const lockedAllowed = process.env.GITHUB_ACTIONS === 'true' || process.env.DSHPROXY_TEST_LOCKED_KEYCHAIN === '1';
const lockedOnly = !onMac ? macOnly : lockedAllowed ? {} : { skip: 'locks a real keychain, which puts a password dialog on the screen: runs on CI or with DSHPROXY_TEST_LOCKED_KEYCHAIN=1; the same behaviour is tested with a stand-in that does not answer' };
const CLI = path.join(__dirname, '..', 'bin', 'dshproxy.js');

function tempDir(t, name = 'dshproxy-keywrap-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const keywrapFor = (options) => require('../src/keywrap-darwin').createKeywrap(options);

// ------------------------------- the stand-in -------------------------------

const STAND_IN = String.raw`
const fs = require('fs');
const path = require('path');
const stateFile = path.join(__dirname, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
let input = '';
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
function handle(argv) {
  const opt = (flag) => { const at = argv.indexOf(flag); return at < 0 ? null : argv[at + 1]; };
  const item = opt('-s') + '|' + opt('-a');
  if (argv[0] === 'find-generic-password') {
    if (state.items[item] === undefined) return 44;
    process.stdout.write(state.items[item] + '\n');
    return 0;
  }
  if (argv[0] === 'add-generic-password') {
    if (state.raceValue && state.items[item] === undefined) { state.items[item] = state.raceValue; save(); return 45; }
    if (state.items[item] !== undefined) return 45;
    state.items[item] = opt('-w');
    save();
    return 0;
  }
  return 1;
}
function finish() {
  fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ args, env: process.env, input }) + '\n');
  if (state.mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (state.mode === 'exit') process.exit(state.code);
  if (args[0] === '-i') process.exit(handle(input.trim().match(/"[^"]*"|\S+/g).map((part) => part.replace(/^"|"$/g, ''))));
  process.exit(handle(args));
}
if (args[0] === '-i') { process.stdin.on('data', (chunk) => { input += chunk; }); process.stdin.on('end', finish); } else finish();
`;

// A program that stands in for /usr/bin/security. `state` sets its answers.
function standIn(t, state = {}) {
  const dir = tempDir(t, 'dshproxy-security-');
  fs.writeFileSync(path.join(dir, 'stand-in.js'), STAND_IN);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ items: {}, ...state }));
  const program = path.join(dir, 'security');
  fs.writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'stand-in.js')}" "$@"\n`, { mode: 0o700 });
  return {
    program,
    calls: () => (fs.existsSync(path.join(dir, 'calls.jsonl')) ? fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []),
    items: () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).items
  };
}

const ITEM = 'DSHProxy|key-wrapper';
const FAKE = (name) => path.join(os.tmpdir(), 'dshproxy-standin', `${name}.keychain-db`);
const env = { DSHPROXY_KEYCHAIN: FAKE('env') };

// ------------------------------- with the stand-in -------------------------------

test('a first key makes one wrapping key in the Keychain, sent on standard input only, and the master key never leaves this process', macOnly, async (t) => {
  const fake = standIn(t);
  const file = path.join(tempDir(t), 'master.key');
  process.env.DSHPROXY_TEST_SENTINEL = 'parent-environment-must-not-reach-security';
  t.after(() => delete process.env.DSHPROXY_TEST_SENTINEL);
  const keywrap = keywrapFor({ security: fake.program, keychain: FAKE('some keychain'), env });

  const master = await secrets.loadMasterKey(file, { create: true, keywrap });
  assert.equal(master.length, 32);
  const wrapping = fake.items()[ITEM];
  assert.match(wrapping, /^[0-9a-f]{64}$/);

  const calls = fake.calls();
  assert.deepEqual(calls.map((one) => one.args[0]), ['find-generic-password', '-i', 'find-generic-password']);
  assert.deepEqual(calls[1].args, ['-i']);
  assert.equal(calls[1].input, `add-generic-password -s DSHProxy -a key-wrapper -w ${wrapping} "${FAKE('some keychain')}"\n`);
  for (const one of calls) {
    assert.ok(!one.args.join(' ').includes(wrapping), 'the wrapping key is in an argument list');
    assert.equal(one.env.HOME, process.env.HOME);
    assert.equal(one.env.DSHPROXY_TEST_SENTINEL, undefined, 'the parent environment reached security');
    assert.ok(!JSON.stringify(one.env).includes(wrapping), 'the wrapping key is in the environment');
    const text = JSON.stringify(one);
    assert.ok(!text.includes(master.toString('hex')) && !text.includes(master.toString('base64')), 'the master key reached security');
  }
  assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'DSHProxy', '-a', 'key-wrapper', '-w', FAKE('some keychain')]);

  // The file holds the master key wrapped, not in the clear.
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(master.toString('base64')) && !text.includes(master.toString('hex')));
  // A new wrapper remembers nothing, as in a new process, and gets the same key.
  const again = await secrets.loadMasterKey(file, { keywrap: keywrapFor({ security: fake.program, keychain: FAKE('some keychain'), env }) });
  assert.ok(again.equals(master));
});

test('a wrapping key stored by another process first is the one used', macOnly, async (t) => {
  const theirs = crypto.randomBytes(32).toString('hex');
  const fake = standIn(t, { raceValue: theirs });
  const file = path.join(tempDir(t), 'master.key');
  const master = await secrets.loadMasterKey(file, { create: true, keywrap: keywrapFor({ security: fake.program, keychain: FAKE('a'), env }) });
  assert.equal(fake.items()[ITEM], theirs);
  assert.deepEqual(fake.calls().map((one) => one.args[0]), ['find-generic-password', '-i', 'find-generic-password']);
  const other = await secrets.loadMasterKey(file, { keywrap: keywrapFor({ security: fake.program, keychain: FAKE('a'), env }) });
  assert.ok(other.equals(master));
});

test('an existing master.key whose wrapping key is not in the Keychain cannot be read, and no wrapping key is made', macOnly, async (t) => {
  const first = standIn(t);
  const file = path.join(tempDir(t), 'master.key');
  await secrets.loadMasterKey(file, { create: true, keywrap: keywrapFor({ security: first.program, keychain: FAKE('b'), env }) });
  const before = fs.readFileSync(file);

  const empty = standIn(t);
  await assert.rejects(secrets.loadMasterKey(file, { create: true, keywrap: keywrapFor({ security: empty.program, keychain: FAKE('b'), env }) }), /not there/);
  assert.deepEqual(empty.items(), {});
  assert.deepEqual(empty.calls().map((one) => one.args[0]), ['find-generic-password']);
  assert.ok(fs.readFileSync(file).equals(before));
});

for (const [name, state, message] of [
  ['does not answer', { mode: 'hang' }, /did not answer within 1 seconds/],
  ['refuses with another code', { mode: 'exit', code: 51 }, /ended with code 51/]
]) {
  test(`a Keychain that ${name} saves nothing, makes nothing and says so in one sentence`, macOnly, async (t) => {
    const fake = standIn(t, state);
    const dir = tempDir(t);
    const file = path.join(dir, 'master.key');
    const started = Date.now();
    await assert.rejects(secrets.loadMasterKey(file, { create: true, keywrap: keywrapFor({ security: fake.program, keychain: FAKE('c'), env, timeoutMs: 1000 }) }), (error) => {
      assert.match(error.message, message);
      assert.match(error.message, /Nothing was saved\.$/);
      assert.equal(error.message.split('. ').length <= 3, true);
      return true;
    });
    assert.ok(Date.now() - started < 3000, 'the call was not ended in time');
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.deepEqual(fake.calls().map((one) => one.args[0]), ['find-generic-password']);
  });
}

test('with no security program, nothing is saved and the sentence says why', macOnly, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'master.key');
  await assert.rejects(secrets.loadMasterKey(file, { create: true, keywrap: keywrapFor({ security: path.join(dir, 'no-such-security'), keychain: FAKE('d'), env }) }), /could not be started \(ENOENT\)/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a Keychain that could not be read is not asked again for a minute, so a command waits once', macOnly, async (t) => {
  const fake = standIn(t, { mode: 'hang' });
  let clock = 1000;
  // The stand-in must have time to start on a loaded machine before its silence
  // counts: what is checked is the cache below, not how fast a program starts.
  const keywrap = keywrapFor({ security: fake.program, keychain: FAKE('e'), env, timeoutMs: 5000, now: () => clock });
  const file = path.join(tempDir(t), 'master.key');
  await assert.rejects(secrets.loadMasterKey(file, { create: true, keywrap }), /did not answer/);
  const started = Date.now();
  await assert.rejects(secrets.loadMasterKey(file, { create: true, keywrap }), /did not answer/);
  assert.ok(Date.now() - started < 300);
  assert.equal(fake.calls().length, 1);
  clock += 61 * 1000;
  await assert.rejects(secrets.loadMasterKey(file, { create: true, keywrap }), /did not answer/);
  assert.equal(fake.calls().length, 2);
});

test('under the test runner a wrapper whose keychain is outside the temporary folder refuses and starts nothing', macOnly, async (t) => {
  const fake = standIn(t);
  const file = path.join(tempDir(t), 'master.key');
  const login = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
  await assert.rejects(secrets.loadMasterKey(file, { create: true, keywrap: keywrapFor({ security: fake.program, keychain: login, env: { NODE_TEST_CONTEXT: 'child-v8' } }) }), /will not use a keychain outside the temporary folder/);
  assert.deepEqual(fake.calls(), []);
});

test('a keychain named by whoever started the tests is never used: each test process makes its own', macOnly, () => {
  const inherited = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
  const script = `require(${JSON.stringify(path.join(__dirname, 'support', 'keychain.js'))}); process.stdout.write(process.env.DSHPROXY_KEYCHAIN)`;
  const child = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, DSHPROXY_KEYCHAIN: inherited }, encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
  assert.notEqual(child.stdout, inherited);
  assert.ok(child.stdout.startsWith(os.tmpdir()) || fs.realpathSync(path.dirname(path.dirname(child.stdout))) === fs.realpathSync(os.tmpdir()), child.stdout);
  // It was deleted when that process ended.
  assert.equal(fs.existsSync(child.stdout), false);
});

test('under the test runner a wrapper with no keychain named refuses and starts nothing', macOnly, async (t) => {
  const fake = standIn(t);
  const file = path.join(tempDir(t), 'master.key');
  await assert.rejects(secrets.loadMasterKey(file, { create: true, keywrap: keywrapFor({ security: fake.program, keychain: null, env: { NODE_TEST_CONTEXT: 'child-v8' } }) }), /will not use a login Keychain/);
  assert.deepEqual(fake.calls(), []);
  assert.equal(fs.existsSync(file), false);
});

// ------------------------------- with the real program -------------------------------

test('this test process and its children use a throwaway keychain, never a login Keychain', macOnly, () => {
  assert.ok(testKeychain, 'no throwaway keychain was made');
  assert.ok(fs.realpathSync(testKeychain).startsWith(fs.realpathSync(os.tmpdir()) + path.sep), testKeychain);
  assert.equal(process.env.DSHPROXY_KEYCHAIN, testKeychain);
  assert.ok(fs.existsSync(testKeychain));
});

test('with the real Keychain program: a key is wrapped, and a new process reads the same master key', macOnly, async (t) => {
  const made = makeKeychain('roundtrip');
  t.after(made.remove);
  const file = path.join(tempDir(t), 'master.key');
  const master = await secrets.loadMasterKey(file, { create: true, keywrap: keywrapFor({ keychain: made.file }) });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(master.toString('base64')) && !text.includes(master.toString('hex')));
  const script = `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'secrets.js'))}).loadMasterKey(${JSON.stringify(file)}).then((key) => process.stdout.write(key.toString('hex')), (error) => { process.stderr.write(error.message); process.exit(1); })`;
  const child = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, DSHPROXY_KEYCHAIN: made.file }, encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, master.toString('hex'));
});

test('with the real Keychain program: four processes that all find no key end with one wrapping key', macOnly, async (t) => {
  const made = makeKeychain('race');
  t.after(made.remove);
  const dir = tempDir(t);
  const secretsFile = path.join(__dirname, '..', 'src', 'secrets.js');
  const startAt = Date.now() + 800;
  const files = [1, 2, 3, 4].map((n) => path.join(dir, `master-${n}.key`));
  const runs = files.map((file) => new Promise((resolve) => {
    const script = `setTimeout(() => require(${JSON.stringify(secretsFile)}).loadMasterKey(${JSON.stringify(file)}, { create: true }).then(() => process.exit(0), (error) => { process.stderr.write(error.message); process.exit(1); }), ${startAt} - Date.now())`;
    const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, DSHPROXY_KEYCHAIN: made.file }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  }));
  for (const result of await Promise.all(runs)) assert.equal(result.code, 0, result.stderr);
  // One new process unwraps all four: they were wrapped with one key.
  const keywrap = keywrapFor({ keychain: made.file });
  for (const file of files) assert.equal((await secrets.loadMasterKey(file, { keywrap })).length, 32);
});

test('with the real Keychain program: what it is given holds no key in its arguments or environment', macOnly, async (t) => {
  const made = makeKeychain('watched');
  t.after(made.remove);
  const dir = tempDir(t);
  // Records what the real program is started with, then becomes it.
  const shim = path.join(dir, 'security');
  fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/args.txt"\nenv >> "${dir}/env.txt"\nexec ${SECURITY} "$@"\n`, { mode: 0o700 });
  const file = path.join(dir, 'master.key');
  const master = await secrets.loadMasterKey(file, { create: true, keywrap: keywrapFor({ security: shim, keychain: made.file }) });
  const wrapping = spawnSync(SECURITY, ['find-generic-password', '-s', 'DSHProxy', '-a', 'key-wrapper', '-w', made.file], { encoding: 'utf8' }).stdout.trim();
  assert.match(wrapping, /^[0-9a-f]{64}$/);
  const seen = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8') + fs.readFileSync(path.join(dir, 'env.txt'), 'utf8');
  assert.match(seen, /^-i$/m);
  for (const secret of [wrapping, master.toString('hex'), master.toString('base64')]) assert.ok(!seen.includes(secret));
});

test('with the real Keychain program: the CLI saves an API key that a new process reads, and no file holds it', macOnly, (t) => {
  const made = makeKeychain('cli');
  t.after(made.remove);
  const home = tempDir(t, 'dshproxy-cli-');
  const key = 'sk-test-keychain-cli-must-not-leak-0123456789';
  const run = (args, input = '') => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', timeout: 30000, env: { ...process.env, DSHPROXY_HOME: home, DSH_HOME: path.join(home, 'no-harness'), DSHPROXY_KEYCHAIN: made.file } });
  const set = run(['key', 'set', 'deepseek'], `${key}\n`);
  assert.equal(set.status, 0, set.stderr);
  const list = run(['key', 'list']);
  assert.match(list.stdout, /^deepseek: DeepSeek - saved/m);
  for (const name of ['master.key', 'settings.json']) assert.ok(!fs.readFileSync(path.join(home, name), 'utf8').includes(key), name);
  assert.ok(!`${set.stdout}${set.stderr}${list.stdout}${list.stderr}`.includes(key));
});

// ------------------------------- a locked keychain -------------------------------

function folderState(dir) {
  const state = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else state[path.relative(dir, full)] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(dir);
  return state;
}

// Every command that saves a key ends in one sentence, non-zero, within 15
// seconds, and the data folder is byte for byte what it was. Every command
// that only reads keys goes on as on Windows with the key counted unreadable,
// within 15 seconds, and leaves the keys, master.key and the keychain as they
// were; `start` writes its configuration and log as it always does (C9).
test('with a locked keychain: commands that save a key refuse in one sentence, commands that read go on, all within 15 seconds, and no key changes', lockedOnly, async (t) => {
  const made = makeKeychain('locked');
  t.after(made.remove);
  const home = tempDir(t, 'dshproxy-cli-');
  const run = (args, input = '') => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', timeout: 30000, env: { ...process.env, DSHPROXY_HOME: home, DSH_HOME: path.join(home, 'no-harness'), DSHPROXY_KEYCHAIN: made.file } });
  const timed = (what, work) => {
    const started = Date.now();
    const result = work();
    assert.ok(Date.now() - started < 15000, `${what} took ${Date.now() - started} ms`);
    return result;
  };
  // Keys saved while it was unlocked.
  assert.equal(run(['key', 'set', 'deepseek'], 'sk-test-locked-0123456789\n').status, 0);
  assert.equal(run(['video', 'key', 'set', 'kovapi'], 'synthetic-locked-video-0123456789\n').status, 0);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')), port: 65431, backendPort: 65432 }));
  spawnSync(SECURITY, ['lock-keychain', made.file]);
  const before = { data: folderState(home), keychain: fs.readFileSync(made.file).toString('base64') };
  const keyFiles = ['master.key', 'settings.json', 'video-keys.json'];
  const keysBefore = Object.fromEntries(keyFiles.map((name) => [name, before.data[name]]));

  for (const [args, input] of [
    [['key', 'set', 'mistral'], 'sk-test-locked-other-0123456789\n'],
    [['key', 'custom', 'add', 'litellm', 'http://127.0.0.1:4000/v1', 'm1'], 'sk-test-locked-custom-0123456789\n'],
    [['video', 'key', 'set', 'callirra'], 'synthetic-locked-callirra-0123456789\n']
  ]) {
    const result = timed(args.join(' '), () => run(args, input));
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr);
    assert.match(result.stderr, /Keychain/);
    assert.deepEqual(folderState(home), before.data, args.join(' '));
  }

  const status = timed('status', () => run(['status', '--json']));
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).apiKeys.unreadable, ['deepseek']);
  const models = timed('models', () => run(['models']));
  assert.equal(models.status, 0, models.stderr);
  assert.doesNotMatch(models.stdout, /^deepseek\//m);
  assert.deepEqual(folderState(home), before.data);

  // start: the real gateway with a stand-in backend, in this process.
  const daemon = require('../src/daemon');
  const previous = process.env.DSHPROXY_KEYCHAIN;
  process.env.DSHPROXY_KEYCHAIN = made.file;
  t.after(() => { process.env.DSHPROXY_KEYCHAIN = previous; });
  const lines = [];
  const started = Date.now();
  const gateway = await daemon.start({
    home,
    print: (line) => lines.push(line),
    backend: { install: async () => ({ path: 'no-backend-program', installed: false }), createSupervisor: () => ({ start: async () => {}, stop: async () => {}, state: () => ({ running: true, pid: 4242, restarts: 0 }) }), checkForUpdate: async (current) => ({ available: false, current: current.version, latest: current.version }) }
  });
  t.after(() => gateway.stop());
  assert.ok(Date.now() - started < 15000, `start took ${Date.now() - started} ms`);
  assert.ok(lines.some((line) => /cannot be read for: deepseek/.test(line)), lines.join('\n'));
  const after = folderState(home);
  assert.deepEqual(Object.fromEntries(keyFiles.map((name) => [name, after[name]])), keysBefore);
  assert.equal(fs.readFileSync(made.file).toString('base64'), before.keychain);
});
