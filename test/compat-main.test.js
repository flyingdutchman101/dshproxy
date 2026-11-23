'use strict';
// On Windows, a data folder written by the current release (`main`) is read by
// this version, and one written by this version is read by `main`
// (docs/work/0014-macos-port, criterion C13). A characterization test: it was
// written after the change and cannot have failed before it.
//
// It needs a checkout of `main` with its dependencies, named in
// DSHPROXY_BASE_CHECKOUT; CI on Windows makes one. Without it, it is skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const base = process.env.DSHPROXY_BASE_CHECKOUT;
const options = process.platform !== 'win32'
  ? { skip: 'Windows only: on macOS there is no earlier release whose data folder must be read' }
  : !base ? { skip: 'DSHPROXY_BASE_CHECKOUT does not name a checkout of main (CI on Windows sets it)' } : {};

const NEW = path.join(__dirname, '..', 'bin', 'dshproxy.js');
const OLD = base ? path.join(base, 'bin', 'dshproxy.js') : null;
const KEY = 'sk-test-compat-0123456789abcdef';
const VIDEO_KEY = 'synthetic-compat-video-key-0123456789';

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-compat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ port: 65431, backendPort: 65432 }));
  return dir;
}

const run = (cli, dir, args, input = '') => {
  const env = { ...process.env, DSHPROXY_HOME: dir, DSH_HOME: path.join(dir, 'no-harness') };
  for (const name of ['VIDEOROUTER_API_KEY', 'KOVAPI_API_KEY', 'CALLIRRA_API_KEY']) delete env[name];
  return spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 60000, env });
};

function writeWith(cli, t) {
  const dir = home(t);
  for (const [args, input] of [[['key', 'set', 'deepseek'], `${KEY}\n`], [['video', 'key', 'set', 'kovapi'], `${VIDEO_KEY}\n`], [['preset', 'use', 'cheap'], '']]) {
    const result = run(cli, dir, args, input);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  }
  return dir;
}

function readWith(cli, dir) {
  const status = run(cli, dir, ['status', '--json']);
  assert.equal(status.status, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.deepEqual(parsed.apiKeys.readable, [{ provider: 'deepseek', region: 'international' }]);
  assert.deepEqual(parsed.apiKeys.unreadable || [], []);
  const videoKeys = run(cli, dir, ['video', 'key', 'list']);
  assert.equal(videoKeys.status, 0, videoKeys.stderr);
  const kovapi = JSON.parse(videoKeys.stdout).providers.find((row) => row.provider === 'kovapi');
  assert.deepEqual([kovapi.saved, kovapi.readable], [true, true]);
  const presets = run(cli, dir, ['preset', 'list']);
  assert.match(presets.stdout, /^Active: cheap\./m);
}

test('a data folder written by main is read by this version', options, (t) => {
  readWith(NEW, writeWith(OLD, t));
});

test('a data folder written by this version is read by main', options, (t) => {
  readWith(OLD, writeWith(NEW, t));
});

test('a backend lock with the macOS archives, as an update made by this version writes it, is read by main', options, (t) => {
  const dir = home(t);
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'backend.lock.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'backend.lock.json'), `${JSON.stringify({ ...shipped, version: '99.0.1', previous: shipped }, null, 2)}\n`);
  const version = run(OLD, dir, ['backend', 'version']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^CLIProxyAPI 99\.0\.1 \(previous 8\.0\.72 kept\)/);
});
