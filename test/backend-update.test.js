'use strict';
require('./support/keychain'); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
// `dshproxy backend update` (spec 0014, C5): asks the running gateway, through
// the control routes the Windows app uses, to look for a newer CLIProxyAPI and
// to apply it. The gateway is the real one, started by `dshproxy start` in its
// own process; GitHub, the download, the trial run and the backend program are
// stand-ins, so nothing is downloaded or run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'dshproxy.js');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend.lock.json'), 'utf8'));

const sparePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

async function until(check, what, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The release GitHub offers: the next version with the archives of both
// systems, or the version already running.
function release(version) {
  const names = ['windows_amd64.zip', 'windows_aarch64.zip', 'darwin_aarch64.tar.gz', 'darwin_amd64.tar.gz'].map((suffix) => `CLIProxyAPI_${version}_${suffix}`);
  const base = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}/`;
  return {
    release: { tag_name: `v${version}`, published_at: '2026-11-23T00:00:00Z', draft: false, prerelease: false, assets: [...names, 'checksums.txt'].map((name) => ({ name, browser_download_url: `${base}${name}` })) },
    sums: names.map((name, index) => `${String(index + 1).repeat(64)}  ${name}`).join('\n')
  };
}

// `dshproxy start` in its own process with the outside edges replaced.
// `github` is what the stand-in for GitHub answers: a release, or an HTTP error.
async function startGateway(t, github) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-update-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await sparePort();
  const backendPort = await sparePort();
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ port, backendPort }));
  const script = `
    const http = require('http');
    const root = ${JSON.stringify(ROOT)};
    const github = ${JSON.stringify(github)};
    const { checkForUpdate } = require(root + '/src/backend/updater');
    const fetchImpl = async (url) => {
      if (github.status) return { ok: false, status: github.status, json: async () => ({}), text: async () => '' };
      const body = String(url).endsWith('/checksums.txt') ? github.sums : github.release;
      return { ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    };
    // The backend program: a server on its port that answers every request.
    const createSupervisor = () => {
      let server = null;
      return {
        start: () => new Promise((resolve, reject) => { server = http.createServer((req, res) => res.end('{}')); server.once('error', reject); server.listen(${backendPort}, '127.0.0.1', resolve); }),
        stop: () => new Promise((resolve) => { if (!server) return resolve(); server.closeAllConnections(); server.close(() => resolve()); }),
        state: () => ({ running: true, pid: 4242, restarts: 0 })
      };
    };
    setInterval(() => {}, 60000);
    const daemon = require(root + '/src/daemon.js');
    const start = daemon.start;
    daemon.start = (options) => start({ ...options, backend: {
      install: async (lock) => ({ path: 'no-backend-program-' + lock.version, installed: false }),
      createSupervisor,
      checkForUpdate: (current) => checkForUpdate(current, { fetchImpl }),
      trial: async () => ({ ok: true, checks: ['stand-in: ok'] })
    } });
    require(root + '/src/cli.js').main(['start'], (line) => console.log(line)).catch((error) => { console.error(error); process.exit(3); });`;
  const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, DSHPROXY_HOME: home, DSH_HOME: path.join(home, 'no-harness') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(() => child.kill('SIGKILL'));
  await until(() => /listening on/.test(output) || child.exitCode !== null, 'the gateway to listen');
  assert.equal(child.exitCode, null, output);
  return { home, port, output: () => output };
}

function cli(home, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, DSHPROXY_HOME: home, DSH_HOME: path.join(home, 'no-harness') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const status = (port) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/dshproxy/status', agent: false }, (res) => {
    let text = '';
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
  }).on('error', reject);
});
const lockIn = (home) => (fs.existsSync(path.join(home, 'backend.lock.json')) ? JSON.parse(fs.readFileSync(path.join(home, 'backend.lock.json'), 'utf8')) : null);

test('backend update with no newer release says it is up to date and changes nothing', async (t) => {
  const g = await startGateway(t, release(SHIPPED.version));
  const before = lockIn(g.home);
  const result = await cli(g.home, ['backend', 'update']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `CLIProxyAPI ${SHIPPED.version} is up to date.`);
  assert.deepEqual(lockIn(g.home), before);
});

test('backend update applies a newer release, and the gateway answers on it afterwards', async (t) => {
  const g = await startGateway(t, release('99.0.1'));
  const result = await cli(g.home, ['backend', 'update']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Updated to CLIProxyAPI 99\.0\.1\./m);
  const lock = lockIn(g.home);
  assert.equal(lock.version, '99.0.1');
  assert.equal(lock.previous.version, SHIPPED.version);
  assert.ok(lock.assets[`${process.platform}-${process.arch}`], 'the lock has no download for this system');
  await until(async () => { try { return (await status(g.port)).backend.version === '99.0.1'; } catch { return false; } }, 'the gateway to answer on the new version', 20000);
});

test('backend update reports a failed check as a failure, not as up to date', async (t) => {
  const g = await startGateway(t, { status: 500 });
  const before = lockIn(g.home);
  const result = await cli(g.home, ['backend', 'update']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not check for a newer CLIProxyAPI: GitHub answered HTTP 500\./i);
  assert.equal(result.stdout, '');
  assert.deepEqual(lockIn(g.home), before);
});

test('backend update with no gateway running says so and changes nothing', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-update-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ port: await sparePort(), backendPort: await sparePort() }));
  const before = fs.readdirSync(home);
  const result = await cli(home, ['backend', 'update']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /The gateway is not running on http:\/\/127\.0\.0\.1:\d+\. Nothing was changed\./);
  assert.deepEqual(fs.readdirSync(home), before);
});
