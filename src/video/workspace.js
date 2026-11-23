'use strict';
const {spawn} = require('node:child_process');
const path = require('node:path');
const {parseQuote} = require('./krea-preset');
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const help = 'Use video quote MODEL krea --prompt "PROMPT", video submit MODEL krea --max-units COUNT --confirm-charge "PROMPT", or video status MODEL krea JOB_ID.';
function request(args) {
  const [action,model,,flag,value,confirm,text] = args;
  if(action==='balance' && args.length===2 && model==='krea') return {action};
  if(action==='quote' && args.length===7 && flag==='--prompt' && args[5]==='--resolution' && ['480p','720p','1080p'].includes(args[6]) && model!=='minimax-h3' && typeof value==='string' && value.trim() && !value.startsWith('--') && Buffer.byteLength(value)<=16000) return {action,model,prompt:value,resolution:args[6]};
  if(action==='submit' && args.length===9 && flag==='--max-units' && /^\d{1,9}(?:\.\d{1,6})?$/.test(value) && Number(value)>0 && confirm==='--confirm-charge' && text==='--resolution' && ['480p','720p','1080p'].includes(args[7]) && model!=='minimax-h3' && typeof args[8]==='string' && args[8].trim() && !args[8].startsWith('--') && Buffer.byteLength(args[8])<=16000) return {action,model,prompt:args[8],maxUnits:Number(value),confirmCharge:true,resolution:args[7]};
  const validPrompt = x => typeof x==='string' && x.trim() && !x.startsWith('--') && Buffer.byteLength(x)<=16000;
  if(action==='quote' && args.length===5 && flag==='--prompt' && validPrompt(value)) return {action,model,prompt:value};
  if(action==='submit' && args.length===7 && flag==='--max-units' && /^\d{1,9}(?:\.\d{1,6})?$/.test(value) && Number(value)>0 && confirm==='--confirm-charge' && validPrompt(text)) return {action,model,prompt:text,maxUnits:Number(value),confirmCharge:true};
  if(action==='status' && args.length===4 && idPattern.test(flag)) return {action,model,jobId:flag};
  throw new Error(`Krea workspace OAuth requires explicit workspace parameters. ${help} No request sent.`);
}
function result(req,data) {
  if(req.action==='balance') {
    if(!data || !data.plan || typeof data.plan.name!=='string' || typeof data.plan.billing_period!=='string' || (!Number.isFinite(data.plan.monthly_compute_units) || data.plan.monthly_compute_units<0) || !data.compute_units || !['total','plan','purchased','free'].every(k=>Number.isFinite(data.compute_units[k])&&data.compute_units[k]>=0)) throw new Error('Invalid Krea balance response.');
    return {plan:{name:data.plan.name,billing_period:data.plan.billing_period,monthly_compute_units:data.plan.monthly_compute_units},compute_units:Object.fromEntries(['total','plan','purchased','free'].map(k=>[k,data.compute_units[k]]))};
  }
  const origin={model:req.model,route:'krea'};
  if(req.action==='quote') return {...origin,...parseQuote(data),currency:'workspace_compute_units',budgetFlag:'--max-units'};
  if(!data || typeof data.id!=='string' || !idPattern.test(data.id) || (typeof data.status!=='string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(data.status)) || (req.action==='status' && req.jobId!==data.id)) throw new Error('Invalid Krea job response. Do not resubmit automatically.');
  const job={...origin,id:data.id,status:data.status};
  if(data.outputUrl!==undefined) {
    let u;try{u=new URL(data.outputUrl);}catch{}
    if(typeof data.outputUrl!=='string'||data.status!=='completed'||!u||u.protocol!=='https:'||u.username||u.password) throw new Error('Invalid Krea output URL.');
    job.outputUrl=u.href;
  }
  return job;
}
function invoke(req) {
  return new Promise((resolve,reject)=>{
    const env={}; for(const name of ['SystemRoot','LOCALAPPDATA','TEMP','TMP','USERPROFILE']) if(process.env[name]) env[name]=process.env[name];
    const child=spawn(process.execPath,[path.join(__dirname,'../../bin/dshproxy-krea.js')],{env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    const unknown='Krea helper did not return a verified result. For a submission the outcome may be unknown; check your workspace before trying again.';
    let bytes=0, stdout='',stderr='',done=false;
    const finish=(error,data)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill();reject(new Error(error));}else resolve(data);};
    const timer=setTimeout(()=>finish(unknown),90000);
    child.once('error',()=>finish(unknown));child.stdin.on('error',()=>finish(unknown));
    for(const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]]){stream.setEncoding('utf8');stream.on('data',s=>{bytes+=Buffer.byteLength(s);if(bytes>65536)return finish(unknown);if(name==='stdout')stdout+=s;else stderr+=s;});}
    child.once('close',code=>{if(code!==0){const msg=({'KREA_LOGIN_REQUIRED':'Krea workspace sign-in required. Run the dedicated helper login explicitly.','KREA_REFUSED':'Krea refused the request; the exact schema, budget, or workspace requirements were not met.'})[stderr.trim()];return finish(typeof msg==='string'?msg:unknown);}
      try{finish(null,JSON.parse(stdout));}catch{finish(unknown);}});
    child.stdin.end(JSON.stringify(req)+'\n');
  });
}
module.exports={request,result,invoke};
