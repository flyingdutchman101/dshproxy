'use strict';
require('./support/keychain'); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
// Until stages B and C of 0014 are built, what they bring says on macOS that
// it is not there yet: one sentence, a non-zero exit, nothing changed (C12).
// Each test here is removed by the stage that brings the function.
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
const KREA = path.join(ROOT, 'bin', 'dshproxy-krea.js');
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
  [CLI, ['video', 'picker'], /^DSHProxy: Paid video is not available on macOS yet\. Nothing was changed\.$/],
  [CLI, ['video', 'picker', 'purchases', 'on'], /^DSHProxy: Paid video is not available on macOS yet\. Nothing was changed\.$/],
  [CLI, ['video', 'submit', 'wan-3.0', 'kovapi', '--max-usd', '1', '--confirm-charge', 'A red ball'], /^DSHProxy: Paid video is not available on macOS yet\. Nothing was changed\.$/],
  [CLI, ['video', 'status', 'wan-3.0', 'kovapi', 'job-1'], /^DSHProxy: Paid video is not available on macOS yet\. Nothing was changed\.$/],
  [CLI, ['video', 'quote', 'wan-3.0', 'krea', '--prompt', 'A red ball'], /^DSHProxy: Paid video is not available on macOS yet\. Nothing was changed\.$/],
  [CLI, ['video', 'krea', 'wan-3.0'], /^DSHProxy: Paid video is not available on macOS yet\. Nothing was changed\.$/],
  [CLI, ['dsh', 'bundle', 'status'], /^DSHProxy: Installing the video plugin into DeepSeek Harness is not available on macOS yet\. Nothing was changed\.$/],
  [CLI, ['dsh', 'bundle', 'install'], /^DSHProxy: Installing the video plugin into DeepSeek Harness is not available on macOS yet\. Nothing was changed\.$/],
  [KREA, ['status'], /^The Krea sign-in is not available on macOS yet\. Nothing was changed\.$/],
  [KREA, ['login'], /^The Krea sign-in is not available on macOS yet\. Nothing was changed\.$/]
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

test('on macOS, what needs only the master key works already: video list, offline quotes and video keys', macOnly, (t) => {
  const found = box(t);
  assert.equal(run(found, CLI, ['video', 'list']).status, 0);
  assert.equal(run(found, CLI, ['video', 'quote', 'wan-3.0', 'kovapi']).status, 0);
  const set = run(found, CLI, ['video', 'key', 'set', 'kovapi'], 'synthetic-kovapi-key-0123456789\n');
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout), { provider: 'kovapi', saved: true });
});

test('on macOS, dsh apply writes no video route, even with a video entry switched on', macOnly, (t) => {
  const found = box(t);
  assert.equal(run(found, CLI, ['key', 'set', 'deepseek'], 'sk-test-notyet-0123456789\n').status, 0);
  assert.equal(run(found, CLI, ['video', 'entries', 'set', 'wan-3.0', '1080p', 'videorouter', 'on']).status, 0);
  const applied = run(found, CLI, ['dsh', 'apply']);
  assert.equal(applied.status, 0, applied.stderr);
  const providers = YAML.parse(fs.readFileSync(path.join(found.harness, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')).find((item) => item.id === 'llm-pi-ai').config.providers;
  assert.ok(providers['dshproxy-lanes']);
  assert.equal(providers['dshproxy-video'], undefined);
});

test('on macOS, the gateway answers its video path with not found and makes no video folder', macOnly, async (t) => {
  const found = box(t);
  const free = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const port = await free();
  const backendPort = await free();
  fs.writeFileSync(path.join(found.data, 'settings.json'), JSON.stringify({ port, backendPort }));
  const daemon = require('../src/daemon');
  const backend = http.createServer((req, res) => res.end('{"from":"backend"}'));
  await new Promise((resolve) => backend.listen(backendPort, '127.0.0.1', resolve));
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const gateway = await daemon.start({
    home: found.data,
    print: () => {},
    backend: { install: async () => ({ path: 'no-backend-program', installed: false }), createSupervisor: () => ({ start: async () => {}, stop: async () => {}, state: () => ({ running: true, pid: 4242, restarts: 0 }) }) }
  });
  t.after(() => gateway.stop());
  const answer = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/dshproxy/video/v1/messages', headers: { 'content-type': 'application/json' }, agent: false }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end('{"model":"wan-3.0/1080p/videorouter","messages":[{"role":"user","content":"A red ball"}]}');
  });
  assert.equal(answer.status, 404);
  assert.doesNotMatch(answer.text, /backend/);
  assert.match(answer.text, /not available on macOS yet/);
  assert.equal(fs.existsSync(path.join(found.data, 'video-picker')), false);
});
