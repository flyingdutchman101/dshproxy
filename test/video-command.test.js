const test = require('node:test');
const assert = require('node:assert/strict');
const {main} = require('../src/cli');
async function run(...args) { const lines=[]; await main(['video', ...args], x=>lines.push(x)); return JSON.parse(lines.join('\n')); }
test('invalid paid requests never reach a provider', async()=>{
  const {run: command}=require('../src/video/command'); let calls=0;
  const deps={env:{VIDEOROUTER_API_KEY:'unit-test-only',CALLIRRA_API_KEY:'unit-test-only'},fetchImpl:async()=>{calls++;throw new Error('unexpected call');}};
  for (const args of [ ['submit','wan-3.0','videorouter','--max-usd','0.226012','--confirm-charge','hello'], ['submit','wan-3.0','videorouter','--max-usd','1','--dry-run','hello'], ['submit','wan-3.0','videorouter','--max-usd','Infinity','--confirm-charge','hello'], ['submit','wan-3.0','videorouter','--max-usd','1','--confirm-charge','  '], ['submit','wan-3.0','callirra','--max-usd','1','--confirm-charge','hello'], ['submit','minimax-h3','callirra','--max-usd','1','--confirm-charge','hello'], ['submit','minimax-h3','callirra','--max-credits','9','--confirm-charge','hello'] ]) await assert.rejects(command(args,()=>{},deps));
  assert.equal(calls,0);
});
test('an explicit approved request submits once and retains its origin for status',async()=>{
  const {run: command}=require('../src/video/command'); const calls=[];let printed;
  const deps={env:{VIDEOROUTER_API_KEY:'unit-test-only'},fetchImpl:async(url,options)=>{calls.push([String(url),options.method]);return Response.json({id:'video_123',status:'queued'});}};
  const out=x=>{printed=JSON.parse(x);};
  await command(['submit','wan-3.0','videorouter','--max-usd','0.226013','--confirm-charge','A calm sea'],out,deps);
  assert.deepEqual([printed.model,printed.route,printed.id],['wan-3.0','videorouter','video_123']);
  await command(['status',printed.model,printed.route,printed.id],out,deps);
  assert.deepEqual(calls,[['https://videorouter.sh/api/v1/videos','POST'],['https://videorouter.sh/api/v1/videos/video_123','GET']]);
});
test('a Callirra credit approval cannot borrow another provider credential', async () => {
  const {run: command} = require('../src/video/command');
  const args = ['submit', 'minimax-h3', 'callirra', '--max-credits', '10', '--confirm-charge', 'A calm sea'];
  const env = {KOVAPI_API_KEY:'synthetic-kov'};
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.callirra.com/v1/videos');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-callirra');
    return Response.json({object:'video.job', job:{id:'vid_test', status:'queued', credits_reserved:'1000'}});
  };
  await assert.rejects(command(args, () => {}, {env, fetchImpl}), /Set CALLIRRA_API_KEY/);
  assert.equal(calls, 0);
  let result;
  await command(args, text => { result = JSON.parse(text); }, {env:{...env, CALLIRRA_API_KEY:'synthetic-callirra'}, fetchImpl});
  assert.equal(calls, 1);
  assert.equal(result.reservedCredits, 10);
  assert.equal(result.chargedUsd, undefined);
});
test('Krea handoff cannot generate or claim a quote', async()=>{ const q=await run('krea','wan-3.0'); assert.equal(q.contacted,false);assert.match(q.instructions,/preflight: true/);assert.equal(q.usdMicros,undefined); });
test('a promptless Krea quote refuses before workspace access, never a USD estimate', async () => {
  await assert.rejects(run('quote', 'wan-3.0', 'krea'), /workspace OAuth.*--prompt.*No request sent/i);
});
test('Krea workspace requests use the dedicated helper with an explicit prompt and native cap', async () => {
  const {run: command} = require('../src/video/command'); const calls=[]; const printed=[];
  const deps={workspace:async r=>{calls.push(r);return r.action==='quote'?{mode:'preflight',compute_units:3,available_compute_units:4,affordable:true,is_estimated:false}:{id:'abc',status:'queued'};}};
  for(const args of [['quote','wan-3.0','krea','--prompt','Rain'],['submit','wan-3.0','krea','--max-units','3.5','--confirm-charge','Rain'],['status','wan-3.0','krea','abc']]) await command(args,x=>printed.push(JSON.parse(x)),deps);
  assert.deepEqual(calls,[{action:'quote',model:'wan-3.0',prompt:'Rain'},{action:'submit',model:'wan-3.0',prompt:'Rain',maxUnits:3.5,confirmCharge:true},{action:'status',model:'wan-3.0',jobId:'abc'}]);
  assert.equal(printed[0].currency,'workspace_compute_units'); assert.equal(printed[0].estimatedUsd,undefined); assert.equal(printed[2].id,'abc');
  for(const args of [['submit','wan-3.0','krea','--max-usd','3','--confirm-charge','Rain'],['submit','wan-3.0','krea','--max-units','Infinity','--confirm-charge','Rain'],['status','wan-3.0','krea','../abc']]) await assert.rejects(command(args,()=>{},deps));
  assert.equal(calls.length,3);
});
test('real workspace helper with an empty temporary profile never starts login or falls back', async () => {
  const fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
  const {execFile}=require('node:child_process');const runChild=require('node:util').promisify(execFile);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dshproxy-empty-workspace-'));
  try {
    await assert.rejects(runChild(process.execPath,[path.resolve(__dirname,'../bin/dshproxy.js'),'video','quote','wan-3.0','krea','--prompt','Rain'],{env:{SystemRoot:process.env.SystemRoot,LOCALAPPDATA:dir,HOME:dir,USERPROFILE:dir,TEMP:dir,TMP:dir,NODE_PATH:process.env.NODE_PATH},timeout:10000}),e=>{assert.match(e.stderr,process.platform==='win32'?/sign-in required/i:/refused/i);assert.equal(e.stdout,'');return true;});
    assert.deepEqual(await fs.readdir(dir),[]);
  } finally {await fs.rmdir(dir);}
});
test('a Callirra quote states its native billing amount, not just effective USD', async () => {
  const q = await run('quote', 'minimax-h3', 'callirra');
  assert.deepEqual([q.currency, q.amount, q.estimatedUsd, q.budgetFlag], ['credits', 10, 0.099667, '--max-credits']);
});
test('the installed CLI exposes an offline route quote',async()=>{const q=await run('quote','wan-3.0');assert.equal(q.route,'videorouter');assert.equal(q.currency,'USD');assert.equal(q.usdMicros,226013);});
