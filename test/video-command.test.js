require("./support/keychain"); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
const test = require('node:test');
const assert = require('node:assert/strict');
// A command that is given no data folder uses the default one. For this file
// that is a throwaway folder, which must still be empty at the end: no test
// here may reach the real data folder.
const guard = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dshproxy-video-command-guard-'));
process.env.DSHPROXY_HOME = guard;
test.after(() => {
  try { assert.deepEqual(require('node:fs').readdirSync(guard), []); }
  finally { require('node:fs').rmSync(guard, {recursive:true, force:true}); }
});
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
test('disabled video workspace settings are not a direct CLI spend lock', async () => {
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'dshproxy-direct-video-'));
  try {
    const {run: command}=require('../src/video/command'); let calls=0, output;
    await command(['submit','wan-3.0','videorouter','--max-usd','0.226013','--confirm-charge','Test'],s=>output=JSON.parse(s),{env:{DSHPROXY_HOME:home,VIDEOROUTER_API_KEY:'fixture'},fetchImpl:async()=>{calls++;return Response.json({id:'job-1',status:'queued'});}});
    assert.equal(calls,1);assert.equal(output.id,'job-1');
  } finally {await fs.rm(home,{recursive:true,force:true});}
});
test('a Callirra credit approval cannot borrow another provider credential', async () => {
  const {run: command} = require('../src/video/command');
  const args = ['submit', 'minimax-h3', 'callirra', '--max-credits', '10', '--confirm-charge', 'A calm sea'];
  const env = {KOVAPI_API_KEY:'synthetic-kov', DSHPROXY_HOME:guard};
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
    await assert.rejects(runChild(process.execPath,[path.resolve(__dirname,'../bin/dshproxy.js'),'video','quote','wan-3.0','krea','--prompt','Rain'],{env:{SystemRoot:process.env.SystemRoot,LOCALAPPDATA:dir,HOME:dir,USERPROFILE:dir,TEMP:dir,TMP:dir,NODE_PATH:process.env.NODE_PATH,...(process.env.DSHPROXY_KEYCHAIN?{DSHPROXY_KEYCHAIN:process.env.DSHPROXY_KEYCHAIN}:{})},timeout:10000}),e=>{assert.match(e.stderr,/sign-in required/i);assert.equal(e.stdout,'');return true;});
    assert.deepEqual(await fs.readdir(dir),[]);
  } finally {await fs.rmdir(dir);}
});
test('video workspace settings persist explicit route choices without network access', async () => {
  const fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
  const {run: command}=require('../src/video/command');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'dshproxy-video-settings-'));
  try {
    const env={DSHPROXY_HOME:home}; let data;
    const exec=async (...args)=>{await command(args,s=>{data=JSON.parse(s)},{env,fetchImpl:()=>{throw Error('network is forbidden')}});return data;};
    assert.equal((await exec('settings')).models.find(m=>m.model==='wan-3.0').enabled,false);
    await exec('settings','set','wan-3.0','none','disabled');
    assert.equal((await exec('settings')).models.find(m=>m.model==='wan-3.0').route,null);
    await assert.rejects(exec('settings','set','wan-3.0','none','enabled'));
    await exec('settings','set','wan-3.0','krea','enabled');
    const row=(await exec('settings')).models.find(m=>m.model==='wan-3.0');
    assert.equal(row.enabled,true);assert.equal(row.route,'krea');assert.ok(row.routes.includes('krea'));
    await assert.rejects(exec('settings','set','wan-3.0','callirra','enabled'));
    assert.equal((await exec('settings')).models.find(m=>m.model==='wan-3.0').route,'krea');
  } finally {await fs.rm(home,{recursive:true,force:true});}
});
test('a Callirra quote states its native billing amount, not just effective USD', async () => {
  const q = await run('quote', 'minimax-h3', 'callirra');
  assert.deepEqual([q.currency, q.amount, q.estimatedUsd, q.budgetFlag], ['credits', 10, 0.099667, '--max-credits']);
});
test('the installed CLI exposes an offline route quote',async()=>{const q=await run('quote','wan-3.0');assert.equal(q.route,'videorouter');assert.equal(q.currency,'USD');assert.equal(q.usdMicros,226013);});

// ------------------------------- saved video API keys -------------------------------

const fsSync = require('node:fs'), osMod = require('node:os'), pathMod = require('node:path'), cryptoMod = require('node:crypto');
const {spawnSync} = require('node:child_process');
const KEY = 'synthetic-VKEY-7c1e9a_not.a-real+key/1=';
function keyHome(t) {
  const home = fsSync.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dshproxy-video-key-cli-'));
  t.after(() => fsSync.rmSync(home, {recursive:true, force:true}));
  return home;
}
// Stands in for secrets.loadMasterKey, the one place that calls Windows, with
// that function's contract. What it writes to master.key is a marker.
function testMasterKey() {
  const key = cryptoMod.randomBytes(32), calls = [];
  return {key, calls, load: async (file, {create=false}={}) => {
    calls.push({file, create});
    if (fsSync.existsSync(file)) return key;
    if (!create) return null;
    fsSync.writeFileSync(file, 'synthetic-wrapped-master-key\n');
    return key;
  }};
}
const noNetwork = async () => { throw new Error('network is forbidden in this test'); };
const keyRows = (states={}) => [
  {provider:'videorouter', label:'VideoRouter', variable:'VIDEOROUTER_API_KEY', routes:['videorouter','videorouter-replicate']},
  {provider:'kovapi', label:'KovAPI', variable:'KOVAPI_API_KEY', routes:['kovapi']},
  {provider:'callirra', label:'Callirra', variable:'CALLIRRA_API_KEY', routes:['callirra']},
  {provider:'elevenlabs', label:'ElevenLabs', variable:'ELEVENLABS_API_KEY', routes:['elevenlabs']},
  {provider:'yotta', label:'Yotta Labs', variable:'YOTTA_API_KEY', routes:['yotta']},
].map(row => ({...row, saved:false, readable:false, inEnvironment:false, ...states[row.provider]}));
function holdsKey(home, ...plain) {
  return fsSync.readdirSync(home).some(name => plain.some(value => fsSync.readFileSync(pathMod.join(home, name)).includes(value)));
}
// One command through the public seam. Collects everything it prints.
function session(t, options={}) {
  const home = keyHome(t), master = testMasterKey(), printed = [];
  const exec = async (args, extra={}) => {
    const lines = [];
    const {env:extraEnv, ...rest} = extra;
    try {
      await require('../src/video/command').run(args, s => lines.push(s), {env:{DSHPROXY_HOME:home, ...extraEnv}, fetchImpl:noNetwork, loadMasterKey:master.load, ...options, ...rest});
    } finally { printed.push(...lines); }
    return lines.join('\n');
  };
  return {home, master, printed, exec, json: async (...a) => JSON.parse(await exec(...a))};
}
const usage = /video key list.*video key set PROVIDER.*video key remove PROVIDER.*videorouter, kovapi, callirra/s;

test('video key list, set and remove print the documented JSON, and the key is in no output and no file', async (t) => {
  const s = session(t); const prompts = [];
  const readSecret = async (prompt) => { prompts.push(prompt); return KEY; };
  assert.deepEqual(await s.json(['key','list']), {providers:keyRows()});
  assert.deepEqual(fsSync.readdirSync(s.home), []);

  const text = await s.exec(['key','set','kovapi'], {readSecret});
  assert.deepEqual(JSON.parse(text), {provider:'kovapi', saved:true});
  assert.deepEqual(Object.keys(JSON.parse(text)), ['provider','saved']);
  assert.equal(prompts.length, 1); assert.match(prompts[0], /kovapi/); assert.equal(prompts[0].includes(KEY), false);

  const listed = await s.json(['key','list']);
  assert.deepEqual(listed, {providers:keyRows({kovapi:{saved:true, readable:true}})});
  assert.deepEqual(Object.keys(listed.providers[1]), ['provider','label','variable','routes','saved','readable','inEnvironment']);
  assert.deepEqual(await s.json(['key','list'], {env:{KOVAPI_API_KEY:'synthetic-ENV-kovapi', CALLIRRA_API_KEY:'  '}}), {providers:keyRows({kovapi:{saved:true, readable:true, inEnvironment:true}})});

  assert.deepEqual(fsSync.readdirSync(s.home).sort(), ['master.key','video-keys.json']);
  assert.equal(holdsKey(s.home, KEY, Buffer.from(KEY).toString('base64')), false);

  const removed = await s.exec(['key','remove','kovapi']);
  assert.deepEqual(JSON.parse(removed), {provider:'kovapi', saved:false, removed:true});
  assert.deepEqual(Object.keys(JSON.parse(removed)), ['provider','saved','removed']);
  assert.deepEqual(await s.json(['key','remove','kovapi']), {provider:'kovapi', saved:false, removed:false});
  assert.deepEqual(await s.json(['key','list']), {providers:keyRows()});
  assert.equal(s.printed.join('\n').includes(KEY), false);
  assert.equal(s.printed.join('\n').includes('synthetic-ENV-kovapi'), false);
});

test('a key command that is not exactly one of the three forms is refused with the usage line, before standard input is read', async (t) => {
  const s = session(t); let reads = 0;
  const readSecret = async () => { reads++; return KEY; };
  for (const args of [['key'], ['key','show'], ['key','list','extra'], ['key','set'], ['key','set','krea'], ['key','set','videorouter-replicate'], ['key','set','KovAPI'], ['key','set','kovapi','extra'],
    ['key','set',KEY], ['key','set','kovapi',KEY], ['key','set','--key',KEY], ['key','remove'], ['key','remove','nope'], ['key','remove',KEY], ['key','remove','kovapi','extra'], ['key','list','--json']]) {
    await assert.rejects(s.exec(args, {readSecret}), e => { assert.match(e.message, usage); assert.equal(e.message.includes(KEY), false); return true; }, args.join(' '));
  }
  assert.equal(reads, 0);
  assert.deepEqual(s.master.calls, []);
  assert.deepEqual(fsSync.readdirSync(s.home), []);
  assert.deepEqual(s.printed, []);
});

test('video key set with no key on standard input is refused with the usage line and saves nothing', async (t) => {
  const s = session(t);
  for (const readSecret of [async () => '', async () => '   \r\n', async () => undefined, undefined]) {
    await assert.rejects(s.exec(['key','set','callirra'], {readSecret}), e => { assert.match(e.message, /standard input/); assert.match(e.message, usage); return true; });
  }
  await assert.rejects(s.exec(['key','set','callirra'], {readSecret: async () => { throw new Error('synthetic stdin failure'); }}));
  assert.deepEqual(s.master.calls, []);
  assert.deepEqual(fsSync.readdirSync(s.home), []);
  assert.deepEqual(s.printed, []);
});

test('video key set refuses a key that is too long or has anything but printable ASCII inside, without repeating it', async (t) => {
  const s = session(t);
  for (const bad of ['synthetic BAD-key', 'synthetic\tBAD-key', 'synthetic\nBAD-key', 'synthetic\u0007BAD-key', 'synthetic-BAD-\u00fc', `synthetic-BAD-${'k'.repeat(499)}`]) {
    await assert.rejects(s.exec(['key','set','videorouter'], {readSecret: async () => bad}), e => { assert.match(e.message, /Nothing was saved/); assert.equal(e.message.includes('BAD'), false); return true; });
  }
  assert.deepEqual(JSON.parse(await s.exec(['key','set','videorouter'], {readSecret: async () => `  ${KEY}\r\n`})), {provider:'videorouter', saved:true});
  assert.deepEqual(JSON.parse(await s.exec(['key','set','kovapi'], {readSecret: async () => 'k'.repeat(512)})), {provider:'kovapi', saved:true});
  assert.equal(s.printed.join('\n').includes(KEY), false);
});

const submitArgs = (model, route, cap='--max-usd', amount='1') => ['submit', model, route, cap, amount, '--confirm-charge', 'A calm sea'];
function provider(replies) {
  const calls = [];
  return {calls, fetchImpl: async (url, init) => { calls.push({url:String(url), method:init.method, authorization:init.headers.Authorization}); return Response.json(replies[calls.length-1] ?? replies.at(-1)); }};
}

test('submit and status on an API route send the saved key when the variable is not set', async (t) => {
  const s = session(t);
  await s.exec(['key','set','videorouter'], {readSecret: async () => KEY});
  await s.exec(['key','set','callirra'], {readSecret: async () => 'synthetic-VKEY-callirra'});
  const p = provider([{id:'video_1', status:'queued'}]);
  const submitted = await s.json(submitArgs('wan-3.0','videorouter'), {fetchImpl:p.fetchImpl});
  assert.deepEqual([submitted.model, submitted.route, submitted.id], ['wan-3.0','videorouter','video_1']);
  await s.json(['status','wan-3.0','videorouter','video_1'], {fetchImpl:p.fetchImpl});
  // The second route of the same provider takes the same key.
  await s.json(submitArgs('wan-3.0','videorouter-replicate'), {fetchImpl:p.fetchImpl});
  assert.deepEqual(p.calls, [
    {url:'https://videorouter.sh/api/v1/videos', method:'POST', authorization:`Bearer ${KEY}`},
    {url:'https://videorouter.sh/api/v1/videos/video_1', method:'GET', authorization:`Bearer ${KEY}`},
    {url:'https://videorouter.sh/api/v1/videos', method:'POST', authorization:`Bearer ${KEY}`},
  ]);
  const c = provider([{object:'video.job', job:{id:'vid_1', status:'queued', credits_reserved:'1000'}}]);
  await s.json(submitArgs('minimax-h3','callirra','--max-credits','10'), {fetchImpl:c.fetchImpl});
  assert.deepEqual(c.calls, [{url:'https://api.callirra.com/v1/videos', method:'POST', authorization:'Bearer synthetic-VKEY-callirra'}]);
  assert.equal(s.printed.join('\n').includes(KEY), false);
  assert.equal(s.printed.join('\n').includes('synthetic-VKEY-callirra'), false);
});

test('the environment variable wins over a saved key, and a blank one does not count', async (t) => {
  const s = session(t);
  await s.exec(['key','set','kovapi'], {readSecret: async () => KEY});
  s.master.calls.length = 0;
  const p = provider([{id:'job_1', status:'queued'}]);
  await s.json(submitArgs('minimax-h3','kovapi'), {fetchImpl:p.fetchImpl, env:{KOVAPI_API_KEY:'synthetic-ENV-kovapi'}});
  await s.json(['status','minimax-h3','kovapi','job_1'], {fetchImpl:p.fetchImpl, env:{KOVAPI_API_KEY:'synthetic-ENV-kovapi'}});
  assert.deepEqual(p.calls.map(call => call.authorization), ['Bearer synthetic-ENV-kovapi','Bearer synthetic-ENV-kovapi']);
  assert.deepEqual(s.master.calls, []);
  await s.json(submitArgs('minimax-h3','kovapi'), {fetchImpl:p.fetchImpl, env:{KOVAPI_API_KEY:'   '}});
  await s.json(submitArgs('minimax-h3','kovapi'), {fetchImpl:p.fetchImpl, env:{KOVAPI_API_KEY:''}});
  assert.deepEqual(p.calls.slice(2).map(call => call.authorization), [`Bearer ${KEY}`,`Bearer ${KEY}`]);
});

test('with neither a variable nor a saved key, submit and status refuse before any request and name both ways to provide one', async (t) => {
  const s = session(t); let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({id:'job_1', status:'queued'}); };
  // A key saved for another provider is never borrowed.
  await s.exec(['key','set','kovapi'], {readSecret: async () => KEY});
  for (const [args, variable, name] of [[submitArgs('wan-3.0','videorouter'),'VIDEOROUTER_API_KEY','videorouter'], [['status','wan-3.0','videorouter-replicate','job_1'],'VIDEOROUTER_API_KEY','videorouter'],
    [submitArgs('minimax-h3','callirra','--max-credits','10'),'CALLIRRA_API_KEY','callirra'], [['status','minimax-h3','callirra','job_1'],'CALLIRRA_API_KEY','callirra']]) {
    await assert.rejects(s.exec(args, {fetchImpl, env:{KOVAPI_API_KEY:'synthetic-ENV-kovapi'}}), e => {
      assert.ok(e.message.includes(`Set ${variable}`)); assert.ok(e.message.includes(`video key set ${name}`)); assert.ok(e.message.includes('No request sent.'));
      assert.equal(e.message.includes(KEY), false); assert.equal(e.message.includes('synthetic-ENV-kovapi'), false); return true;
    });
  }
  assert.equal(calls, 0);
  assert.deepEqual(s.printed.filter(line => !line.includes('"saved": true')), []);
});

test('a saved key that cannot be read, or a damaged key file, refuses submit and status before any request', async (t) => {
  const s = session(t); let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({id:'job_1', status:'queued'}); };
  await s.exec(['key','set','kovapi'], {readSecret: async () => KEY});
  const stranger = testMasterKey();
  const cannotUnlock = async (file) => { throw new Error(`Windows could not unlock ${file}.`); };
  for (const loadMasterKey of [stranger.load, cannotUnlock]) {
    for (const args of [submitArgs('minimax-h3','kovapi'), ['status','minimax-h3','kovapi','job_1']]) {
      await assert.rejects(s.exec(args, {fetchImpl, loadMasterKey}), e => {
        assert.match(e.message, /saved kovapi key cannot be read/); assert.match(e.message, /Enter it again/); assert.ok(e.message.includes('video key set kovapi')); assert.ok(e.message.includes('No request sent.'));
        assert.equal(e.message.includes(KEY), false); return true;
      });
    }
  }
  assert.deepEqual((await s.json(['key','list'], {loadMasterKey:stranger.load})).providers[1], keyRows({kovapi:{saved:true, readable:false}})[1]);
  // The variable still works while the saved key does not.
  const p = provider([{id:'job_1', status:'queued'}]);
  await s.json(submitArgs('minimax-h3','kovapi'), {fetchImpl:p.fetchImpl, loadMasterKey:cannotUnlock, env:{KOVAPI_API_KEY:'synthetic-ENV-kovapi'}});
  assert.deepEqual(p.calls.map(call => call.authorization), ['Bearer synthetic-ENV-kovapi']);

  fsSync.writeFileSync(pathMod.join(s.home, 'video-keys.json'), '{"providers": {"kovapi": {"keyEnc": "synthetic-LEAK');
  for (const args of [submitArgs('minimax-h3','kovapi'), ['status','minimax-h3','kovapi','job_1'], ['key','list'], ['key','remove','kovapi']]) {
    await assert.rejects(s.exec(args, {fetchImpl}), e => { assert.match(e.message, /video-keys\.json/); assert.equal(e.message.includes('LEAK'), false); return true; });
  }
  await assert.rejects(s.exec(['key','set','kovapi'], {readSecret: async () => KEY}), /video-keys\.json/);
  assert.equal(calls, 0);
});

test('a request that is refused for its own reason never looks for a key, and a provider failure never repeats the saved key', async (t) => {
  const s = session(t); let loads = 0;
  const counting = async (...a) => { loads++; return s.master.load(...a); };
  for (const args of [submitArgs('wan-3.0','videorouter','--max-usd','0.226012'), submitArgs('wan-3.0','callirra'), submitArgs('minimax-h3','callirra','--max-credits','9'), ['status','wan-3.0','videorouter'], ['status','wan-3.0','nowhere','job_1']]) {
    await assert.rejects(s.exec(args, {loadMasterKey:counting}), e => { assert.doesNotMatch(e.message, /video key set [a-z]+`/); return true; });
  }
  assert.equal(loads, 0);
  await s.exec(['key','set','videorouter'], {readSecret: async () => KEY});
  for (const fetchImpl of [async () => { throw new Error(`upstream said ${KEY}`); }, async () => new Response(`denied for ${KEY}`, {status:401}), async () => Response.json({id:KEY, status:'queued'})]) {
    await assert.rejects(s.exec(submitArgs('wan-3.0','videorouter'), {fetchImpl}), e => { assert.match(e.message, /unconfirmed/); assert.equal(`${e.message}${e.stack}`.includes(KEY), false); return true; });
  }
  assert.equal(s.printed.join('\n').includes(KEY), false);
});

test('the help lists the three key commands and says a saved key or the variable provides the key', async () => {
  const lines = []; await require('../src/video/command').run(['help'], s => lines.push(s)); const help = lines.join('\n');
  for (const line of ['video key list', 'video key set PROVIDER', 'video key remove PROVIDER']) assert.ok(help.includes(line), line);
  assert.match(help, /standard input/);
  assert.match(help, /saved/i);
  for (const variable of ['VIDEOROUTER_API_KEY','KOVAPI_API_KEY','CALLIRRA_API_KEY']) assert.ok(help.includes(variable));
  assert.doesNotMatch(help, /Credentials: VIDEOROUTER_API_KEY, KOVAPI_API_KEY or CALLIRRA_API_KEY\./);
  assert.match(help, /Never pass keys on the command line/);
});

// The installed program, as the desktop app starts it: the key arrives on
// standard input and nowhere else.
function cli(home, args, input='') {
  const env = {...process.env, DSHPROXY_HOME:home};
  for (const name of ['VIDEOROUTER_API_KEY','KOVAPI_API_KEY','CALLIRRA_API_KEY']) delete env[name];
  return spawnSync(process.execPath, [pathMod.resolve(__dirname, '../bin/dshproxy.js'), 'video', ...args], {env, input, encoding:'utf8', windowsHide:true, timeout:60000});
}

test('the installed CLI lists the providers, and refuses a key command it cannot accept without saving or unlocking anything', (t) => {
  const home = keyHome(t);
  const listed = cli(home, ['key','list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), {providers:keyRows()});

  // Read from standard input: the refusal is about what arrived there.
  const inner = cli(home, ['key','set','kovapi'], 'synthetic BAD-key\r\n');
  assert.equal(inner.status, 1); assert.equal(inner.stdout, '');
  assert.match(inner.stderr, /^DSHProxy: A video API key cannot contain spaces/); assert.equal(inner.stderr.includes('BAD'), false);

  const empty = cli(home, ['key','set','kovapi'], '');
  assert.equal(empty.status, 1); assert.equal(empty.stdout, '');
  assert.match(empty.stderr, /standard input/); assert.match(empty.stderr, usage);

  // A key on the command line is refused although a valid one waits on standard input.
  const onCommandLine = cli(home, ['key','set','kovapi',KEY], `${KEY}\n`);
  assert.equal(onCommandLine.status, 1); assert.equal(onCommandLine.stdout, '');
  assert.match(onCommandLine.stderr, usage); assert.equal(onCommandLine.stderr.includes(KEY), false);

  const unknown = cli(home, ['key','remove','krea']);
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, usage);
  assert.deepEqual(fsSync.readdirSync(home), []);
});

// The one test that lets Windows wrap a real master key, as
// test/backend.test.js does, in a throwaway data folder.
test('end to end with a real master key: a key given on standard input is saved, listed as readable, and appears in no output and no file', (t) => {
  const home = keyHome(t);
  const set = cli(home, ['key','set','kovapi'], `${KEY}\r\n`);
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout), {provider:'kovapi', saved:true});
  const listed = cli(home, ['key','list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), {providers:keyRows({kovapi:{saved:true, readable:true}})});

  assert.deepEqual(fsSync.readdirSync(home).sort(), ['master.key','video-keys.json']);
  assert.equal(holdsKey(home, KEY, Buffer.from(KEY).toString('base64'), Buffer.from(KEY).toString('hex')), false);
  const saved = JSON.parse(fsSync.readFileSync(pathMod.join(home, 'video-keys.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.providers), ['kovapi']); assert.deepEqual(Object.keys(saved.providers.kovapi), ['keyEnc']);

  const removed = cli(home, ['key','remove','kovapi']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(removed.stdout), {provider:'kovapi', saved:false, removed:true});
  assert.deepEqual(JSON.parse(cli(home, ['key','list']).stdout), {providers:keyRows()});
  for (const run of [set, listed, removed]) assert.equal(`${run.stdout}${run.stderr}`.includes(KEY), false);
});

// The sign-in and its token stay in the separate helper process.
test('the routing CLI never loads the Krea helper modules', () => {
  const dir = pathMod.resolve(__dirname, '../src/video');
  const files = [pathMod.resolve(__dirname, '../src/cli.js'), ...fsSync.readdirSync(dir).filter(name => name.endsWith('.js')).map(name => pathMod.join(dir, name))];
  assert.ok(files.length >= 7);
  for (const file of files) assert.doesNotMatch(fsSync.readFileSync(file, 'utf8'), /krea-helper/, file);
  // And in practice: loading every one of them brings no helper module with it.
  const script = `for (const file of ${JSON.stringify(files)}) require(file); process.stdout.write(JSON.stringify(Object.keys(require.cache).filter(name => /krea-helper|dshproxy-krea/.test(name))));`;
  const loaded = spawnSync(process.execPath, ['-e', script], {env:{...process.env, DSHPROXY_HOME:guard}, encoding:'utf8', windowsHide:true});
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.deepEqual(JSON.parse(loaded.stdout), []);
});
