'use strict';
// Throwaway proof for 0014 (macOS port). Not production code; removed before
// the branch is merged. It runs on a GitHub macOS machine and answers, with
// observations instead of beliefs:
//
//   K  can `/usr/bin/security` keep one key per user, take it on standard
//      input, never overwrite, end with an error when the keychain is locked?
//   B  does the pinned CLIProxyAPI archive for this processor unpack, what is
//      the program in it called, does it start and answer, and can a leftover
//      one be recognised by its program path?
//   F  do the file-creation mask and file modes behave as the spec assumes?
//
// Every secret here is random and thrown away. Only its first characters and
// a hash are printed. The one keychain that is created is a file in the
// temporary folder; a login keychain is touched only on a GitHub machine, with
// a service name of its own, and the item is removed again.
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SECURITY = '/usr/bin/security';
const SERVICE = 'DSHProxy';
const ACCOUNT = 'key-wrapper';
const TIMEOUT = 10000;
const ASSETS = {
  arm64: { name: 'CLIProxyAPI_8.0.72_darwin_aarch64.tar.gz', sha256: 'ae008afd4ad52603f220200afc6417102591ba0a847d128cb65e904f86ac7918' },
  x64: { name: 'CLIProxyAPI_8.0.72_darwin_amd64.tar.gz', sha256: '27591f4c829cd3a2ce9daed541328103f6439841d25aefca82207d79126a90af' }
};
const RELEASE = 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.72/';

const results = [];
const say = (kind, name, detail = '') => {
  results.push({ kind, name });
  console.log(`${kind.padEnd(4)} ${name}${detail === '' ? '' : `: ${detail}`}`);
};
const pass = (name, ok, detail = '') => say(ok ? 'PASS' : 'FAIL', name, detail);
const info = (name, detail = '') => say('INFO', name, detail);
const short = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(file, args, { input, env = { HOME: process.env.HOME }, timeout = TIMEOUT } = {}) {
  const at = Date.now();
  const done = spawnSync(file, args, { input, env, timeout, encoding: 'utf8' });
  return { code: done.status, signal: done.signal, out: done.stdout || '', err: done.stderr || '', ms: Date.now() - at, error: done.error ? done.error.code || done.error.message : null };
}
const shown = (r) => `exit ${r.code}${r.signal ? ` signal ${r.signal}` : ''}${r.error ? ` error ${r.error}` : ''} in ${r.ms} ms; stderr: ${short(r.err) || '(none)'}`;

// The secret travels on standard input only: the argument list is `-i`.
const quoted = (file) => `"${file}"`;
function write(hex, keychain, service = SERVICE, options) {
  const line = `add-generic-password -s ${service} -a ${ACCOUNT} -w ${hex}${keychain ? ` ${quoted(keychain)}` : ''}\n`;
  return run(SECURITY, ['-i'], { input: line, ...options });
}
function read(keychain, service = SERVICE, options) {
  return run(SECURITY, ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w', ...(keychain ? [keychain] : [])], options);
}
const remove = (keychain, service = SERVICE) => run(SECURITY, ['delete-generic-password', '-s', service, '-a', ACCOUNT, ...(keychain ? [keychain] : [])]);

// One of several processes that all find no key: write its own, then use
// whatever is there.
function racer(keychain, startAt) {
  const mine = crypto.randomBytes(32).toString('hex');
  setTimeout(() => {
    const wrote = write(mine, keychain);
    const got = read(keychain);
    console.log(JSON.stringify({ mine: sha(mine), read: got.code === 0 ? sha(got.out.trim()) : null, writeExit: wrote.code, readExit: got.code }));
  }, Math.max(0, startAt - Date.now()));
}

async function keychainProof(tmp) {
  info('security', fs.existsSync(SECURITY) ? 'present' : 'MISSING');
  const def = run(SECURITY, ['default-keychain']);
  info('default keychain', `${short(def.out)} (${shown(def)})`);
  info('keychain search list', short(run(SECURITY, ['list-keychains']).out));

  const keychain = path.join(tmp, 'dshproxy-spike.keychain-db');
  const made = run(SECURITY, ['create-keychain', '-p', 'spike-pw', keychain]);
  pass('K0 a throwaway keychain file can be created', made.code === 0, shown(made));
  run(SECURITY, ['set-keychain-settings', keychain]);
  run(SECURITY, ['unlock-keychain', '-p', 'spike-pw', keychain]);

  const empty = read(keychain);
  info('K1 reading an item that does not exist', shown(empty));

  const first = crypto.randomBytes(32).toString('hex');
  const wrote = write(first, keychain);
  info('K2 write through `security -i`, command on standard input', `${shown(wrote)}; stdout: ${short(wrote.out) || '(none)'}`);
  const back = read(keychain);
  pass('K2 what was written on standard input is read back from standard output', back.code === 0 && back.out === `${first}\n`, `${shown(back)}; ${back.out.length} characters`);

  const other = crypto.randomBytes(32).toString('hex');
  const again = write(other, keychain);
  info('K3 a second write through `security -i`', `${shown(again)}; stdout: ${short(again.out) || '(none)'}`);
  const direct = run(SECURITY, ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', other, keychain]);
  info('K3 a second write with the value as an argument (for comparison only)', shown(direct));
  const still = read(keychain);
  pass('K3 an item that exists is not overwritten', still.out === `${first}\n`, shown(still));

  // While `security -i` is alive with the command already sent, its argument
  // list and environment as other processes see them.
  const seen = await new Promise((resolve) => {
    const secret = crypto.randomBytes(32).toString('hex');
    const child = spawn(SECURITY, ['-i'], { env: { HOME: process.env.HOME }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.write(`find-generic-password -s ${SERVICE}-absent -a ${secret} ${quoted(keychain)}\n`);
    setTimeout(() => {
      const args = run('/bin/ps', ['-o', 'args=', '-p', String(child.pid)]);
      const environment = run('/bin/ps', ['eww', '-o', 'command=', '-p', String(child.pid)]);
      child.stdin.end();
      child.on('exit', () => resolve({ secret, args: args.out, environment: environment.out }));
    }, 400);
  });
  pass('K4 the argument list of `security -i` holds nothing that was sent on standard input', seen.args.trim() !== '' && !seen.args.includes(seen.secret) && !seen.environment.includes(seen.secret), `ps shows: ${short(seen.args)}`);

  const bare = run(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', keychain], { env: {} });
  info('K5 read with an empty environment', shown(bare));

  // Several processes at the same moment, no item: all must end with one key.
  let rounds = 0;
  let agreed = 0;
  const odd = [];
  for (let round = 0; round < 15; round += 1) {
    remove(keychain);
    const startAt = Date.now() + 700;
    const outs = await Promise.all([0, 1, 2, 3].map(() => new Promise((resolve) => {
      let text = '';
      const child = spawn(process.execPath, [__filename, 'racer', keychain, String(startAt)], { env: { HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.on('exit', () => { try { resolve(JSON.parse(text)); } catch { resolve({ read: null, bad: short(text) }); } });
    })));
    rounds += 1;
    const final = read(keychain);
    const stored = final.code === 0 ? sha(final.out.trim()) : null;
    const same = stored !== null && outs.every((one) => one.read === stored);
    if (same) agreed += 1; else odd.push(JSON.stringify({ stored, outs }));
    if (round === 0) info('K6 first round', JSON.stringify(outs));
  }
  pass('K6 four processes at once with no key end with the same key, every round', agreed === rounds, `${agreed} of ${rounds}${odd.length ? `; ${odd.slice(0, 2).join(' ')}` : ''}`);

  const locking = run(SECURITY, ['lock-keychain', keychain]);
  info('K7 lock', shown(locking));
  // First run (5682a61): a read of a locked keychain did not end by itself; it
  // was ended after the 10 seconds. These look for a way to see "locked"
  // without waiting, and for what the wait leaves behind.
  const agents = () => short(run('/usr/bin/pgrep', ['-lf', 'SecurityAgent|securityd_service|coreautha'], { timeout: 5000 }).out) || '(none)';
  info('K7 dialog processes before', agents());
  const settings = run(SECURITY, ['show-keychain-info', keychain], { timeout: 5000 });
  info('K7 probe: show-keychain-info on a locked keychain', `${shown(settings)}; stdout: ${short(settings.out) || '(none)'}`);
  const attributes = run(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, keychain], { timeout: 5000 });
  info('K7 probe: the item\'s attributes, without its value, on a locked keychain', `${shown(attributes)}; ${attributes.out.split('\n').length} lines of output; value in it: ${/password:/.test(attributes.out)}`);
  const unlockNoPassword = run(SECURITY, ['unlock-keychain', keychain], { timeout: 5000, input: '' });
  info('K7 probe: unlock-keychain with no password and an empty standard input', shown(unlockNoPassword));
  const locked = read(keychain);
  info('K7 reading the value of a locked keychain', shown(locked));
  info('K7 dialog processes after the read was ended', agents());
  pass('K7 a read of a locked keychain is over within the 10 seconds, by itself or ended, and returns no value', locked.out === '' && locked.ms < TIMEOUT + 2000, shown(locked));
  const lockedWrite = write(crypto.randomBytes(32).toString('hex'), keychain);
  info('K7 writing to a locked keychain', `${shown(lockedWrite)}; stdout: ${short(lockedWrite.out) || '(none)'}`);
  info('K7 the codes: absent item / locked', `${empty.code} / ${locked.code}`);
  pass('K7 "no key yet" and "cannot be read" can be told apart', empty.code !== locked.code && empty.code !== 0);
  run(SECURITY, ['unlock-keychain', '-p', 'spike-pw', keychain]);
  const after = read(keychain);
  pass('K7 after unlocking, the key is what it was', after.code === 0 && after.out.trim().length === 64, shown(after));

  const missing = read(path.join(tmp, 'no-such.keychain-db'));
  info('K8 a keychain file that does not exist', shown(missing));

  const spaced = path.join(tmp, 'with space');
  fs.mkdirSync(spaced);
  const spacedFile = path.join(spaced, 'k.keychain-db');
  run(SECURITY, ['create-keychain', '-p', 'spike-pw', spacedFile]);
  run(SECURITY, ['unlock-keychain', '-p', 'spike-pw', spacedFile]);
  const value = crypto.randomBytes(32).toString('hex');
  const spacedWrite = write(value, spacedFile);
  const spacedRead = read(spacedFile);
  info('K9 a keychain path with a space, in the command on standard input', `${shown(spacedWrite)}; read back: ${spacedRead.out === `${value}\n`}`);
  run(SECURITY, ['delete-keychain', spacedFile]);
  info('K10 delete the throwaway keychain', shown(run(SECURITY, ['delete-keychain', keychain])));

  // The path production takes: no keychain named. Only on a GitHub machine,
  // whose login keychain is thrown away with the machine.
  if (process.env.GITHUB_ACTIONS === 'true') {
    const service = `DSHProxy-spike-${crypto.randomBytes(4).toString('hex')}`;
    const secret = crypto.randomBytes(32).toString('hex');
    const w = write(secret, null, service);
    const r = read(null, service);
    pass('K11 the default keychain of this machine: written and read with no keychain named, no prompt', r.code === 0 && r.out === `${secret}\n`, `write ${shown(w)}; read ${shown(r)}`);
    info('K11 removed again', shown(remove(null, service)));
  } else {
    info('K11 skipped: not a GitHub machine, a login keychain is not touched');
  }
}

function listed(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listed(file, base);
    const stat = fs.lstatSync(file);
    return [{ file, name: path.relative(base, file), mode: (stat.mode & 0o777).toString(8), size: stat.size }];
  });
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const answers = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/v1/models', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});

async function backendProof(tmp) {
  const asset = ASSETS[process.arch];
  if (!asset) return info('B skipped', `no asset for ${process.arch}`);
  const archive = path.join(tmp, asset.name);
  const response = await fetch(RELEASE + asset.name);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(archive, bytes);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  pass('B1 the archive for this processor has the SHA-256 GitHub reported', response.ok && digest === asset.sha256, `${asset.name}, ${bytes.length} bytes`);
  const sums = await (await fetch(`${RELEASE}checksums.txt`)).text();
  const lines = sums.split('\n').filter((line) => line.includes('darwin'));
  info('B1 checksums.txt, darwin lines', lines.join(' | '));
  pass('B1 checksums.txt agrees for both macOS archives', Object.values(ASSETS).every((one) => lines.some((line) => line.includes(one.sha256) && line.includes(one.name))));

  const dir = path.join(tmp, 'backend');
  fs.mkdirSync(dir);
  const tar = run('/usr/bin/tar', ['-xzf', archive, '-C', dir]);
  pass('B2 /usr/bin/tar unpacks it', tar.code === 0, shown(tar));
  const files = listed(dir);
  info('B2 files in the archive', files.map((f) => `${f.name} (mode ${f.mode}, ${f.size} bytes)`).join(', '));
  const programs = files.filter((f) => (parseInt(f.mode, 8) & 0o111) !== 0);
  info('B2 files marked executable', programs.map((f) => f.name).join(', ') || '(none)');
  const program = files.find((f) => /^cli-proxy-api$/i.test(path.basename(f.name))) || programs[0];
  if (!program) return pass('B3 a program was found in the archive', false);
  info('B3 the program', `${program.name}; ${short(run('/usr/bin/file', [program.file]).out)}`);
  const signed = run('/usr/bin/codesign', ['-dv', program.file]);
  info('B3 code signature', short(signed.err || signed.out));
  info('B3 extended attributes', short(run('/usr/bin/xattr', ['-l', program.file]).out) || '(none)');
  fs.chmodSync(program.file, 0o755);
  const help = run(program.file, ['-h'], { env: { HOME: process.env.HOME } });
  info('B3 `-h`', `exit ${help.code}${help.signal ? ` signal ${help.signal}` : ''}${help.error ? ` error ${help.error}` : ''}; ${short(help.out || help.err).slice(0, 160)}`);

  // Started as the gateway starts it, with the configuration the gateway writes.
  const { render } = require(path.join(__dirname, '..', '..', '..', '..', 'src', 'backend', 'config.js'));
  const port = await freePort();
  const authDir = path.join(tmp, 'auth');
  fs.mkdirSync(authDir);
  const configPath = path.join(tmp, 'backend-config.yaml');
  fs.writeFileSync(configPath, render({ host: '127.0.0.1', port, authDir, managementKey: '' }));
  const log = [];
  const child = spawn(program.file, ['-config', configPath], { cwd: path.dirname(program.file), stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (chunk) => { for (const line of chunk.toString().split(/\r?\n/)) if (line.trim() && log.length < 12) log.push(short(line).slice(0, 160)); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (error) => { exited = { error: error.code || error.message }; });
  let status = null;
  const began = Date.now();
  while (status === null && exited === null && Date.now() - began < 30000) { await sleep(500); status = await answers(port); }
  pass('B4 the backend starts with the gateway\'s own configuration and answers on /v1/models', status !== null, `HTTP ${status} after ${Date.now() - began} ms${exited ? `; exited ${JSON.stringify(exited)}` : ''}`);
  info('B4 its first lines', log.join(' / ') || '(none)');

  if (exited === null) {
    const comm = run('/bin/ps', ['-o', 'comm=', '-p', String(child.pid)]);
    const real = (file) => { try { return fs.realpathSync(file.trim()); } catch { return `(no such file: ${file.trim()})`; } };
    pass('B5 `ps -o comm=` gives the program path of a running backend', comm.code === 0 && real(comm.out) === real(program.file), `ps: ${short(comm.out)}; ours: ${program.file}`);
    info('B5 the same for this Node process', short(run('/bin/ps', ['-o', 'comm=', '-p', String(process.pid)]).out));
    const at = Date.now();
    child.kill();
    while (exited === null && Date.now() - at < 10000) await sleep(100);
    pass('B6 it ends on SIGTERM', exited !== null, `${JSON.stringify(exited)} after ${Date.now() - at} ms`);
    if (exited === null) child.kill('SIGKILL');
    await sleep(300);
    pass('B6 nothing answers on its port afterwards', (await answers(port)) === null);
  }
  return undefined;
}

function filesProof(tmp) {
  const before = process.umask(0o077);
  info('F0 the mask this process was started with', before.toString(8));
  const dir = path.join(tmp, 'masked');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'secret.json');
  fs.writeFileSync(file, '{}');
  const mode = (target) => (fs.statSync(target).mode & 0o777).toString(8);
  pass('F1 with the mask set, a new file is 600 and a new folder 700', mode(file) === '600' && mode(dir) === '700', `${mode(file)} / ${mode(dir)}`);
  const child = run('/bin/sh', ['-c', 'umask; touch "$0" && stat -f %Lp "$0"', path.join(dir, 'by-child')]);
  pass('F2 a child process inherits the mask', child.out.split('\n')[0].trim() === '0077' && child.out.split('\n')[1].trim() === '600', short(child.out));
  const wide = path.join(dir, 'wide.yaml');
  fs.writeFileSync(wide, 'a: 1\n');
  fs.chmodSync(wide, 0o644);
  const temporary = `${wide}.tmp`;
  fs.writeFileSync(temporary, 'a: 2\n');
  fs.renameSync(temporary, wide);
  pass('F3 a 644 file replaced by a rename takes the new file\'s mode', mode(wide) === '600', mode(wide));
  const readOnly = path.join(dir, 'read-only.yaml');
  fs.writeFileSync(readOnly, 'a: 1\n');
  fs.chmodSync(readOnly, 0o444);
  fs.writeFileSync(temporary, 'a: 2\n');
  let renamed = 'ok';
  try { fs.renameSync(temporary, readOnly); } catch (error) { renamed = error.code; }
  info('F4 renaming over a read-only file (test/profile.test.js expects a refusal on Windows)', renamed);

  // For Release B: what a recreated file's creation time is.
  const born = path.join(dir, 'journal.log');
  fs.writeFileSync(born, 'x');
  const first = fs.statSync(born).birthtimeMs;
  fs.unlinkSync(born);
  const wait = Date.now() + 60;
  while (Date.now() < wait);
  fs.writeFileSync(born, 'x');
  const second = fs.statSync(born).birthtimeMs;
  info('F5 creation time of a file deleted and made again 60 ms later', `first ${first}, second ${second}, differs ${first !== second}`);
  info('F6 home and temporary folder', `homedir ${os.homedir() === process.env.HOME ? 'equals HOME' : 'differs from HOME'}; TMPDIR ${process.env.TMPDIR ? 'set' : 'not set'}; tmpdir under /var/folders: ${fs.realpathSync(os.tmpdir()).includes('/var/folders')}`);
  const without = run(process.execPath, ['-e', 'console.log(require("os").homedir())'], { env: {} });
  info('F6 os.homedir() in a child given no HOME', `${without.out.trim() === process.env.HOME ? 'the same folder' : short(without.out) || '(nothing)'}; ${shown(without)}`);
}

async function main() {
  console.log(`${os.platform()} ${os.release()} ${process.arch}; node ${process.version}; libuv ${process.versions.uv}; ${short(run('/usr/bin/sw_vers', []).out)}`);
  if (process.platform !== 'darwin') {
    console.log('This proof runs on macOS only.');
    process.exitCode = 2;
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-spike-'));
  for (const [name, part] of [['keychain', keychainProof], ['backend', backendProof], ['files', filesProof]]) {
    console.log(`\n== ${name}`);
    try {
      await part(tmp);
    } catch (error) {
      pass(`${name}: ran to the end`, false, short(error && error.stack));
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((one) => one.kind === 'FAIL');
  console.log(`\n${results.filter((one) => one.kind === 'PASS').length} passed, ${failed.length} failed${failed.length ? `: ${failed.map((one) => one.name.split(' ')[0]).join(', ')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}

if (process.argv[2] === 'racer') racer(process.argv[3], Number(process.argv[4]));
else main();
