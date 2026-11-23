'use strict';
const {prepare,parseQuote,modelId}=require('../video/krea-preset');
const ENDPOINT='https://api.krea.ai/mcp', VERSION='2025-06-18', MAX_BYTES=1024*1024;
const obj=v=>v!==null && typeof v==='object' && !Array.isArray(v);
const own=(v,k)=>Object.hasOwn(v,k);
class WorkspaceError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
const loginRequired=()=>new WorkspaceError('KREA_LOGIN_REQUIRED','Krea workspace OAuth sign-in required.');
function check(v){if(!v)throw new WorkspaceError('KREA_REFUSED','Unsupported Krea workspace schema or response.');}
function keys(v,allowed){check(obj(v)&&Object.keys(v).every(k=>allowed.includes(k)));}
function accepts(schema,values){
  check(obj(schema));
  const p=schema.properties??{};check(schema.type==='object'&&obj(p));
  if(own(schema,'required'))check(Array.isArray(schema.required)&&schema.required.every(k=>typeof k==='string'&&own(values,k)));
  for(const [k,v] of Object.entries(values)){
    check(own(p,k)); const f=p[k];check(obj(f));
    check(f.type===typeof v);
    if(own(f,'enum'))check(Array.isArray(f.enum)&&f.enum.includes(v));
    if(own(f,'const'))check(f.const===v);
  }
  return values;
}
async function readResponse(r){
  const type=(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  check(type==='application/json'||type==='text/event-stream'); check(Number(r.headers.get('content-length')||0)<=MAX_BYTES&&r.body);
  const reader=r.body.getReader(), chunks=[];let size=0;
  const decoder=new TextDecoder('utf-8',{fatal:true});
  try{
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;check(size<=MAX_BYTES);chunks.push(value);}
    let text=decoder.decode(Buffer.concat(chunks));
    if(type==='text/event-stream'){
      const frames=text.replace(/\r\n/g,'\n').split('\n\n').filter(s=>s.split('\n').some(x=>x.startsWith('data:')));
      check(frames.length===1); const lines=frames[0].split('\n');check(lines.every(x=>!x||x.startsWith(':')||x.startsWith('id:')||/^event: ?message$/.test(x)||x.startsWith('data:')));
      text=lines.filter(x=>x.startsWith('data:')).map(x=>x.slice(5).replace(/^ /,'')).join('\n');
    }
    return JSON.parse(text);
  }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function session(token,fetchImpl){
  let seq=0,sessionId,version;
  const discoveryDeadline=AbortSignal.timeout(30000);
  return async(method,params)=>{
    // Discovery is bounded as a group; a confirmed charge gets its own response window.
    const paidCall=method==='tools/call' && params?.name==='generate_video' && params.arguments?.preflight===false;
    const signal=paidCall?AbortSignal.timeout(30000):discoveryDeadline;
    const notify=method==='notifications/initialized';const id=notify?undefined:++seq;
    const headers={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${token}`};
    if(method!=='initialize')headers['MCP-Protocol-Version']=version;
    if(sessionId)headers['Mcp-Session-Id']=sessionId;
    try{
      const r=await fetchImpl(ENDPOINT,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params}),redirect:'error',signal});
      if(r.status!==(notify?202:200)){void r.body?.cancel().catch(()=>{});if(r.status===401)throw loginRequired();throw new Error();}
      if(notify){void r.body?.cancel().catch(()=>{});return;}
      const sid=r.headers.get('Mcp-Session-Id');if(sid!==null){check(/^[\x21-\x7e]{1,256}$/.test(sid));if(method==='initialize')sessionId=sid;else check(sid===sessionId);}
      const msg=await readResponse(r);keys(msg,['jsonrpc','id','result']);check(msg.jsonrpc==='2.0'&&msg.id===id&&obj(msg.result));if(method==='initialize'){check(['2025-06-18','2025-11-25'].includes(msg.result.protocolVersion));version=msg.result.protocolVersion;}return msg.result;
    }catch(error){if(error instanceof WorkspaceError)throw error;throw new WorkspaceError('KREA_REFUSED','Krea workspace request failed or returned an unsupported response. No retry.');}
  };
}
function toolResult(r){
  check(!own(r,'isError')||r.isError===false);check(Array.isArray(r.content));
  if(own(r,'structuredContent')){
    check(obj(r.structuredContent));
    if(!r.content.length)return r.structuredContent;
    // MCP may mirror structured results as JSON text for older clients.
    // Refuse mixed evidence (e.g. a job receipt paired with a quote).
    check(require('node:util').isDeepStrictEqual(toolResult({content:r.content}),r.structuredContent));
    return r.structuredContent;
  }
  check(r.content.length===1&&r.content[0]?.type==='text'&&typeof r.content[0].text==='string');
  let v;try{v=JSON.parse(r.content[0].text);}catch{check(false);}check(obj(v));return v;
}
const jobIdOk=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
function parseJob(v,id,modelId){
  check(!own(v,'mode')&&!own(v,'job')&&jobIdOk(v.job_id)&&(!id||v.job_id===id));
  if(own(v,'model'))check(v.model===modelId);
  check(typeof v.status==='string' && /^[a-z][a-z0-9_-]{0,63}$/.test(v.status));
  const result={id:v.job_id,status:v.status};
  if(v.status==='completed'){
    const urls=v.result?.urls;check(Array.isArray(urls)&&urls.length===1&&typeof urls[0]==='string'&&urls[0].length<=8192);
    let u;try{u=new URL(urls[0]);}catch{check(false);}check(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash);result.outputUrl=u.href;
  }
  return result;
}
async function execute(request,token,{fetchImpl=globalThis.fetch}={}){
  check(obj(request) && (request.action==='balance' || modelId(request.model)));
  if(typeof token!=='string'||!/^[-A-Za-z0-9._~+/]+=*$/.test(token)||token.length>16384)throw loginRequired();
  const {action,model,prompt}=request;
  check(['quote','submit','status','balance'].includes(action));
  const fields=action==='balance'?[]:action==='status'?['model','jobId']:action==='quote'?['model','prompt','resolution']:['model','prompt','resolution','maxUnits','confirmCharge'];
  keys(request,['action',...fields]);
  if(action==='status')check(jobIdOk(request.jobId));
  else if(action!=='balance')check(typeof prompt==='string'&&prompt.trim()&&Buffer.byteLength(prompt)<=32768);
  if(own(request,'resolution'))check(['480p','720p','1080p'].includes(request.resolution)&&model!=='minimax-h3');
  if(action==='submit')check(request.confirmCharge===true&&Number.isFinite(request.maxUnits)&&request.maxUnits>=0);
  const rpc=session(token,fetchImpl);
  const init=await rpc('initialize',{protocolVersion:VERSION,capabilities:{},clientInfo:{name:'dshproxy-krea-helper',version:'1'}});
  check(obj(init.capabilities?.tools)&&typeof init.serverInfo?.name==='string'&&typeof init.serverInfo?.version==='string');
  await rpc('notifications/initialized');
  const catalog=await rpc('tools/list',{});check(Array.isArray(catalog.tools)&&!own(catalog,'nextCursor'));
  const wanted=new Set(['list_models','get_model_schema','generate_video','get_job','get_balance']);
  const tools=new Map();for(const t of catalog.tools){if(!wanted.has(t?.name))continue;check(!tools.has(t.name)&&obj(t.inputSchema));tools.set(t.name,t.inputSchema);}
  const call=async(name,args)=>toolResult(await rpc('tools/call',{name,arguments:accepts(tools.get(name),args)}));
  const id=modelId(model);
  if(action==='balance') {
    const value=await call('get_balance',{});
    check(obj(value.plan)&&typeof value.plan.name==='string'&&typeof value.plan.billing_period==='string'&&Number.isFinite(value.plan.monthly_compute_units)&&value.plan.monthly_compute_units>=0&&obj(value.compute_units));
    check(['total','plan','purchased','free'].every(k=>Number.isFinite(value.compute_units[k])&&value.compute_units[k]>=0));
    return {plan:{name:value.plan.name,billing_period:value.plan.billing_period,monthly_compute_units:value.plan.monthly_compute_units},compute_units:Object.fromEntries(['total','plan','purchased','free'].map(k=>[k,value.compute_units[k]]))};
  }
  if(action==='status')return parseJob(await call('get_job',{jobId:request.jobId}),request.jobId,id);
  const found=await call('list_models',{});check(Array.isArray(found.models)&&!own(found,'nextCursor'));
  const discovered=found.models.map(m=>typeof m==='string'?m:m?.id);check(discovered.includes(id));
  const schemaResult=await call('get_model_schema',{model:id});
  check(schemaResult.model===id);
  const {input}=prepare(model,prompt,discovered,schemaResult.inputSchema,request.resolution);
  const args={model:id,input,preflight:true};
  const quote=parseQuote(await call('generate_video',args));
  if(action==='quote')return quote;
  if(quote.compute_units<=0 || !quote.affordable || quote.compute_units>quote.available_compute_units || quote.compute_units>request.maxUnits) {
    throw new WorkspaceError('KREA_REFUSED','Krea workspace budget or balance insufficient. No job submitted.');
  }
  const submitArgs=accepts(tools.get('generate_video'),{...args,preflight:false});
  try {
    const receipt=await call('generate_video',submitArgs);
    check(receipt.mode==='async' && jobIdOk(receipt.job_id) && obj(receipt.job) && receipt.job.job_id===receipt.job_id);
    return parseJob(receipt.job,receipt.job_id,id);
  } catch {
    throw new WorkspaceError('KREA_UNCERTAIN','Krea submission outcome unknown. No retry; check workspace history before submitting again.');
  }
}
async function run(request,token,options){
  try{return await execute(request,token,options);}
  catch(error){
    if(error instanceof WorkspaceError)throw error;
    const safe=['Invalid Krea preflight quote','Exact Krea model not discovered','Live Krea input schema does not support the exact preset','Krea prompt must not be empty'];
    throw new WorkspaceError('KREA_REFUSED',safe.includes(error?.message)?error.message:'Unsupported Krea workspace request or response.');
  }
}
module.exports={run};
