'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {run} = require('../src/krea-helper/mcp');
const modelId='video/alibaba/wan-3.0';
const quote={mode:'preflight',compute_units:3.5,is_estimated:false,available_compute_units:5,affordable:true};
const q={action:'quote',model:'wan-3.0',prompt:'Blue waves at dawn'};
const paid={...q,action:'submit',maxUnits:3.5,confirmCharge:true};
const str={type:'string'};
const tools=[['list_models',{}],['get_model_schema',{model:str}],['generate',{model:str,input:{type:'object'},preflight:{type:'boolean'}}],['get_job',{jobId:str}]].map(([name,properties])=>({name,inputSchema:{type:'object',properties,required:Object.keys(properties)}}));
const schema={type:'object',properties:{prompt:str,duration:{type:'integer'},resolution:{type:'string',enum:['720p']},aspect_ratio:{type:'string',enum:['16:9']}}};
function fixture(change=()=>{}) {
  const calls=[];
  const fetchImpl=async(url,opts)=>{
    assert.equal(url,'https://api.krea.ai/mcp'); assert.equal(opts.redirect,'error'); assert.equal(opts.method,'POST');
    const h=new Headers(opts.headers); assert.equal(h.get('authorization'),'Bearer fake');
    const rpc=JSON.parse(opts.body); const tool=rpc.params?.name; const args=rpc.params?.arguments; calls.push({method:rpc.method,tool,args});
    let result;
    if(rpc.method==='initialize') result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else { assert.equal(h.get('Mcp-Session-Id'),'session1');
      if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
      if(rpc.method==='tools/list')result={tools:structuredClone(tools)};
      else { let payload;
        if(tool==='list_models')payload={models:[{id:modelId}]};
        if(tool==='get_model_schema')payload={model:modelId,schema};
        if(tool==='generate')payload=args.preflight?{...quote}:{job_id:'job-1',status:'queued'};
        if(tool==='get_job')payload={job_id:'job-1',status:'completed',result:{urls:['https://cdn.example/clip.mp4']}};
        result={structuredContent:payload,content:[]};
      }
    }
    const msg={jsonrpc:'2.0',id:rpc.id,result}; const replacement=change({rpc,msg,tool,args,calls}); if(replacement)return replacement;
    return Response.json(msg,{headers:rpc.method==='initialize'?{'Mcp-Session-Id':'session1'}:{}});
  };
  return {calls,fetchImpl};
}
test('workspace quote discovers the exact preset, sends one preflight and returns only native fields',async()=>{
  const f=fixture(); assert.deepEqual(await run(q,'fake',f),quote); assert.deepEqual(f.calls.map(x=>x.tool||x.method),['initialize','notifications/initialized','tools/list','list_models','get_model_schema','generate']);
  assert.deepEqual(f.calls.at(-1).args,{model:modelId,input:{prompt:q.prompt,duration:5,resolution:'720p',aspect_ratio:'16:9'},preflight:true});
});
test('confirmed submit freshly quotes then sends exactly one charge; status polls by ID only',async()=>{
 const f=fixture();assert.deepEqual(await run(paid,'fake',f),{id:'job-1',status:'queued'});
 assert.deepEqual(f.calls.filter(x=>x.tool==='generate').map(x=>x.args.preflight),[true,false]);
 const poll=fixture();assert.deepEqual(await run({action:'status',model:q.model,jobId:'job-1'},'fake',poll),{id:'job-1',status:'completed',outputUrl:'https://cdn.example/clip.mp4'});
 assert.deepEqual(poll.calls.filter(x=>x.tool).map(x=>x.tool),['get_job']);
});
test('loss, rejected session, redirect, mismatched ID or job-shaped preflight never resubmit',async()=>{
 for(const failure of ['loss','session','redirect','id','job','large','toolError']){
   const f=fixture(({tool,args,msg})=>{if(tool!=='generate')return;
     if(failure==='job'&&args.preflight){msg.result.structuredContent.job_id='unexpected';return;}
     if(args.preflight)return;
     if(failure==='loss')throw new Error('secret detailed upstream body');
     if(failure==='session')return new Response('secret',{status:404});
     if(failure==='redirect')return new Response(null,{status:307,headers:{Location:'https://elsewhere.invalid/'}});
     if(failure==='id')msg.id=999;
     if(failure==='large')return new Response('x'.repeat(1048577),{headers:{'content-type':'application/json'}});
     if(failure==='toolError')msg.result.isError=true;
   });
   await assert.rejects(run(paid,'fake',f),failure==='job'?/Invalid Krea preflight/:/outcome unknown/);
   assert.equal(f.calls.filter(x=>x.tool==='generate'&&x.args.preflight===false).length,failure==='job'?0:1);
 }
});
test('a paid dispatch does not inherit the preflight deadline',async()=>{
  const f=fixture(), signals=[];
  await run(paid,'fake',{fetchImpl:(url,opts)=>{if(JSON.parse(opts.body).params?.name==='generate')signals.push(opts.signal);return f.fetchImpl(url,opts);}});
  assert.equal(signals.length,2);assert.notEqual(signals[0],signals[1]);
});
test('native budget and affordability must all pass',async()=>{
 for(const change of [{compute_units:4},{affordable:false},{available_compute_units:2}]){
   const f=fixture(({tool,args,msg})=>{if(tool==='generate'&&args.preflight)Object.assign(msg.result.structuredContent,change);});
   await assert.rejects(run(paid,'fake',f),/balance insufficient/);assert.deepEqual(f.calls.filter(x=>x.tool==='generate').map(x=>x.args.preflight),[true]);
 }
});
test('missing or ambiguous field schema prevents any generate invocation',async()=>{
 for(const change of [p=>delete p.preflight,p=>p.preflight={type:'string'},p=>p.modelId=str,p=>p.input.allOf=[]]){
   const f=fixture(({rpc,msg})=>{if(rpc.method==='tools/list')change(msg.result.tools.find(t=>t.name==='generate').inputSchema.properties);});
   await assert.rejects(run(paid,'fake',f));assert.equal(f.calls.filter(x=>x.tool==='generate').length,0);
 }
});
test('invalid approval, wrong unit or invalid token cannot touch transport',async()=>{
 for(const [r,token] of [[{...paid,maxUnits:'3.5'},'fake'],[{...paid,confirmCharge:false},'fake'],[{...paid,maxUsd:4},'fake'],[q,''],[{action:'status',model:q.model,jobId:'../1'},'fake']]){
  const f=fixture();await assert.rejects(run(r,token,f));assert.equal(f.calls.length,0);
 }
});
test('status rejects ID mismatch, unknown states and non-HTTPS/credential-bearing output',async()=>{
 for(const change of [{job_id:'another'},{status:'ok'},{result:{urls:['http://host/path']}},{result:{urls:['https://secret@host/path']}}]){
  const f=fixture(({tool,msg})=>{if(tool==='get_job')Object.assign(msg.result.structuredContent,change);});
  await assert.rejects(run({action:'status',model:q.model,jobId:'job-1'},'fake',f));assert.ok(!f.calls.some(x=>x.tool==='generate'));
 }
});
test('single-event SSE with structured JSON text is supported; ambiguous text blocks fail',async()=>{
 const f=fixture(({msg,tool})=>{if(tool==='generate'){msg.result={content:[{type:'text',text:JSON.stringify(quote)}]};return new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`,{headers:{'content-type':'text/event-stream'}});}});
 assert.deepEqual(await run(q,'fake',f),quote);
 const bad=fixture(({msg,tool})=>{if(tool==='generate'){msg.result={content:[{type:'text',text:'{}'},{type:'text',text:'{}'}]};}});
 await assert.rejects(run(q,'fake',bad));
});
test('conflicting text and structured MCP payloads never authorize a charge',async()=>{
 const f=fixture(({msg,tool,args})=>{if(tool==='generate'&&args.preflight)msg.result.content=[{type:'text',text:JSON.stringify({job_id:'wrong'})}];});
 await assert.rejects(run(paid,'fake',f));assert.ok(!f.calls.some(x=>x.tool==='generate'&&x.args.preflight===false));
});
test('helper error codes reflect whether a paid request may already have run',async()=>{
 for(const [phase,status,expected] of [['initialize',401,'KREA_LOGIN_REQUIRED'],['preflight',401,'KREA_LOGIN_REQUIRED'],['preflight',500,'KREA_REFUSED'],['paid',401,'KREA_UNCERTAIN'],['paid',500,'KREA_UNCERTAIN']]){
  const f=fixture(({rpc,tool,args})=>{if((phase==='initialize'&&rpc.method==='initialize')||(tool==='generate'&&args.preflight===(phase==='preflight')))return new Response('never expose this body',{status});});
  await assert.rejects(run(paid,'fake',f),err=>err.code===expected&&!err.message.includes('never expose'));assert.equal(f.calls.filter(x=>x.tool==='generate'&&x.args.preflight===false).length,phase==='paid'?1:0);
 }
 await assert.rejects(run({...paid,maxUnits:0},'fake',fixture()),{code:'KREA_REFUSED'});
 await assert.rejects(run(q,'',fixture()),{code:'KREA_LOGIN_REQUIRED'});
});
