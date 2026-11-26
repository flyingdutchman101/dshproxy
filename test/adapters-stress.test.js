'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const research = require('../src/research/command');
const voice = require('../src/voice/command');
const video = require('../src/video/transport');

// Independent acceptance invariants: one external attempt per accepted operation,
// no cross-talk between concurrent outputs, and no retry after ambiguous failure.
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'adapters-stress-'));
  t.after(async () => {
    assert.equal(path.dirname(home), os.tmpdir());
    assert.ok(path.basename(home).startsWith('adapters-stress-'));
    await fs.rm(home, {recursive:true, force:true});
  });
  return home;
}
test('Foreplay: 96 parallel mixed valid, malformed and transport failures remain single-attempt', async t => {
  const home = await fixture(t);
  const counts = Array(96).fill(0);
  await Promise.all(counts.map(async (_, i) => {
    const outputs=[];
    const operation=research.run(['boards','--confirm-credits'], x=>outputs.push(JSON.parse(x)), {
      home,env:{FOREPLAY_API_KEY:'synthetic-key'}, fetch:async()=> {
        counts[i]++; await new Promise(resolve=>setImmediate(resolve));
        if(i%3===1) return new Response('{broken', {headers:{'content-type':'application/json'}});
        if(i%3===2) throw new Error('synthetic network failure');
        return Response.json({metadata:{success:true},data:[{id:String(i),name:`Board ${i}`}]});
      }
    });
    if(i%3) {await assert.rejects(operation,/No retry/);assert.deepEqual(outputs,[]);}
    else {await operation;assert.deepEqual(outputs,[{items:[{label:`Board ${i}`,id:String(i)}]}]);}
  }));
  assert.deepEqual(counts,Array(96).fill(1));
});
test('Voice: 48 concurrent paid mock TTS operations write independent outputs with one attempt', async t=>{
  const home=await fixture(t); const counts=Array(48).fill(0);
  await Promise.all(counts.map(async (_,i)=>{
    const input=path.join(home,`in-${i}`), output=path.join(home,`out-${i}`);
    await fs.writeFile(input,`Text ${i}`);
    const operation=voice.run(['tts','eleven_flash_v2','--text-file',input,'--voice','voice123','--output',output,'--confirm-charge'],()=>{}, {
      home,env:{ELEVENLABS_API_KEY:'synthetic-key'},fetchImpl:async(url,options)=>{
        counts[i]++;assert.equal(JSON.parse(options.body).text,`Text ${i}`);
        await new Promise(resolve=>setImmediate(resolve));
        if(i%2) throw new Error('ambiguous disconnect');
        return new Response(`ID3-${i}`,{headers:{'content-type':'audio/mpeg'}});
      }
    });
    if(i%2) {await assert.rejects(operation);await assert.rejects(fs.stat(output),{code:'ENOENT'});}
    else {await operation;assert.equal(await fs.readFile(output,'utf8'),`ID3-${i}`);}
  }));
  assert.deepEqual(counts,Array(48).fill(1));
});
test('Video: 96 parallel malformed or disconnected ElevenLabs submissions never retry', async()=>{
  const counts=Array(96).fill(0);
  await Promise.all(counts.map(async(_,i)=>{
    await assert.rejects(video.submit({route:'elevenlabs',modelId:'veo-3.1-generate-001',key:'synthetic-key',resolution:'720p',prompt:'synthetic',durationSeconds:6,fetchImpl:async()=>{
      counts[i]++;await new Promise(resolve=>setImmediate(resolve));
      if(i%2) throw new Error('ambiguous disconnect');
      return new Response('{broken',{headers:{'content-type':'application/json'}});
    }}));
  }));
  assert.deepEqual(counts,Array(96).fill(1));
});
