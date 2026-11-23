'use strict';
require('./support/keychain'); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
// Until stage C of 0014 is built, the plugin install says on macOS that it is
// not there yet: one sentence, a non-zero exit, nothing changed (C12). Stage B
// (video, the Krea sign-in) took its cases out. This file goes with stage C.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'dshproxy.js');
const macOnly = process.platform === 'darwin' ? {} : { skip: 'macOS only: on Windows video, the Krea sign-in and the plugin install work' };

function box(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-notyet-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const data = path.join(base, 'data');
  const harness = path.join(base, 'harness');
  fs.mkdirSync(data);
  fs.mkdirSync(path.join(harness, 'profiles', 'desktop'), { recursive: true });
  return { base, data, harness };
}

function snapshot(dir) {
  const found = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) { found[`${path.relative(dir, full)}/`] = true; walk(full); } else found[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return found;
}

const run = (found, file, args, input = '') => spawnSync(process.execPath, [file, ...args], { input, encoding: 'utf8', timeout: 30000, env: { ...process.env, DSHPROXY_HOME: found.data, DSH_HOME: found.harness, DSHPROXY_HARNESS_DIR: path.join(found.base, 'no-harness-app') } });

for (const [file, args, sentence] of [
  [CLI, ['dsh', 'bundle', 'status'], /^DSHProxy: Installing the video plugin into DeepSeek Harness is not available on macOS yet\. Nothing was changed\.$/],
  [CLI, ['dsh', 'bundle', 'install'], /^DSHProxy: Installing the video plugin into DeepSeek Harness is not available on macOS yet\. Nothing was changed\.$/],
]) {
  test(`on macOS, ${path.basename(file)} ${args.join(' ')} says it is not available yet and changes nothing`, macOnly, (t) => {
    const found = box(t);
    const before = snapshot(found.base);
    const result = run(found, file, args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr.trim(), sentence);
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.deepEqual(snapshot(found.base), before);
  });
}



