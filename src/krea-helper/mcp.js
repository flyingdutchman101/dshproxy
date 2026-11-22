'use strict';
const {prepare,parseQuote}=require('../video/krea-preset');
const ENDPOINT='https://api.krea.ai/mcp', VERSION='2025-06-18', MAX_BYTES=1024*1024;
const modelIds=new Map([['seedance-2.5','video/bytedance/seedance-2-5'],['seedance-2.0','video/bytedance/seedance-2'],['minimax-h3','video/minimax/hailuo-3'],['wan-3.0','video/alibaba/wan-3.0']]);
const obj=v=>v!==null && typeof v==='object' && !Array.isArray(v);
const own=(v,k)=>Object.hasOwn(v,k);
class WorkspaceError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
const loginRequired=()=>new WorkspaceError('KREA_LOGIN_REQUIRED','Krea workspace OAuth sign-in required.');
function check(v){if(!v)throw new WorkspaceError('KREA_REFUSED','Unsupported Krea workspace schema or response.');}
function keys(v,allowed){check(obj(v)&&Object.keys(v).every(k=>allowed.includes(k)));}
function alias(props,names){const found=names.filter(k=>own(props,k));check(found.length===1);return found[0];}
function accepts(schema,values){
  const meta=['description','title','default','$comment'];
  keys(schema,['type','properties','required','additionalProperties',...meta,'$schema']);
  const p=schema.properties??{};check(schema.type==='object'&&obj(p));
  check(!own(schema,'additionalProperties')||typeof schema.additionalProperties==='boolean');
  if(own(schema,'required'))check(Array.isArray(schema.required)&&schema.required.every(k=>typeof k==='string'&&own(values,k)));
  for(const [k,v] of Object.entries(values)){
    check(own(p,k)); const f=p[k];keys(f,['type','enum','const',...meta,...(obj(v)?['additionalProperties','properties']:[])]);
    check(f.type===typeof v);
    if(own(f,'enum'))check(Array.isArray(f.enum)&&f.enum.includes(v));
    if(own(f,'const'))check(f.const===v);
    if(obj(v)){check(!own(f,'properties')||obj(f.properties)&&Object.keys(f.properties).length===0);check(!own(f,'additionalProperties')||f.additionalProperties===true);}
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
  let seq=0,sessionId;
  const discoveryDeadline=AbortSignal.timeout(30000);
  return async(method,params)=>{
    // Discovery is bounded as a group; a confirmed charge gets its own response window.
    const paidCall=method==='tools/call' && params?.name==='generate' && params.arguments?.preflight===false;
    const signal=paidCall?AbortSignal.timeout(30000):discoveryDeadline;
    const notify=method==='notifications/initialized';const id=notify?undefined:++seq;
    const headers={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${token}`};
    if(method!=='initialize')headers['MCP-Protocol-Version']=VERSION;
    if(sessionId)headers['Mcp-Session-Id']=sessionId;
    try{
      const r=await fetchImpl(ENDPOINT,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params}),redirect:'error',signal});
      if(r.status!==(notify?202:200)){void r.body?.cancel().catch(()=>{});if(r.status===401)throw loginRequired();throw new Error();}
      if(notify){void r.body?.cancel().catch(()=>{});return;}
      const sid=r.headers.get('Mcp-Session-Id');if(sid!==null){check(/^[\x21-\x7e]{1,256}$/.test(sid));if(method==='initialize')sessionId=sid;else check(sid===sessionId);}
      const msg=await readResponse(r);keys(msg,['jsonrpc','id','result']);check(msg.jsonrpc==='2.0'&&msg.id===id&&obj(msg.result));return msg.result;
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
  check(['backlogged','queued','scheduled','processing','sampling','intermediate-complete','completed','failed','cancelled'].includes(v.status));
  const result={id:v.job_id,status:v.status};
  if(v.status==='completed'){
    const urls=v.result?.urls;check(Array.isArray(urls)&&urls.length===1&&typeof urls[0]==='string'&&urls[0].length<=8192);
    let u;try{u=new URL(urls[0]);}catch{check(false);}check(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash);result.outputUrl=u.href;
  }
  return result;
}
async function execute(request,token,{fetchImpl=globalThis.fetch}={}){
  check(obj(request)&&modelIds.has(request.model));
  if(typeof token!=='string'||!/^[-A-Za-z0-9._~+/]+=*$/.test(token)||token.length>16384)throw loginRequired();
  const {action,model,prompt}=request;
  check(['quote','submit','status'].includes(action));
  const fields=action==='status'?['jobId']:action==='quote'?['prompt']:['prompt','maxUnits','confirmCharge'];
  keys(request,['action','model',...fields]);
  if(action==='status')check(jobIdOk(request.jobId));
  else check(typeof prompt==='string'&&prompt.trim()&&Buffer.byteLength(prompt)<=32768);
  if(action==='submit')check(request.confirmCharge===true&&Number.isFinite(request.maxUnits)&&request.maxUnits>=0);
  const rpc=session(token,fetchImpl);
  const init=await rpc('initialize',{protocolVersion:VERSION,capabilities:{},clientInfo:{name:'dshproxy-krea-helper',version:'1'}});
  check(init.protocolVersion===VERSION&&obj(init.capabilities?.tools)&&typeof init.serverInfo?.name==='string'&&typeof init.serverInfo?.version==='string');
  await rpc('notifications/initialized');
  const catalog=await rpc('tools/list',{});check(Array.isArray(catalog.tools)&&!own(catalog,'nextCursor'));
  const tools=new Map();for(const t of catalog.tools){check(typeof t?.name==='string'&&!tools.has(t.name)&&obj(t.inputSchema));tools.set(t.name,t.inputSchema);}
  const call=async(name,args)=>toolResult(await rpc('tools/call',{name,arguments:accepts(tools.get(name),args)}));
  const id=modelIds.get(model);
  if(action==='status')return parseJob(await call('get_job',{jobId:request.jobId}),request.jobId,id);
  const found=await call('list_models',{});check(Array.isArray(found.models)&&!own(found,'nextCursor'));
  const discovered=found.models.map(m=>typeof m==='string'?m:m?.id);check(discovered.includes(id));
  const modelNames=['model','modelId','model_id'];
  const selector=alias(tools.get('get_model_schema')?.properties??{},modelNames);
  const schemaResult=await call('get_model_schema',{[selector]:id});
  for(const k of modelNames)if(own(schemaResult,k))check(schemaResult[k]===id);
  const sk=alias(schemaResult,['schema','inputSchema','input_schema']);
  const {input}=prepare(model,prompt,discovered,schemaResult[sk]);
  const props=tools.get('generate')?.properties??{};
  const args={[alias(props,modelNames)]:id,[alias(props,['input','inputs','params'])]:input,preflight:true};
  const quote=parseQuote(await call('generate',args));
  if(action==='quote')return quote;
  if(!quote.affordable||quote.compute_units>quote.available_compute_units||quote.compute_units>request.maxUnits)throw new WorkspaceError('KREA_REFUSED','Krea workspace budget or balance insufficient. No job submitted.');
  const submitArgs=accepts(tools.get('generate'),{...args,preflight:false});
  try{return parseJob(await call('generate',submitArgs),undefined,id);}
  catch{throw new WorkspaceError('KREA_UNCERTAIN','Krea submission outcome unknown. No retry; check workspace history before submitting again.');}
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
