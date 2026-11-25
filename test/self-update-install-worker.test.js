'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {runInstall} = require('../src/self-update/install-worker');
const {preflight, readResult, createInstaller} = require('../src/self-update/install');
async function fixture(t, platform = 'win32') {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-worker-')));
  t.after(() => fs.rm(base, {recursive:true, force:true}));
  const root = path.join(base, 'install'); await fs.mkdir(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
  git('init'); git('config','user.email','fixture@example.invalid'); git('config','user.name','Fixture');
  await fs.mkdir(path.join(root,'bin')); await fs.writeFile(path.join(root,'bin/dshproxy.js'),'');
  await fs.writeFile(path.join(root,'package-lock.json'),'{}');
  await fs.writeFile(path.join(root,platform === 'darwin' ? 'DSHProxy.app' : 'DSHProxy.exe'),'old');
  await fs.writeFile(path.join(root,'revision'),'old'); git('add','.'); git('commit','-m','old');
  const previous = git('rev-parse','HEAD');
  await fs.writeFile(path.join(root,'revision'),'new'); git('commit','-am','new');
  const sha = git('rev-parse','HEAD'); git('checkout','--detach',previous);
  return {root, sha, previous, platform, git};
}
function host(f, failure, running = true) {
  const events = [];
  return {events,
    async preflight() {},
    async build({stage,sha}) { assert.equal(execFileSync('git',['-C',stage,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),sha); events.push('build'); if(failure==='build') throw Error(); },
    async gatewayRunning() {return running;},
    async stopWhenIdle() {events.push('idle'); return {stopped:failure!=='busy'};},
    async quit() {events.push('quit');},
    async activate({sha}) {events.push('activate'); f.git('checkout','--detach',sha); if(failure==='activate') throw Error();},
    async launch({sha,running}) {events.push(`launch:${sha}:${running}`);},
    async verify({sha}) {events.push('verify'); return failure !== 'recovery' && !(failure==='verify' && sha===f.sha);},
    async rollback({previous}) {events.push('rollback'); f.git('checkout','--detach',previous);},
  };
}
for (const platform of ['win32','darwin']) {
  for (const failure of [null,'build','busy','activate','verify','recovery']) {
    test(`${platform} transaction ${failure || 'success'}`, async t => {
      const f = await fixture(t,platform); const h = host(f,failure);
      const result = await runInstall(f,h);
      const expected = !failure ? 'succeeded' : ['build','busy'].includes(failure) ? 'failed' : failure==='recovery' ? 'recovery-failed' : 'recovered';
      assert.equal(result.status,expected);
      assert.deepEqual(await readResult(f),result);
      assert.equal(f.git('rev-parse','HEAD'),!failure ? f.sha : f.previous);
      if(['build','busy'].includes(failure)) assert.ok(!h.events.includes('quit'));
      if(!failure) assert.ok(h.events.indexOf('build') < h.events.indexOf('idle'));
    });
  }
}
test('preflight refuses ignored local files that candidate checkout would overwrite', async t => {
  const f = await fixture(t);
  f.git('checkout','--detach',f.sha);
  await fs.writeFile(path.join(f.root,'incoming'),'candidate');
  f.git('add','incoming'); f.git('commit','-m','incoming file');
  const sha = f.git('rev-parse','HEAD'); f.git('checkout','--detach',f.previous);
  await fs.writeFile(path.join(f.root,'.git/info/exclude'),'incoming\n');
  await fs.writeFile(path.join(f.root,'incoming'),'local ignored data');
  await assert.rejects(preflight({...f,sha}),/ignored local/i);
});
test('preflight rejects dirty and downgrade layouts',async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root,'revision'),'local');
  await assert.rejects(preflight(f), /Local modifications/);
  f.git('checkout','--','revision'); f.git('checkout','--detach',f.sha);
  await assert.rejects(preflight({...f,sha:f.previous}),/downgrade/);
});
test('default host refuses unverifiable relaunch; stopped gateway stays stopped',async t => {
  const f = await fixture(t);
  assert.equal((await createInstaller({platform:'win32'}).startInstall(f)).status,'unavailable');
  const h = host(f,null,false);
  assert.equal((await runInstall(f,h)).status,'succeeded');
  assert.ok(!h.events.includes('idle'));
  assert.ok(h.events.includes(`launch:${f.sha}:false`));
});
