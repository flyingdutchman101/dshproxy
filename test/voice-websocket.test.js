'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {run}=require('../src/voice/command');
function socket(script, urls, sent) {
  return class extends EventTarget {
    constructor(url) { super(); urls.push(new URL(url)); this.readyState=1; this.bufferedAmount=0; queueMicrotask(()=>{this.dispatchEvent(new Event('open')); script(this);}); }
    send(raw) { sent.push(JSON.parse(raw)); }
    message(data) { this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)})); }
    close() { this.readyState=3; }
  };
}
async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'voice-ws-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const input=path.join(dir,'input'); await fs.writeFile(input,'Hello');
 return {input,output:path.join(dir,'output')};
}
const env={ELEVENLABS_API_KEY:'synthetic-permanent-key'};
test('Live streams raw PCM only after session start and commits the last chunk',async t=>{
 const f=await fixture(t), urls=[], sent=[]; await fs.writeFile(f.input,Buffer.alloc(64000));
 const Base=socket(s=>{ s.message({message_type:'session_started'}); s.message({message_type:'warning',warning:'Provider advice, not a terminal failure'}); },urls,sent);
 class Live extends Base { send(raw) { super.send(raw); if(JSON.parse(raw).commit) queueMicrotask(()=>this.message({message_type:'committed_transcript',text:'hello'})); } }
 await run(['live','scribe_v3_live','--input',f.input,'--output',f.output,'--confirm-charge'],()=>{}, {env,WebSocketImpl:Live,fetchImpl:async(url,o)=>{
 assert.equal(url,'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe?max_session_duration_seconds=120'); assert.equal(o.headers['xi-api-key'],env.ELEVENLABS_API_KEY); return Response.json({token:'sutkn_test'});
 }});
 assert.equal(urls[0].pathname,'/v1/speech-to-text/realtime'); assert.equal(urls[0].searchParams.get('token'),'sutkn_test'); assert.equal(urls[0].searchParams.get('commit_strategy'),'manual');
 assert.equal(sent.length,20); assert.ok(sent.slice(0,-1).every(x=>!x.commit)); assert.equal(sent.at(-1).commit,true);
 assert.ok(sent.every(x=>x.message_type==='input_audio_chunk' && x.sample_rate===16000));
 assert.equal(Buffer.concat(sent.map(x=>Buffer.from(x.audio_base_64,'base64'))).length,64000);
 assert.equal(JSON.parse(await fs.readFile(f.output,'utf8')).text,'hello');
 if(process.platform!=='win32') assert.equal((await fs.stat(f.output)).mode&0o777,0o600);
});
for(const kind of ['error','close','bad-base64','no-audio','oversized','malformed','timeout']) test(`WebSocket ${kind} fails sanitized and cleans reserved output`,async t=>{
 const f=await fixture(t),urls=[],sent=[];
 if(kind==='timeout') t.mock.timers.enable({apis:['setTimeout']});
 const WS=socket(s=>{
 if(kind==='error') s.message({error:'synthetic-permanent-key'});
 if(kind==='close') s.dispatchEvent(new Event('close'));
 if(kind==='bad-base64') s.message({audio:'not base64!'});
 if(kind==='no-audio') s.message({is_final:true});
 if(kind==='oversized') s.message({audio:'A'.repeat(8*1024*1024)});
 if(kind==='malformed') s.dispatchEvent(new MessageEvent('message',{data:'{'}));
 if(kind==='timeout') t.mock.timers.tick(120000);
 },urls,sent);
 await assert.rejects(run(['tts','eleven_v4_turbo','--voice','v','--text-file',f.input,'--output',f.output,'--confirm-charge'],()=>{}, {env,WebSocketImpl:WS,fetchImpl:async()=>Response.json({token:'sutkn_test'})}),e=>/No retry/.test(e.message)&&!e.message.includes(env.ELEVENLABS_API_KEY));
 await assert.rejects(fs.stat(f.output),{code:'ENOENT'}); assert.equal(urls.length,1);
});
test('Live invalid PCM, charge refusal and existing output never mint tokens',async t=>{
 const f=await fixture(t); const ctx={env,fetchImpl:()=>assert.fail('network')};
 const args=['live','scribe_v3_live','--input',f.input,'--output',f.output];
 await assert.rejects(run(args,()=>{},ctx),/confirm-charge/);
 await assert.rejects(run([...args,'--confirm-charge'],()=>{},ctx),/PCM16/);
 await fs.writeFile(f.input,Buffer.alloc(64000)); await fs.writeFile(f.output,'keep');
 await assert.rejects(run([...args,'--confirm-charge'],()=>{},ctx),/Output/);
});
test('Turbo uses a single-use token in registration, official frames and final MP3',async t=>{
 const f=await fixture(t), urls=[], sent=[];
 await run(['tts','eleven_v4_turbo','--voice','voice123','--text-file',f.input,'--output',f.output,'--confirm-charge'],()=>{}, {
 env, fetchImpl:async(url,o)=>{ assert.equal(url,'https://api.elevenlabs.io/v1/single-use-token/tts_websocket'); assert.equal(o.method,'POST'); assert.equal(o.redirect,'error'); return Response.json({token:'sutkn_test'}); },
 WebSocketImpl:socket(s=>{s.message({audio:'SUQz'});s.message({is_final:true});},urls,sent)
 });
 assert.equal(urls[0].origin,'wss://api.elevenlabs.io'); assert.equal(urls[0].pathname,'/v1/text-to-dialogue/stream-input');
 assert.equal(urls[0].searchParams.get('model_id'),'eleven_v4_turbo');
 assert.deepEqual(sent,[{voices:['voice123'],single_use_token:'sutkn_test'},{inputs:[{text:'Hello',voice_id:'voice123',new_turn:false}]},{close_socket:true}]);
 assert.equal(await fs.readFile(f.output,'utf8'),'ID3');
 assert.ok(!JSON.stringify({urls,sent}).includes(env.ELEVENLABS_API_KEY));
});
