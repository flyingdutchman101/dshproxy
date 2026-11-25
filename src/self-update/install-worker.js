'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { preflight } = require('./install');
const exec = promisify(execFile);
const git = (root, args) => exec('git', ['-C', root, ...args], {timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024});

// This transaction is host-independent. Host methods are OS/process boundaries,
// not policy: stopWhenIdle must use the gateway's atomic idle-stop command;
// verify must acknowledge the exact app revision and, if requested, gateway health.
async function runInstall(plan, host) {
  let stage, locked = false, stopped = false, activated = false, quit = false;
  let wasRunning = false;
  const lock = path.join(plan.root, '.git', 'dshproxy-update.lock');
  const resultPath = path.join(plan.root, '.git', 'dshproxy-update-result.json');
  const record = async (status, message) => {
    const value = {status, message};
    const temporary = `${resultPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), {mode: 0o600});
    await fs.rename(temporary, resultPath);
    return value;
  };
  try {
    for (const method of ['preflight', 'build', 'gatewayRunning', 'stopWhenIdle', 'quit', 'activate', 'launch', 'verify', 'rollback']) {
      if (typeof host?.[method] !== 'function') throw new Error('Incomplete desktop lifecycle adapter');
    }
    await fs.mkdir(lock); locked = true;
    const fresh = await preflight(plan);
    if (fresh.previous !== plan.previous) throw new Error('Installed revision changed');
    await host.preflight({...fresh, guiPid:plan.guiPid, worker:true});
    await record('started', 'Staging the exact approved revision.');
    stage = await fs.mkdtemp(path.join(path.dirname(plan.root), '.dshproxy-stage-'));
    await exec('git', ['clone', '--no-hardlinks', '--no-checkout', '--', plan.root, stage], {timeout:120000, windowsHide:true});
    await git(stage, ['checkout', '--detach', plan.sha]);
    await host.build({...fresh, stage});
    // The potentially long build must not allow edits made meanwhile to be lost.
    const recheck = await preflight(plan);
    if (recheck.previous !== plan.previous) throw new Error('Installed revision changed during staging');
    wasRunning = await host.gatewayRunning(plan);
    if (typeof wasRunning !== 'boolean') throw new Error('Gateway state is unknown');
    if (wasRunning && plan.ownsGateway === false) return await record('failed', 'The running gateway was started outside this desktop. Stop it from its owner, then check again.');
    if (plan.clientPid) process.kill(plan.clientPid, 0); // confirmation is still waiting
    if (wasRunning) {
      let outcome;
      try { outcome = await host.stopWhenIdle(plan); }
      catch (error) {
        // The response can disappear during shutdown. Only a confirmed closed
        // listener lets us proceed and restore the previous running state.
        if (await host.gatewayRunning(plan) !== false) throw error;
        outcome = {stopped:true};
      }
      if (outcome?.stopped !== true) throw new Error('Gateway remained busy; installation was not switched');
      stopped = true;
    }
    // Mark uncertain side effects before awaiting: rollback must also handle
    // partially completed quit/activation, not only fulfilled promises.
    quit = true;
    await host.quit(plan);
    activated = true;
    await host.activate({...plan, stage});
    await host.launch({...plan, running: wasRunning});
    if (await host.verify({...plan, running: wasRunning}) !== true) throw new Error('Activation could not be verified');
    // Activation moved the app and dependencies out; discard the disposable clone
    // only after verification. Failed stages and rollback backups remain available.
    if (path.dirname(stage) === path.dirname(plan.root) && path.basename(stage).startsWith('.dshproxy-stage-') &&
        await fs.realpath(stage) === stage) await fs.rm(stage, {recursive:true,force:false}).catch(() => {});
    return await record('succeeded', `DSHProxy updated to ${plan.sha.slice(0, 12)} and verified.`);
  } catch {
    if (!locked) return {status:'unavailable', message:'Another update is in progress or the update lock is unavailable.'};
    if (activated || quit || stopped) {
      try {
        if (activated) await host.rollback({...plan, stage});
        await host.launch({...plan, sha: plan.previous, running: wasRunning});
        if (await host.verify({...plan, sha: plan.previous, running: wasRunning}) !== true) throw new Error('Recovery verification failed');
        return await record('recovered', 'Update failed; the previous app and gateway state were restored and verified.');
      } catch {
        return await record('recovery-failed', 'Update failed and recovery could not be verified. Keep the staging/backup files and recover manually.');
      }
    }
    return await record('failed', 'Update could not be staged or the gateway remained busy. The installed revision was not switched.');
  } finally {
    // Staging is deliberately retained for diagnostics/recovery; never recursively
    // remove a computed installation path. Only remove our empty lock directory.
    if (locked) await fs.rmdir(lock);
  }
}

// Entrypoint must be a trusted host-owned worker that binds runInstall to native
// lifecycle operations. A candidate checkout must never supply that adapter.
async function launchDetached({entrypoint, plan}) {
  const child = spawn(process.execPath, [entrypoint, JSON.stringify(plan)], {
    cwd: path.dirname(plan.root), detached: true, stdio: 'ignore', windowsHide: true,
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}
module.exports = { runInstall, launchDetached };
