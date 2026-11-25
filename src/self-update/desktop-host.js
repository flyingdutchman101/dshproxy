'use strict';

// Trusted, installed-side lifecycle adapter. Never load code from the stage into
// this process. All build commands execute in the disposable clone.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const net = require('node:net');
const { promisify } = require('node:util');
const exec = promisify(cp.execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function createHost({ platform = process.platform, guiPid, timeoutMs = 60000, pollMs = 250, desktopCommand = file => [file] } = {}) {
  let launched, session, transaction, resumeGateway;
  const command = (file, args, cwd, timeout = 120000) => exec(file, args, {
    cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DSHPROXY_UPDATE_SESSION: '' },
  });
  const git = async (root, args) => (await command('git', ['-C', root, ...args], root)).stdout.trim();
  const cli = async (plan, args) => JSON.parse((await command(process.execPath,
    [path.join(plan.root, 'bin', 'dshproxy.js'), ...args], plan.root)).stdout);
  const appName = () => platform === 'darwin' ? 'DSHProxy.app' : 'DSHProxy.exe';
  async function spawn(file, args, options) {
    const child = cp.spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, ...options });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    // Keep an error listener after spawn, too: late OS errors must not crash the worker.
    child.on('error', () => {});
    child.unref();
    return child;
  }
  async function wait(check, message) {
    const until = Date.now() + timeoutMs;
    do { if (await check()) return; await delay(pollMs); } while (Date.now() < until);
    throw new Error(message);
  }
  async function closeLaunched() {
    if (!launched || launched.exitCode !== null || launched.signalCode !== null) return;
    // ChildProcess.kill targets only the handle this worker created. Never signal
    // plan.guiPid: the old GUI exits itself after it receives `started`.
    launched.kill();
    await wait(() => launched.exitCode !== null || launched.signalCode !== null, 'New desktop did not exit');
  }
  const host = {
    platform,
    async preflight(plan) {
      if (!['darwin', 'win32'].includes(platform)) throw new Error('Unsupported desktop platform');
      const pid = plan.guiPid ?? guiPid;
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('An actual parent GUI PID is required');
      guiPid = pid;
      const intended = path.join(plan.root, appName(), ...(platform === 'darwin' ? ['Contents','MacOS','DSHProxy'] : []));
      const image = (platform === 'darwin'
        ? await command('/bin/ps',['-p',String(pid),'-o','comm='],plan.root)
        : await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).Path`],plan.root)).stdout.trim();
      if (!image || path.relative(await fs.realpath(intended),await fs.realpath(image)) !== '') throw new Error('Run the app built in this checkout to install its update. Moved copies must be updated manually.');
      await command('git', ['--version'], plan.root);
      await command(platform === 'win32' ? 'powershell.exe' : '/bin/bash',
        platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'] : ['--version'], plan.root);
    },
    async build(plan) {
      if (!plan.stage || path.resolve(plan.stage) === path.resolve(plan.root)) throw new Error('A separate staging checkout is required');
      // npm.cmd cannot be execFile'd without a shell on Windows. Invoke npm's
      // JS CLI via the Node installation instead, avoiding path interpolation.
      const npm = platform === 'win32'
        ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : path.resolve(path.dirname(await fs.realpath(process.execPath)), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      await command(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], plan.stage, 600000);
      if (platform === 'darwin') {
        await command('/bin/bash', [path.join(plan.stage, 'app-macos', 'build.sh')], plan.stage, 600000);
        const bundle = path.join(plan.stage, appName());
        await command('/usr/bin/plutil', ['-replace', 'DSHProxyCheckout', '-string', plan.root, path.join(bundle, 'Contents', 'Info.plist')], plan.stage);
        await command('/usr/bin/codesign', ['--force', '--sign', '-', bundle], plan.stage);
        await command('/usr/bin/codesign', ['--verify', '--strict', bundle], plan.stage);
      } else {
        await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(plan.stage, 'app', 'build.ps1')], plan.stage, 600000);
      }
      for (const name of [appName(), 'node_modules']) {
        const stat = await fs.lstat(path.join(plan.stage, name));
        if (stat.isSymbolicLink()) throw new Error('Symlinked staged artifacts are unsupported');
      }
    },
    async gatewayRunning(plan) {
      const state = await cli(plan, ['status', '--json']);
      if (typeof state.running !== 'boolean') throw new Error('Unknown gateway state');
      if (!state.running) {
        // status --json reports false both for a closed port and an unhealthy
        // listener. Only connection refusal proves that no gateway is running.
        const origin = new URL(state.origin);
        await new Promise((resolve, reject) => {
          const socket = net.createConnection({ host: origin.hostname.replace(/^\[|\]$/g, ''), port: Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)) });
          const unknown = () => { socket.destroy(); reject(new Error('Unknown gateway state: a listener is not answering status')); };
          socket.setTimeout(Math.min(timeoutMs, 5000), unknown);
          socket.once('connect', unknown);
          socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(); else reject(new Error('Unknown gateway state')); });
        });
      }
      return state.running;
    },
    async stopWhenIdle(plan) {
      try {
        const result = await cli(plan, ['stop', '--when-idle', '--wait', '30']);
        if (result.stopped === true) await wait(async () => {
          try { return !await host.gatewayRunning(plan); } catch { return false; }
        }, 'Gateway has not stopped');
        return result;
      }
      catch (error) {
        // The CLI uses exit 2 for its structured busy answer.
        if (error.code === 2) {
          const value = JSON.parse(error.stdout);
          if (value.stopped === false) return value;
        }
        throw error;
      }
    },
    async quit(plan) {
      const pid = plan.guiPid ?? guiPid;
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('Invalid GUI PID');
      await wait(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
      }, 'Original desktop has not exited');
    },
    async activate(plan) {
      if (transaction) throw new Error('Activation already attempted');
      if (await git(plan.root, ['rev-parse', 'HEAD']) !== plan.previous) throw new Error('Installed revision changed');
      if (await git(plan.root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Local changes appeared during staging');
      const backup = await fs.mkdtemp(path.join(plan.root, '.git', 'dshproxy-backup-'));
      transaction = { root: plan.root, previous: plan.previous, sha: plan.sha, backup, files: [], switched: false };
      const save = () => fs.writeFile(path.join(backup, 'transaction.json'), JSON.stringify(transaction), { mode: 0o600 });
      await save();
      // --ff-only never discards local changes; Git refuses overlapping edits.
      await git(plan.root, ['merge', '--ff-only', '--no-edit', plan.sha]);
      transaction.switched = true;
      await save();
      for (const name of [appName(), 'node_modules']) {
        const live = path.join(plan.root, name), staged = path.join(plan.stage, name);
        const item = { name, saved: false, installed: false };
        transaction.files.push(item);
        try {
          const stat = await fs.lstat(live);
          if (stat.isSymbolicLink()) throw new Error('Symlinked installed artifacts are unsupported');
          await fs.rename(live, path.join(backup, name));
          item.saved = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await save();
        await fs.rename(staged, live);
        item.installed = true;
        await save();
      }
    },
    async launch(plan) {
      session = crypto.randomBytes(24).toString('hex');
      const file = platform === 'darwin' ? path.join(plan.root, appName(), 'Contents', 'MacOS', 'DSHProxy') : path.join(plan.root, appName());
      resumeGateway = Boolean(plan.running);
      const [exe, ...args] = desktopCommand(file);
      launched = await spawn(exe, args, { cwd: plan.root, env: { ...process.env, DSHPROXY_UPDATE_SESSION: session, DSHPROXY_UPDATE_RESUME: resumeGateway ? '1' : '0' } });
    },
    async verify(plan) {
      if (!session || !launched) return false;
      const ready = path.join(plan.root, '.git', `dshproxy-ready-${session}`);
      try {
        await wait(async () => {
          if (launched.exitCode !== null || launched.signalCode !== null) throw new Error('Desktop exited before readiness');
          let revision;
          try { revision = (await fs.readFile(ready, 'utf8')).trim(); }
          catch (error) { if (error.code === 'ENOENT') return false; throw error; }
          if (revision !== plan.sha || await git(plan.root, ['rev-parse', 'HEAD']) !== plan.sha) throw new Error('Wrong desktop revision');
          try { return await host.gatewayRunning(plan) === Boolean(plan.running); }
          catch { return false; } // The gateway can be listening but still starting.
        }, 'Desktop readiness timed out');
        // Keep the acknowledgement as diagnostic evidence, scoped by nonce.
        return true;
      } catch { return false; }
    },
    async rollback(plan) {
      if (launched && resumeGateway && await host.gatewayRunning(plan)) {
        if ((await host.stopWhenIdle(plan)).stopped !== true) throw new Error('New gateway is busy; retaining backup');
        await wait(async () => !await host.gatewayRunning(plan), 'New gateway has not stopped');
      }
      await closeLaunched();
      if (!transaction) return;
      const current = await git(plan.root, ['rev-parse', 'HEAD']);
      if (![transaction.sha, transaction.previous].includes(current)) throw new Error('HEAD changed; retaining backup');
      // Unlike --hard, --keep aborts if the rollback would overwrite local edits.
      if (current !== transaction.previous) await git(plan.root, ['reset', '--keep', transaction.previous]);
      for (const item of [...transaction.files].reverse()) {
        if (item.installed) {
          await fs.rename(path.join(plan.root, item.name), path.join(transaction.backup, `failed-${item.name}`));
          item.installed = false;
        }
        if (item.saved) {
          try {
            await fs.lstat(path.join(plan.root, item.name));
            throw new Error('Artifact appeared during recovery; retaining backup');
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await fs.rename(path.join(transaction.backup, item.name), path.join(plan.root, item.name));
          item.saved = false;
        }
      }
      transaction = null;
    },
    async launchWorker(plan) {
      await host.preflight(plan);
      const child = await spawn(process.execPath, [path.join(__dirname, 'desktop-worker.js'), JSON.stringify({ ...plan, guiPid: plan.guiPid ?? guiPid })], {
        cwd: path.dirname(plan.root), env: { ...process.env, DSHPROXY_UPDATE_SESSION: '' },
      });
      return { pid: child.pid };
    },
  };
  return host;
}
module.exports = { createHost };
