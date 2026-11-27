'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {classify,normalise,promptProblem}=require('../video/picker/classify');
const {newId}=require('../video/picker/store');
const list=Object.freeze(require('../voice/catalog').models.filter(m=>m.supported&&m.operation==='tts').map(m=>Object.freeze({id:m.id.replaceAll('_','-')+'/tts/elevenlabs',model:m.id,name:m.name,provider:'elevenlabs',operation:'tts'})));
const known=id=>list.some(m=>m.id===id);
function dir(home){const p=path.join(home,'voice-picker');fs.mkdirSync(p,{recursive:true,mode:0o700});if(fs.lstatSync(p).isSymbolicLink())throw Error();fs.chmodSync(p,0o700);return p;}
function enabled(home) {
  const file = path.join(home || require('../settings').homeDir(), 'voice-picker', 'enabled.json');
  try {
    const ids = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(ids) || !ids.every(known)) throw Error('Invalid saved voice settings.');
    return ids;
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function set(home,model,value) {
  if (!known(model) || typeof value !== 'boolean') throw Error('Invalid voice setting.');
  const file=path.join(dir(home),'enabled.json');
  const {withLock,replaceFile}=require('../filelock');
  await withLock(file,async()=>{
    const ids=new Set(enabled(home));
    if (value) ids.add(model); else ids.delete(model);
    await replaceFile(file,JSON.stringify([...ids])+'\n');
  });
}
function entries(home) { const ids = enabled(home); return list.filter(m=>ids.includes(m.id)); }
function run(input, home, {signal} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error());
    const env = {DSHPROXY_HOME: home};
    for (const key of ['HOME','PATH','SYSTEMROOT','SystemRoot','TMPDIR','DSHPROXY_KEYCHAIN','LOCALAPPDATA','TEMP','TMP','USERPROFILE','ELEVENLABS_API_KEY']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = require('node:child_process').fork(path.join(__dirname, 'voice-child.js'), [], {
      env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    let result, settled = false;
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(Error()); else resolve(bytes);
    };
    const abort = () => {
      child.kill('SIGKILL');
      finish(true);
    };
    const timer = setTimeout(abort, 150000);
    let submitted = false;
    child.on('message', message => {
      if (settled) return;
      if (signal?.aborted) return abort();
      if (message?.ready === true && !submitted) {
        submitted = true;
        try { child.send(input, error => { if (error) abort(); }); }
        catch { abort(); }
      } else if (submitted) result = message;
    });
    child.on('error', abort);
    child.on('exit', code => {
      if (settled) return;
      if (signal?.aborted || code !== 0 || typeof result?.audio !== 'string') return finish(true);
      finish(false, Buffer.from(result.audio, 'base64'));
    });
    signal?.addEventListener('abort', abort, {once: true});
    // Cancellation can happen while the child is starting, before listener installation.
    if (signal?.aborted) return abort();
  });
}
function prune(folder,time){
 let count=0;
 for(const name of fs.readdirSync(folder)){
  if(!/^[A-Za-z0-9_-]+\.(json|claimed)$/.test(name)||name==='enabled.json')continue;
  const target=path.resolve(folder,name);if(path.dirname(target)!==path.resolve(folder))throw Error();
  const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink())continue;
  let stale=time-stat.mtimeMs>600000;
  if(name.endsWith('.json')&&stat.size<4096){try{const value=JSON.parse(fs.readFileSync(target,'utf8'));stale=Number.isFinite(value.expires)&&time>=value.expires;}catch{}}
  if(stale)fs.unlinkSync(target);else count++;
 }
 return count;
}
function create({home,exposed=()=>true,generate=run,now=Date.now}){return {async answer(body,write,options={}){try{
 const r=classify(body),folder=dir(home);const allowed=()=>entries(home).some(m=>m.id===body.model)&&exposed()===false&&!options.signal?.aborted;
 if(!allowed())return write('Voice picker disabled, cancelled, or exposed to automation. No request sent.');
 if((r.kind==='confirm'||r.kind==='refusal') && r.turn){
 const file=path.join(folder,r.turn.quoteId+'.json');let saved;try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return write('No matching voice request.');}
 const assistant=body.messages.findLast(m=>m.role==='assistant');const exact=typeof assistant?.content==='string'?assistant.content:assistant?.content?.map(b=>b.text).join('');
 const entryId='elevenlabs:tts:'+list.find(m=>m.id===body.model).model;
 if(typeof exact!=='string'||exact.length>64000||saved.digest!==crypto.createHash('sha256').update(exact).digest('hex')||saved.entryId!==entryId||!Number.isFinite(saved.expires)||now()>=saved.expires)return write('Confirmation mismatch or expired. No request sent.');
 const fields=/^Voice: [^\n]+\nVoice ID: ([A-Za-z0-9_-]{1,128})\nText: (.+)\n/.exec(exact);if(!fields)throw Error();
 const input={entryId,voiceId:fields[1],text:JSON.parse(fields[2])};if(typeof input.text!=='string'||Buffer.byteLength(input.text)>16000)throw Error();
 require('../voice/picker').createVoicePicker({enabledIds:[entryId]}).prepare(input);
 try{fs.writeFileSync(path.join(folder,r.turn.quoteId+'.claimed'),'claimed',{flag:'wx',mode:0o600});}catch{return write('Request already used. No retry made.');}
 if(r.kind==='refusal')return write('Cancelled. No request sent.');
 if(!allowed())return write('Voice request cancelled.');
 const output=path.join(folder,crypto.randomUUID()+'.mp3');const fd=fs.openSync(output,'wx',0o600);
 try{const bytes=await generate(input,home,{signal:options.signal});if(!allowed())throw Error();if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>50*1024*1024)throw Error();fs.writeFileSync(fd,bytes);}catch(error){fs.closeSync(fd);fs.unlinkSync(output);throw error;}fs.closeSync(fd);
 return write(`[Download MP3](<${pathToFileURL(output).href}>)\nSaved locally: ${output}`);
 }
 if(r.kind!=='prompt'||r.unfit||promptProblem(r.prompt))return write('Type speak VOICE_ID TEXT yourself. Automation is not supported.');
 if(prune(folder,now())>=512)return write('Too many pending voice requests. Try again later.');
 const match=/^speak ([A-Za-z0-9_-]{1,128}) ([\s\S]+)$/.exec(r.prompt);if(!match)return write('Use speak VOICE_ID TEXT. Output paths are not accepted.');
 const model=list.find(m=>m.id===body.model),input={entryId:'elevenlabs:tts:'+model.model,voiceId:match[1],text:match[2]};
 const picker=require('../voice/picker').createVoicePicker({enabledIds:[input.entryId]});const proposal=picker.prepare(input);
 const id=newId(n=>crypto.randomBytes(n));const answer=normalise(`Voice: ${model.name}\nVoice ID: ${input.voiceId}\nText: ${JSON.stringify(input.text)}\n${proposal.disclosure}\nReply yes within five minutes to authorize this exact request, or no to cancel.\nQuote ${id}`);
 fs.writeFileSync(path.join(folder,id+'.json'),JSON.stringify({digest:crypto.createHash('sha256').update(answer).digest('hex'),entryId:input.entryId,expires:now()+300000}),{flag:'wx',mode:0o600});return write(answer);
 }catch{return write('Voice request failed. No retry made; a submitted request may have been charged.');}}};}
module.exports={list,settings:{list,set,entries,known},set,entries,known,create};
