'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {run} = require('../src/voice/command');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const env = {ELEVENLABS_API_KEY:'synthetic-test-key'};
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'voice-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const input=path.join(dir,'input'); await fs.writeFile(input,'Hello');
  return {dir,input,output:path.join(dir,'output')};
}
function paid(action,model,f,extra=[]) {return [action,model,'--input',f.input,'--output',f.output,'--confirm-charge',...extra];}

test('offline catalog describes supported REST and WebSocket transports', async () => {
  let data;
  await run(['list'], x => {data=JSON.parse(x);}, {env:{}, fetchImpl:()=>assert.fail('network')});
  assert.equal(data.models.length, 8);
  assert.equal(data.models.find(x=>x.id==='eleven_v4').supported, true);
  assert.equal(data.models.find(x=>x.id==='scribe_v3_live').supported, true);
  assert.equal(data.models.find(x=>x.id==='eleven_v4_turbo').supported, true);
});

test('voices search and pick use bounded v2 listing and preserve pagination', async () => {
  const urls=[]; let shown;
  const context={env,fetchImpl:async(url,opts)=>{
    urls.push(new URL(url)); assert.equal(opts.redirect,'error'); assert.equal(opts.headers['xi-api-key'],'synthetic-test-key');
    return Response.json({voices:[{voice_id:'voice123',name:'Example',private_field:'omit'}],has_more:true,next_page_token:'next'});
  }};
  await run(['voices','--search','warm voice','--page-token','old'],x=>shown=JSON.parse(x),context);
  assert.equal(urls[0].pathname,'/v2/voices'); assert.equal(urls[0].searchParams.get('search'),'warm voice');
  assert.equal(shown.next_page_token,'next'); assert.equal(shown.voices[0].private_field,undefined);
  await run(['pick','voice123'],x=>shown=JSON.parse(x),context);
  assert.equal(urls[1].searchParams.get('voice_ids'),'voice123'); assert.equal(shown.voice.voice_id,'voice123');
});
for (const model of ['eleven_v4','eleven_flash_v2','eleven_flash_v2_5']) test(`TTS ${model} sends official schema and saves private MP3`,async t=>{
  const f=await fixture(t); let calls=0;
  await run(['tts',model,'--text-file',f.input,'--voice','voice123','--output',f.output,'--confirm-charge'],()=>{}, {env,fetchImpl:async(url,o)=>{
    calls++; const data=JSON.parse(o.body); assert.equal(data.model_id,model);
    assert.equal(new URL(url).pathname, model==='eleven_v4'?'/v1/text-to-dialogue':'/v1/text-to-speech/voice123');
    assert.deepEqual(data,model==='eleven_v4'?{model_id:model,inputs:[{text:'Hello',voice_id:'voice123'}]}:{model_id:model,text:'Hello'});
    return new Response('ID3synthetic',{headers:{'content-type':'audio/mpeg'}});
  }});
  assert.equal(calls,1); assert.equal(await fs.readFile(f.output,'utf8'),'ID3synthetic');
  if(process.platform!=='win32') assert.equal((await fs.stat(f.output)).mode & 0o777,0o600);
});
for (const model of ['scribe_v3','scribe_v2_medical','eleven_multilingual_sts_v2']) test(`multipart ${model} uses correct endpoint and file field`,async t=>{
  const f=await fixture(t); const change=model.startsWith('eleven');
  await run(paid(change?'change':'transcribe',model,f,change?['--voice','voice123']:[]),()=>{}, {env,fetchImpl:async(url,o)=>{
    assert.equal(new URL(url).pathname,change?'/v1/voice-changer/voice123':'/v1/speech-to-text');
    assert.equal(o.body.get('model_id'),model); assert.equal(await o.body.get(change?'audio':'file').text(),'Hello');
    assert.equal(o.headers['Content-Type'],undefined);
    return change?new Response('ID3',{headers:{'content-type':'audio/mpeg'}}):Response.json({text:'Hello',language_code:'en',words:[]});
  }});
  assert.ok((await fs.stat(f.output)).size>0);
});
test('unsupported operations and malformed arguments never reach credential/network IO',async()=>{
  const context={env:{},fetchImpl:()=>assert.fail('network')};
  for (const args of [ ['tts','eleven_v4_turbo'],['transcribe','scribe_v3_live'],['live','scribe_v3_live'],['change','eleven_v4'],['tts','unknown'],['tts','eleven_v4'],['tts','eleven_v4','--confirm-charge','--unknown','secret'],['voices','--search','x','--search','y'],['pick','../secret'] ]) {
    await assert.rejects(run(args,()=>{},context));
  }
});
test('existing outputs, symlinks, oversized and non-file inputs fail before network',async t=>{
  const f=await fixture(t); const context={env,fetchImpl:()=>assert.fail('network')};
  await fs.writeFile(f.output,'preserve');
  await assert.rejects(run(paid('transcribe','scribe_v3',f),()=>{},context),/Output/);
  assert.equal(await fs.readFile(f.output,'utf8'),'preserve');
  const link=path.join(f.dir,'link'); await fs.symlink(f.input,link);
  await assert.rejects(run(paid('transcribe','scribe_v3',{...f,input:link}),()=>{},context),/Input/);
  await assert.rejects(run(paid('transcribe','scribe_v3',{...f,input:f.dir}),()=>{},context),/Input/);
  const big=path.join(f.dir,'big'); const h=await fs.open(big,'w'); await h.truncate(26*1024*1024); await h.close();
  await assert.rejects(run(paid('transcribe','scribe_v3',{...f,input:big}),()=>{},context),/Input/);
});
test('provider failures are sanitized, never retried, and release reserved output',async t=>{
  const f=await fixture(t); let calls=0;
  await assert.rejects(run(paid('transcribe','scribe_v3',f),()=>{}, {env,fetchImpl:async()=>{calls++;throw new Error('secret provider text');}}),e=>!e.message.includes('secret') && /No retry/.test(e.message));
  assert.equal(calls,1); await assert.rejects(fs.stat(f.output),{code:'ENOENT'});
});
test('redirects, wrong content type, oversized and malformed responses fail closed',async t=>{
  const f=await fixture(t);
  const responses=[new Response('',{status:302,headers:{location:'https://evil.invalid'}}),new Response('not json'),Response.json({text:'missing words'}),new Response('{}',{headers:{'content-type':'application/json','content-length':String(5*1024*1024)}})];
  for(const response of responses) {
    await assert.rejects(run(paid('transcribe','scribe_v3',f),()=>{}, {env,fetchImpl:async()=>response}));
    await assert.rejects(fs.stat(f.output),{code:'ENOENT'});
  }
});

test('stream limit holds without content-length',async t=>{
  const f=await fixture(t);
  let cancelled=false;
  const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
  await assert.rejects(run(paid('transcribe','scribe_v3',f),()=>{}, {env,fetchImpl:async()=>new Response(stream,{headers:{'content-type':'application/json'}})}),/oversized/);
  assert.equal(cancelled,true);
  await assert.rejects(fs.stat(f.output),{code:'ENOENT'});
});
test('generated unsafe IDs are rejected without key lookup or requests',async()=>{
  for(const char of ['/', '?', '#', '%', ' ', String.fromCharCode(0), String.fromCharCode(27), 'é', '.', ':', String.fromCharCode(92)]) {
    for(const id of [char+'voice', 'voice'+char, 'vo'+char+'ice']) {
      await assert.rejects(run(['pick',id],()=>assert.fail('output'),{env:{},fetchImpl:()=>assert.fail('network')}),/Invalid voice ID/);
    }
  }
});
