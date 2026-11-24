'use strict';
require('./support/keychain'); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
// On macOS nothing DSHProxy writes is readable by other accounts (spec 0014,
// design 3, criterion C10). The real CLI runs in throwaway folders with the
// usual file-creation mask (022), as a Terminal gives it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'dshproxy.js');
const macOnly = process.platform === 'darwin' ? {} : { skip: 'file modes on macOS; on Windows the user folder protects the files and nothing here changes' };

function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A Harness home as DeepSeek Harness leaves it, but with the files readable
// by everybody, and a credentials file that already has the reference.
function harnessHome(t) {
  const home = tempDir(t, 'dshproxy-harness-');
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: ui-chat\n  config:\n    transcriptView: standard\n', { mode: 0o644 });
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrecords: {}\nrefs:\n  DSHPROXY_API_KEY: placeholder\n', { mode: 0o644 });
  fs.chmodSync(path.join(home, '.credentials.yaml'), 0o644);
  fs.chmodSync(path.join(profileDir, 'cordis.patch.yml'), 0o644);
  return home;
}

function cli(data, harness, args, input = '') {
  // The mask a Terminal gives a program. The CLI must not depend on it.
  const before = process.umask(0o022);
  try {
    return spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', timeout: 60000, env: { ...process.env, DSHPROXY_HOME: data, DSH_HOME: harness } });
  } finally {
    process.umask(before);
  }
}

// Every file and folder below `dir` with its mode, except those in `untouched`.
function modes(dir) {
  const found = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      found[path.relative(dir, full)] = fs.statSync(full).mode & 0o777;
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return found;
}

const open = (found) => Object.entries(found).filter(([, mode]) => mode & 0o077).map(([name, mode]) => `${name} ${mode.toString(8)}`);

test('after the CLI saves a key and applies the routes, nothing it made or replaced can be read by other accounts', macOnly, (t) => {
  const parent = tempDir(t, 'dshproxy-modes-');
  const data = path.join(parent, 'data');
  const harness = harnessHome(t);

  const set = cli(data, harness, ['key', 'set', 'deepseek'], 'sk-test-modes-0123456789\n');
  assert.equal(set.status, 0, set.stderr);
  const applied = cli(data, harness, ['dsh', 'apply']);
  assert.equal(applied.status, 0, applied.stderr);

  assert.equal(fs.statSync(data).mode & 0o777, 0o700);
  assert.deepEqual(open(modes(data)), []);
  // In the Harness home: the profile it replaced, the backup it made and the
  // credentials file (which already had the reference). The folders were the
  // Harness's and are left as they were.
  const harnessModes = modes(harness);
  const written = Object.fromEntries(Object.entries(harnessModes).filter(([name]) => !['profiles', path.join('profiles', 'desktop')].includes(name)));
  assert.ok(Object.keys(written).some((name) => name.endsWith('.bak')), JSON.stringify(harnessModes));
  assert.deepEqual(open(written), []);
  assert.equal(harnessModes['.credentials.yaml'], 0o600);
});

test('a data folder that others can open is made private by the next command', macOnly, (t) => {
  const data = tempDir(t, 'dshproxy-modes-');
  fs.chmodSync(data, 0o755);
  const listed = cli(data, path.join(data, 'no-harness'), ['key', 'list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(fs.statSync(data).mode & 0o777, 0o700);
});

test('a video command that uses the data folder makes it private too', macOnly, (t) => {
  for (const args of [['video', 'key', 'list'], ['video', 'settings']]) {
    const data = tempDir(t, 'dshproxy-modes-');
    fs.chmodSync(data, 0o755);
    const result = cli(data, path.join(data, 'no-harness'), args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(data).mode & 0o777, 0o700, args.join(' '));
  }
});

test('dsh verify reports a credentials file that other accounts can read, because DeepSeek Harness will not read it', macOnly, (t) => {
  const parent = tempDir(t, 'dshproxy-modes-');
  const data = path.join(parent, 'data');
  const harness = harnessHome(t);
  assert.equal(cli(data, harness, ['key', 'set', 'deepseek'], 'sk-test-modes-0123456789\n').status, 0);
  assert.equal(cli(data, harness, ['dsh', 'apply']).status, 0);
  fs.chmodSync(path.join(harness, '.credentials.yaml'), 0o644);

  const verified = cli(data, harness, ['dsh', 'verify']);
  assert.equal(verified.status, 1, verified.stdout);
  assert.match(verified.stdout, /^credentials: \.credentials\.yaml can be read by other accounts on this Mac \(mode 644\)/m);
  assert.equal(fs.statSync(path.join(harness, '.credentials.yaml')).mode & 0o777, 0o644, 'verify changed the file');
});
