'use strict';
const {randomUUID}=require('node:crypto');
const {models}=require('./catalog');
const {request}=require('./transport');
const {stream}=require('./websocket');
const disclosure='Paid ElevenLabs generation: billed against your account at your plan and voice rates. Exact price is unavailable; confirmation is not a price cap. Text and voice ID are sent to ElevenLabs; provider retention defaults apply. No automatic retries or purchases.';
const supported=models.filter(m=>m.supported && m.operation==='tts');
const idFor=m=>`elevenlabs:tts:${m.id}`;
// One instance per authenticated user/session. Caller must display the complete
// prepare result and obtain an explicit human confirmation before execute.
function createVoicePicker({enabledIds=[],context={},now=Date.now}={}) {
 const enabled=new Set(enabledIds), pending=new Map(), outputs=new Map();
 for(const id of enabled) if(!supported.some(m=>idFor(m)===id)) throw new Error('Unknown TTS entry ID.');
 function entries(){return supported.map(m=>({id:idFor(m),model:m.id,name:m.name,provider:'elevenlabs',operation:'tts',enabled:enabled.has(idFor(m)),maxCharacters:m.maxCharacters}));}
 function prepare(input){
  if(!input || Object.keys(input).some(k=>!['entryId','voiceId','text'].includes(k))) throw new Error('Only entryId, voiceId and text are accepted; no output paths.');
  const {entryId,voiceId,text}=input;
  const model=supported.find(m=>idFor(m)===entryId);
  if(!model || !enabled.has(entryId)) throw new Error('TTS entry is not enabled.');
  if(typeof voiceId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(voiceId)) throw new Error('Invalid voice ID.');
  if(typeof text!=='string' || !text.trim() || Buffer.byteLength(text)>160000 || [...text].length>model.maxCharacters) throw new Error('Invalid text or character limit exceeded.');
  for(const [id,item] of pending) if(item.expiresAt<=now()) pending.delete(id);
  if(pending.size>=100) throw new Error('Too many pending confirmations.');
  const proposal={confirmationId:randomUUID(),entryId,voiceId,text,disclosure,expiresAt:now()+300000};
  pending.set(proposal.confirmationId,{...proposal,model:model.id});
  return {...proposal};
 }
 async function execute(input){
  const stored=pending.get(input?.confirmationId);
  if(!stored) throw new Error('Confirmation expired or already used.');
  // Consume before validation and before awaiting network: mismatch and uncertain
  // outcomes cannot accidentally be replayed by an HTTP/client retry.
  pending.delete(stored.confirmationId);
  if(stored.expiresAt<=now()) throw new Error('Confirmation expired or already used.');
  if(Object.keys(input).some(k=>!['confirmationId','entryId','voiceId','text','disclosure','expiresAt','confirmCharge'].includes(k)) || input.confirmCharge!==true || ['entryId','voiceId','text','disclosure','expiresAt'].some(k=>input[k]!==stored[k])) throw new Error('Confirmation mismatch or charge not confirmed.');
  if(outputs.size>=20) throw new Error('Output storage full; release an output first.');
  const {model,voiceId:voice,text}=stored;
  const outputId=randomUUID();
  outputs.set(outputId,null);
  try {
   const bytes=model==='eleven_v4_turbo' ? await stream({model,voice,text},context) : await request((model==='eleven_v4'?'/v1/text-to-dialogue':`/v1/text-to-speech/${voice}`)+'?output_format=mp3_44100_128',{body:JSON.stringify(model==='eleven_v4'?{model_id:model,inputs:[{text,voice_id:voice}]}:{model_id:model,text})},context);
   outputs.set(outputId,Buffer.from(bytes));
   return {outputId,contentType:'audio/mpeg',bytes:bytes.length,model};
  } catch(error) {outputs.delete(outputId);throw error;}
 }
 function output(id){const bytes=outputs.get(id);if(!bytes) throw new Error('Unknown output.');return {contentType:'audio/mpeg',bytes:Buffer.from(bytes)};}
 return {entries,prepare,execute,output,releaseOutput:id=>outputs.delete(id)};
}
module.exports={createVoicePicker};
