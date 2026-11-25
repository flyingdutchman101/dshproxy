'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const MANUAL = 'Update manually from the official repository after closing DSHProxy; keep your existing data folder.';
const git = async (root, args) => (await exec('git', ['-C', root, ...args], { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout.trim();
async function preflight({ root, sha, platform = process.platform }) {
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('An exact 40-character commit SHA is required.');
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Only Mac and Windows desktop installations are supported.');
  root = path.resolve(root);
  if (await fs.realpath(root) !== root) throw new Error('Symlinked install folders are unsupported.');
  if (!(await fs.lstat(path.join(root, '.git'))).isDirectory()) throw new Error('Linked worktrees are unsupported.');
  if (path.resolve(await git(root, ['rev-parse', '--show-toplevel'])) !== root) throw new Error('The install must be the Git root.');
  if (await git(root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Local modifications or untracked files must be saved before updating.');
  if (await git(root, ['submodule', 'status'])) throw new Error('Submodule layouts are unsupported.');
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    try { await fs.access(path.join(root, '.git', marker)); } catch { continue; }
    throw new Error('Finish the in-progress Git operation before updating.');
  }
  const previous = await git(root, ['rev-parse', 'HEAD']);
  if (await git(root, ['rev-parse', `${sha}^{commit}`]) !== sha) throw new Error('Candidate is not the exact commit.');
  if (previous === sha) throw new Error('This revision is already installed.');
  try { await git(root, ['merge-base', '--is-ancestor', previous, sha]); } catch { throw new Error('Refusing a downgrade or divergent update.'); }
  const ignored = (await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).split('\0').filter(Boolean);
  const incoming = (await git(root, ['ls-tree', '-r', '--name-only', '-z', sha])).split('\0').filter(Boolean);
  const fold = name => name.replace(/\/$/, '').toLowerCase(); // Supported desktops commonly use case-insensitive volumes.
  if (ignored.some(local => incoming.some(file => {
    local = fold(local); file = fold(file);
    return local === file || local.startsWith(`${file}/`) || file.startsWith(`${local}/`);
  }))) throw new Error('The candidate would overwrite ignored local files.');
  const app = platform === 'darwin' ? 'DSHProxy.app' : 'DSHProxy.exe';
  for (const name of ['package-lock.json', 'bin/dshproxy.js', app]) await fs.access(path.join(root, name));
  await fs.access(root, 2);
  await fs.access(path.dirname(root), 2);
  const disk = await fs.statfs(root);
  if (Number(disk.bavail) * Number(disk.bsize) < 2 * 1024 ** 3) throw new Error('At least 2 GiB of free staging space is required.');
  return { root, sha, previous, platform, app };
}
// A host must supply a cooperative desktop lifecycle, including an authenticated
// readiness acknowledgement. Merely spawning/opening a process is NOT success.
// Existing desktop versions have no such protocol, so default installation is
// deliberately unavailable rather than guessing PIDs or force-killing apps.
function createInstaller(host) {
  return {
    async startInstall(options) {
      try {
        const plan = {...await preflight({ ...options, platform: host?.platform || process.platform }), guiPid: options.guiPid, ownsGateway:options.ownsGateway};
        if (!host?.launchWorker || !host?.preflight) throw new Error('This desktop does not support verified quit/relaunch for self-update yet.');
        await host.preflight(plan);
        if (host.platform && options.guiPid) {
          // Keep the desktop and its gateway pipes alive through staging and drain.
          // Each request has its own mailbox, including simultaneous/losing requests.
          plan.mailbox = await fs.mkdtemp(path.join(plan.root, '.git', 'dshproxy-handoff-'));
          plan.clientPid = process.pid;
          const child = await host.launchWorker(plan);
          const until = Date.now() + 22 * 60 * 1000;
          while (Date.now() < until) {
            try { return JSON.parse(await fs.readFile(path.join(plan.mailbox,'reply'), 'utf8')); }
            catch (e) { if (e.code !== 'ENOENT') throw e; }
            process.kill(child.pid, 0);
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          throw Error('Timed out waiting for the staged build. Check gateway status before retrying.');
        }
        await host.launchWorker(plan);
        return {status:'started', message:'Verified build is ready to activate.'};
      } catch (error) {
        // Do not surface subprocess stdout/stderr: it can contain local secrets.
        const message = error.code ? 'The installation layout or a required tool is unavailable.' : error.message;
        return { status: 'unavailable', message: `${message} ${MANUAL}` };
      }
    },
    readResult,
  };
}
async function readResult({ root }) {
  try {
    const result = JSON.parse(await fs.readFile(path.join(root, '.git', 'dshproxy-update-result.json'), 'utf8'));
    if (!['started', 'succeeded', 'failed', 'recovered', 'recovery-failed', 'unavailable'].includes(result.status) || typeof result.message !== 'string') throw new Error('Invalid result');
    return { status: result.status, message: result.message };
  } catch { return { status: 'unavailable', message: 'No completed self-update result is available.' }; }
}
async function startInstall(options) {
  const {root, sha} = options;
  if (!/^[a-f0-9]{40}$/.test(sha || '')) return {status:'unavailable', message:'An exact commit SHA is required.'};
  // Fetch from the fixed project URL rather than a configurable fork/remote. Fetch
  // only after confirmation, without touching the working tree or the user's branch.
  try {
    if (!['win32','darwin'].includes(process.platform) || !(await fs.lstat(path.join(root,'.git'))).isDirectory()) throw Error();
    await git(root,['fetch','--no-tags','--no-write-fetch-head','https://github.com/flyingdutchman101/dshproxy.git',sha]);
  } catch { return {status:'unavailable',message:`Could not fetch the checked revision into a supported Git checkout. ${MANUAL}`}; }
  return createInstaller(require('./desktop-host').createHost()).startInstall(options);
}
module.exports = { startInstall, readResult, createInstaller, preflight };
