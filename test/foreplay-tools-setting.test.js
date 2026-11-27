const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('../src/provider-picker/foreplay-tools');
const picker = require('../src/provider-picker/settings');
test('persisted any-chat and picker toggles are independent; pending approval is revoked', async () => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreplay-policy-'));
 try {
  const {foreplayAllowed} = await import('../integrations/dsh-video/lib/foreplay-policy.js');
  const {build} = await import('../integrations/dsh-video/index.js');
  const host={bundleDir:path.resolve('integrations/dsh-video'),execPath:process.execPath,versions:process.versions,platform:process.platform,env:{}};
  const registered=()=>build({home,foreplayEnabled:true},host).filter(t=>t.name.startsWith('foreplay_')).length;
  assert.equal(registered(),2);
  assert.equal(tools.enabled(home), false);
  assert.equal(foreplayAllowed(home,true), true);
  await tools.set(home,false);
  assert.equal(foreplayAllowed(home,true), false);
  assert.equal(registered(),0);
  await picker.set(home,true);
  assert.equal(tools.enabled(home),false);
  await tools.set(home,true);
  await picker.set(home,false);
  assert.equal(tools.enabled(home),true);
  assert.equal(picker.enabled(home),false);
  const {createForeplayTools} = await import('../integrations/dsh-video/lib/foreplay.js');
  let approve; let calls=0;
  const [search] = createForeplayTools(async()=>{calls++;}, {allowed:()=>foreplayAllowed(home,true),questions:()=>({ask:()=>new Promise(resolve=>{approve=resolve;})})});
  const pending=search.execute({query:'hello'},{agent:{}});
  await tools.set(home,false);
  approve({answers:[{id:'dshproxy-foreplay',selected:['Run once']}]});
  await assert.rejects(pending,/disabled/);
  await assert.rejects(search.execute({query:'hello'},{agent:{}}),/disabled/);
  assert.equal(calls,0);
  assert.equal(picker.enabled(home),false);
 } finally { fs.rmSync(home,{recursive:true,force:true}); }
});
