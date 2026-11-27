'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createVoicePicker}=require('../src/voice/picker');
const entryId='elevenlabs:tts:eleven_flash_v2';
test('mismatch, paths, missing consent, expiry and failures never retry',async()=>{
 let calls=0,clock=0;
 const picker=createVoicePicker({enabledIds:[entryId],now:()=>clock,context:{env:{ELEVENLABS_API_KEY:'test'},fetchImpl:async()=>{calls++;throw new Error('offline');}}});
 const selection={entryId,voiceId:'voice123',text:'exact text'};
 assert.throws(()=>picker.prepare({...selection,output:'/tmp/arbitrary'}),/paths/);
 assert.throws(()=>createVoicePicker().prepare(selection),/enabled/);
 for(const change of [{text:'changed'},{voiceId:'other'},{entryId:'elevenlabs:tts:eleven_v4'},{disclosure:'free'},{confirmCharge:false},{output:'/tmp/arbitrary'}]) {
  const proposal=picker.prepare(selection);
  await assert.rejects(picker.execute({...proposal,confirmCharge:true,...change}),/mismatch/);
  await assert.rejects(picker.execute({...proposal,confirmCharge:true}),/used/);
 }
 assert.equal(calls,0);
 const expired=picker.prepare(selection);clock=300001;
 await assert.rejects(picker.execute({...expired,confirmCharge:true}),/expired/);
 const proposal=picker.prepare(selection);
 await assert.rejects(picker.execute({...proposal,confirmCharge:true}),/No retry/);
 await assert.rejects(picker.execute({...proposal,confirmCharge:true}),/used/);
 assert.equal(calls,1);
});
test('dialogue routes preserve exact voice and text and concurrent replay sends once',async()=>{
 let calls=0;
 const id='elevenlabs:tts:eleven_v4';
 const picker=createVoicePicker({enabledIds:[id],context:{env:{ELEVENLABS_API_KEY:'test'},fetchImpl:async(url,opts)=>{
  calls++;assert.match(url,/text-to-dialogue\?/);assert.deepEqual(JSON.parse(opts.body),{model_id:'eleven_v4',inputs:[{text:'dialogue',voice_id:'chosen'}]});
  return new Response(Buffer.from('audio'),{headers:{'content-type':'audio/mpeg'}});
 }}});
 const proposal=picker.prepare({entryId:id,voiceId:'chosen',text:'dialogue'});
 const outcomes=await Promise.allSettled([picker.execute({...proposal,confirmCharge:true}),picker.execute({...proposal,confirmCharge:true})]);
 assert.equal(calls,1);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 const outputId=outcomes.find(r=>r.status==='fulfilled').value.outputId;
 picker.releaseOutput(outputId);assert.throws(()=>picker.output(outputId),/Unknown/);
});
test('stable opt-in entries and exact confirmed paid request produce opaque output',async()=>{
 let calls=0;
 const picker=createVoicePicker({enabledIds:[entryId],context:{env:{ELEVENLABS_API_KEY:'test'},fetchImpl:async(url,opts)=>{calls++;assert.match(url,/text-to-speech\/voice123/);assert.deepEqual(JSON.parse(opts.body),{model_id:'eleven_flash_v2',text:' Hello! '});return new Response(Buffer.from('audio'),{headers:{'content-type':'audio/mpeg'}});}}});
 assert.equal(createVoicePicker().entries().find(e=>e.id===entryId).enabled,false);
 const prepared=picker.prepare({entryId,voiceId:'voice123',text:' Hello! '});
 assert.match(prepared.disclosure,/not a price cap/);
 const result=await picker.execute({...prepared,confirmCharge:true});
 assert.equal(calls,1);assert.equal(picker.output(result.outputId).bytes.toString(),'audio');
 await assert.rejects(picker.execute({...prepared,confirmCharge:true}),/expired|used/);
 assert.equal(calls,1);
});
