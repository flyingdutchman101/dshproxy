'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHost } = require('../src/self-update/desktop-host');
const exec = promisify(execFile);
const net = require('node:net');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dshproxy-host-test-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('dshproxy-host-test-')); await fs.rm(root, { recursive: true, force: true }); });
  const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(root, '.gitignore'), 'DSHProxy.app/\nDSHProxy.exe\nnode_modules/\nstage/\n');
  await fs.writeFile(path.join(root, 'tracked'), 'old\n');
  await fs.writeFile(path.join(root, 'unrelated'), 'unchanged\n');
  await git('add', '.'); await git('commit', '-m', 'old'); const previous = await git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(root, 'tracked'), 'new\n'); await git('commit', '-am', 'new'); const sha = await git('rev-parse', 'HEAD');
  await git('checkout', '--detach', previous);
  const stage = path.join(root, 'stage'); await fs.mkdir(stage);
  for (const base of [root, stage]) {
    await fs.mkdir(path.join(base, 'DSHProxy.app'));
    await fs.writeFile(path.join(base, 'DSHProxy.app', 'version'), base === root ? 'old app' : 'new app');
    await fs.mkdir(path.join(base, 'node_modules'));
    await fs.writeFile(path.join(base, 'node_modules', 'version'), base === root ? 'old deps' : 'new deps');
  }
  return { root, stage, previous, sha, platform: 'darwin', git };
}
test('fast-forward swaps staged app and modules; safe rollback preserves unrelated edits and backups', async t => {
  const plan = await fixture(t), host = createHost({ platform: 'darwin' });
  await host.activate(plan);
  assert.equal(await plan.git('rev-parse', 'HEAD'), plan.sha);
  assert.equal(await fs.readFile(path.join(plan.root, 'DSHProxy.app/version'), 'utf8'), 'new app');
  await fs.writeFile(path.join(plan.root, 'unrelated'), 'local edit\n');
  await host.rollback(plan);
  assert.equal(await plan.git('rev-parse', 'HEAD'), plan.previous);
  assert.equal(await fs.readFile(path.join(plan.root, 'unrelated'), 'utf8'), 'local edit\n');
  assert.equal(await fs.readFile(path.join(plan.root, 'node_modules/version'), 'utf8'), 'old deps');
  const backups = (await fs.readdir(path.join(plan.root, '.git'))).filter(x => x.startsWith('dshproxy-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(plan.root, '.git', backups[0], 'failed-DSHProxy.app/version'), 'utf8'), 'new app');
});
test('Windows activation swaps executable and dependencies and can roll back', async t => {
  const plan = await fixture(t), host = createHost({platform:'win32'});
  await fs.writeFile(path.join(plan.root, 'DSHProxy.exe'), 'old executable');
  await fs.writeFile(path.join(plan.stage, 'DSHProxy.exe'), 'new executable');
  await host.activate(plan);
  assert.equal(await fs.readFile(path.join(plan.root, 'DSHProxy.exe'), 'utf8'), 'new executable');
  await host.rollback(plan);
  assert.equal(await fs.readFile(path.join(plan.root, 'DSHProxy.exe'), 'utf8'), 'old executable');
  assert.equal(await fs.readFile(path.join(plan.root, 'node_modules/version'), 'utf8'), 'old deps');
});
test('rollback refuses to destroy overlapping local changes', async t => {
  const plan = await fixture(t), host = createHost({ platform: 'darwin' });
  await host.activate(plan);
  await fs.writeFile(path.join(plan.root, 'tracked'), 'user work\n');
  await assert.rejects(host.rollback(plan));
  assert.equal(await fs.readFile(path.join(plan.root, 'tracked'), 'utf8'), 'user work\n');
  assert.equal(await plan.git('rev-parse', 'HEAD'), plan.sha);
});
test('partial artifact activation restores originals without deleting stage', async t => {
  const plan = await fixture(t), host = createHost({ platform: 'darwin' });
  await fs.rename(path.join(plan.stage, 'node_modules'), path.join(plan.stage, 'missing-modules'));
  await assert.rejects(host.activate(plan));
  await host.rollback(plan);
  assert.equal(await fs.readFile(path.join(plan.root, 'node_modules/version'), 'utf8'), 'old deps');
  assert.equal(await fs.readFile(path.join(plan.root, 'DSHProxy.app/version'), 'utf8'), 'old app');
  assert.equal(await plan.git('rev-parse', 'HEAD'), plan.previous);
});
test('quit waits for the supplied GUI without terminating it', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  await new Promise(resolve => child.once('spawn', resolve));
  t.after(() => child.kill());
  const host = createHost({ timeoutMs: 50, pollMs: 5 });
  await assert.rejects(host.quit({ guiPid: child.pid }), /has not exited/);
  assert.equal(child.exitCode, null);
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
  await host.quit({ guiPid: child.pid });
});
test('gatewayRunning refuses an unresponsive listener instead of treating it as stopped', async t => {
  const plan = await fixture(t);
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await fs.mkdir(path.join(plan.root, 'bin'));
  await fs.writeFile(path.join(plan.root, 'bin/dshproxy.js'), `console.log(JSON.stringify({running:false,origin:'http://127.0.0.1:${server.address().port}'}))`);
  await assert.rejects(createHost().gatewayRunning(plan), /unknown|Unknown/);
});
test('launch passes unique nonce and verifies exact HEAD acknowledgement; rollback closes only its child', async t => {
  const plan = await fixture(t);
  await plan.git('checkout', '--detach', plan.sha);
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await fs.mkdir(path.join(plan.root, 'bin'));
  await fs.writeFile(path.join(plan.root, 'bin/dshproxy.js'), `console.log(JSON.stringify({running:false,origin:'http://127.0.0.1:${port}'}))`);
  const executable = path.join(plan.root, 'DSHProxy.app/Contents/MacOS/DSHProxy');
  await fs.mkdir(path.dirname(executable), {recursive:true});
  await fs.writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'); const nonce=process.env.DSHPROXY_UPDATE_SESSION; fs.writeFileSync('.git/dshproxy-ready-'+nonce, ${JSON.stringify(plan.sha)}); setInterval(()=>{},1000);`, {mode:0o755});
  const host = createHost({platform:'darwin', timeoutMs:5000, pollMs:10, desktopCommand:file=>[process.execPath,file]});
  t.after(() => host.rollback(plan));
  await host.launch({...plan, running:false});
  assert.equal(await host.gatewayRunning(plan), false);
  const verified = await host.verify({...plan, running:false});
  const acknowledgements = (await fs.readdir(path.join(plan.root, '.git'))).filter(x => x.startsWith('dshproxy-ready-'));
  assert.equal(acknowledgements.length, 1, 'Launched fixture must write an acknowledgement');
  assert.equal(verified, true);
  assert.equal(await host.verify({...plan, sha:plan.previous, running:false}), false);
  await host.rollback(plan);
  assert.equal(await host.verify({...plan, running:false}), false);
  const ready = (await fs.readdir(path.join(plan.root, '.git'))).filter(x => x.startsWith('dshproxy-ready-'));
  assert.equal(ready.length, 1);
  assert.match(ready[0], /^dshproxy-ready-[a-f0-9]{48}$/);
});
test('running relaunch delegates gateway ownership to the new desktop, not the worker', async t => {
  const plan = await fixture(t);
  const probe=net.createServer(); await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port; await new Promise(resolve=>probe.close(resolve));
  await fs.mkdir(path.join(plan.root,'bin'));
  await fs.writeFile(path.join(plan.root,'bin/dshproxy.js'), `const fs=require('fs'); if(process.argv[2]==='status')console.log(JSON.stringify({running:fs.existsSync('gateway-owner'),origin:'http://127.0.0.1:${port}'})); else if(process.argv[2]==='stop'){fs.unlinkSync('gateway-owner');console.log('{"stopped":true}')}else process.exit(2);`);
  const gui = path.join(plan.root,'gui.cjs');
  await fs.writeFile(gui, `const fs=require('fs');fs.writeFileSync('gui-pid',String(process.pid)); if(process.env.DSHPROXY_UPDATE_RESUME==='1')require('child_process').execFileSync(process.execPath,['-e',"require('fs').writeFileSync('gateway-owner',String(process.ppid))"]);fs.writeFileSync('.git/dshproxy-ready-'+process.env.DSHPROXY_UPDATE_SESSION,${JSON.stringify(plan.previous)});setInterval(()=>{},1000);`);
  const host=createHost({platform:'darwin',timeoutMs:5000,pollMs:10,desktopCommand:()=>[process.execPath,gui]});
  const running={...plan,sha:plan.previous,running:true};
  await host.launch(running);
  try {
    assert.equal(await host.verify(running),true);
    assert.equal(await fs.readFile(path.join(plan.root,'gateway-owner'),'utf8'),await fs.readFile(path.join(plan.root,'gui-pid'),'utf8'));
  } finally {await host.rollback(plan);}
});
test('activation refuses edits made while the stage was building', async t => {
  const plan = await fixture(t), host = createHost({ platform: 'darwin' });
  await fs.writeFile(path.join(plan.root, 'unrelated'), 'user work');
  await assert.rejects(host.activate(plan), /Local changes/);
  assert.equal(await plan.git('rev-parse', 'HEAD'), plan.previous);
});
