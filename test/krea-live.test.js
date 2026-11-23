'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {run}=require(process.env.KREA_TEST_HELPER || '../src/krea-helper/mcp');
const {run:command}=require('../src/video/command');
const TOKEN='synthetic_live_token';
const pairs={
  'wan-3.0':['alibaba/wan-3.0',[277.77777777777777,555.5555555555555,1111.111111111111]],
  'seedance-2.0':['bytedance/seedance-2',[248.8111111111111,560,1385.9999999999998]],
  'seedance-2.5':['bytedance/seedance-2-5',[380.33333333333326,856,2106]],
  'minimax-h3':['minimax/hailuo-3',[481.48148148148147]],
};
const resolutions=['480p','720p','1080p'];
const prompt='A paper boat';
const str={type:'string'}, bool={type:'boolean'};
const define=(name,properties,required=Object.keys(properties))=>({name,title:'Recorded tool',annotations:{readOnlyHint:false},outputSchema:{type:'object'},execution:{taskSupport:'forbidden'},inputSchema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties,required}});
const tools=[define('list_models',{category:{type:'string',enum:['image','video','enhance','3d','audio']}},[]),define('get_model_schema',{model:str}),define('generate_video',{model:str,input:{type:'object',propertyNames:{type:'string'},additionalProperties:{}},sync:bool,timeoutSeconds:{type:'integer'},preflight:bool},['model','input']),define('get_job',{jobId:str}),define('get_balance',{},[]),{name:'unused',title:'unrelated',inputSchema:{type:'object',oneOf:[{}]}}];
function schema(model) {
 const s={type:'object',additionalProperties:false,properties:{prompt:{type:'string',minLength:1},duration:{type:model.startsWith('seedance')?'number':'integer',minimum:2,maximum:30},aspect_ratio:{type:'string',enum:['adaptive','16:9','9:16']},reference_video_seconds:{anyOf:[{type:'number'},{type:'null'}]}},required:model==='seedance-2.5'?[]:['prompt']};
 if(model!=='minimax-h3')s.properties.resolution={type:'string',enum:resolutions};
 if(model==='seedance-2.5')s.anyOf=[{properties:{start_image:{type:'string'}}}];
 return s;
}
function fixture(options={}) {
 const calls=[];
 const fetchImpl=async(url,opts)=>{
  assert.equal(url,'https://api.krea.ai/mcp');
  assert.equal(opts.redirect,'error');
  const r=JSON.parse(opts.body),name=r.params?.name,args=r.params?.arguments;
  calls.push({method:r.method,name,args,headers:opts.headers});
  let result;
  if(r.method==='initialize') result={protocolVersion:options.version||'2025-11-25',capabilities:{tools:{},prompts:{},resources:{},extensions:{}},serverInfo:{name:'fixture',version:'1',title:'Fixture'},instructions:'fixture'};
  else if(r.method==='notifications/initialized') return new Response(null,{status:202});
  else if(r.method==='tools/list') {
   result={tools:structuredClone(tools)};
   if(options.legacyTool) {const legacy=structuredClone(result.tools.find(t=>t.name==='generate_video'));legacy.name='generate';result.tools.push(legacy);}
  }
  else {
   let data;
   if(name==='list_models')data={models:Object.values(pairs).flatMap(([id])=>(options.legacyIds?[id,`video/${id}`]:[id]).map(id=>({id,category:'video',name:'Fixture',description:'fixture'})))};
   if(name==='get_model_schema') { const model=Object.keys(pairs).find(k=>pairs[k][0]===args.model.replace(/^video\//,''));const inputSchema=options.simpleSchema?{type:'object',properties:{prompt:str,duration:{type:'integer'},resolution:{type:'string',enum:resolutions},aspect_ratio:{type:'string',enum:['16:9']}}}:schema(model);data={model:args.model,category:'video',name:'Fixture',endpointPath:`video/${args.model}`,inputSchema,outputSchemas:{}}; }
   if(name==='generate_video') {
    const model=Object.keys(pairs).find(k=>pairs[k][0]===args.model);
    const index=model==='minimax-h3'?0:resolutions.indexOf(args.input.resolution);
    data=args.preflight?{mode:'preflight',model:args.model,category:'video',compute_units:pairs[model][1][index],is_estimated:false,available_compute_units:5000.75,affordable:true}:{mode:'async',completed:false,timedOut:false,job_id:'00000000-0000-4000-8000-000000000001',job:{job_id:'00000000-0000-4000-8000-000000000001',status:'scheduled',type:'videoV2'}};
   }
   if(name==='get_job')data={job_id:args.jobId,status:'completed',type:'videoV2',result:{urls:['https://example.invalid/clip.mp4']}};
   if(name==='get_balance')data={plan:{id:'fixture',name:'Fixture plan',tier:'fixture',billing_period:'yearly',is_paid:true,monthly_compute_units:100000},compute_units:{total:1234.75,plan:1134.75,purchased:100,free:0}};
   result={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
  }
  const message={jsonrpc:'2.0',id:r.id,result};
  const replacement=options.change?.({r,name,args,message,calls});
  if(replacement)return replacement;
  return Response.json(message,{headers:r.method==='initialize'?{'Mcp-Session-Id':'fixture-session'}:{}});
 };
 return {calls,fetchImpl};
}
const request=(model,extra={})=>({action:'quote',model,prompt,...extra});
for(const [model,[id,prices]] of Object.entries(pairs)) for(let i=0;i<prices.length;i++) {
 const resolution=model==='minimax-h3'?undefined:resolutions[i];
 test(`recorded quote ${model} ${resolution||'fixed tier'}`,async()=>{
  const f=fixture();const actual=await run(request(model,resolution?{resolution}:{}),TOKEN,f);
  assert.deepEqual(actual,{mode:'preflight',compute_units:prices[i],is_estimated:false,available_compute_units:5000.75,affordable:true});
  assert.deepEqual(f.calls.at(-1).args,{model:id,input:{prompt,duration:5,aspect_ratio:'16:9',...(resolution?{resolution}:{})},preflight:true});
 });
}
test('isolated live tool name generate_video works without invented generate',async()=>{
 const f=fixture({version:'2025-06-18',legacyIds:true,simpleSchema:true});
 const result=await run(request('wan-3.0'),TOKEN,f);
 assert.equal(result.compute_units,555.5555555555555);
 assert.deepEqual(f.calls.filter(c=>c.name==='generate_video').map(c=>c.args.preflight),[true]);
});
test('isolated live open input schema keywords are accepted',async()=>{
 const f=fixture({version:'2025-06-18',legacyIds:true,simpleSchema:true,legacyTool:true});
 const result=await run(request('wan-3.0'),TOKEN,f);
 assert.equal(result.compute_units,555.5555555555555);
 assert.equal(f.calls.filter(c=>c.name==='generate_video').length,1);
});
test('protocol negotiation sends returned known version and refuses other versions',async()=>{
 for(const version of ['2025-06-18','2025-11-25']) {const f=fixture({version});await run(request('wan-3.0'),TOKEN,f);for(const c of f.calls.slice(1))assert.equal(new Headers(c.headers).get('mcp-protocol-version'),version);}
 const f=fixture({version:'2099-01-01'});await assert.rejects(run(request('wan-3.0'),TOKEN,f));assert.equal(f.calls.length,1);
});
test('submit sends identical input once and maps any paid failure to uncertain',async()=>{
 for(const failure of ['none','timeout','http','malformed','missing-id']) {
  const f=fixture({change:({name,args,message})=>{if(name!=='generate_video'||args.preflight)return;if(failure==='timeout')throw Error('network');if(failure==='http')return new Response('',{status:500});if(failure==='malformed')return new Response('{',{headers:{'content-type':'application/json'}});if(failure==='missing-id'){delete message.result.structuredContent.job_id;message.result.content[0].text=JSON.stringify(message.result.structuredContent);}}});
  const p={...request('wan-3.0',{resolution:'480p'}),action:'submit',maxUnits:300,confirmCharge:true};
  if(failure==='none')assert.deepEqual(await run(p,TOKEN,f),{id:'00000000-0000-4000-8000-000000000001',status:'scheduled'});else await assert.rejects(run(p,TOKEN,f),{code:'KREA_UNCERTAIN'});
  const sent=f.calls.filter(c=>c.name==='generate_video');assert.equal(sent.length,2);assert.equal(sent[0].args.preflight,true);assert.equal(sent[1].args.preflight,false);assert.deepEqual(sent[0].args.input,sent[1].args.input);
 }
});
test('plain preflight and cap are mandatory before paid send',async()=>{
 for(const change of [{mode:'async'},{job:null},{job_id:'unexpected'},{affordable:false},{compute_units:301},{compute_units:0}]) {
  const f=fixture({change:({name,args,message})=>{if(name==='generate_video'&&args.preflight){Object.assign(message.result.structuredContent,change);message.result.content[0].text=JSON.stringify(message.result.structuredContent);}}});
  await assert.rejects(run({...request('wan-3.0',{resolution:'480p'}),action:'submit',maxUnits:300,confirmCharge:true},TOKEN,f));assert.equal(f.calls.filter(c=>c.name==='generate_video'&&!c.args.preflight).length,0);
 }
});
test('status uses jobId and reports observed and unknown states without generation',async()=>{
 for(const status of ['scheduled','queued','processing','completed','future_state']) {
  const f=fixture({change:({name,message})=>{if(name==='get_job'){message.result.structuredContent.status=status;message.result.content[0].text=JSON.stringify(message.result.structuredContent);}}});
  const result=await run({action:'status',model:'wan-3.0',jobId:'job-1'},TOKEN,f);assert.equal(result.status,status);if(status==='completed')assert.equal(result.outputUrl,'https://example.invalid/clip.mp4');
  assert.deepEqual(f.calls.filter(c=>c.name).map(c=>[c.name,c.args]),[['get_job',{jobId:'job-1'}]]);
 }
});
test('balance calls only get_balance and command prints its values',async()=>{
 const f=fixture();const result=await run({action:'balance'},TOKEN,f);assert.deepEqual(result,{plan:{name:'Fixture plan',billing_period:'yearly',monthly_compute_units:100000},compute_units:{total:1234.75,plan:1134.75,purchased:100,free:0}});
 assert.deepEqual(f.calls.filter(c=>c.name).map(c=>[c.name,c.args]),[['get_balance',{}]]);
 let printed;await command(['balance','krea'],s=>printed=JSON.parse(s),{workspace:async req=>{assert.deepEqual(req,{action:'balance'});return result;}});assert.deepEqual(printed,result);
});
test('live schema drift in sent fields is refused before generation',async()=>{
 for(const mutation of [x=>x.models=[],x=>delete x.inputSchema.properties.prompt,x=>x.inputSchema.properties.duration.type='string',x=>x.inputSchema.properties.resolution.enum=['1080p'],x=>x.inputSchema.required=['start_image']]){
  const f=fixture({change:({name,message})=>{if(['list_models','get_model_schema'].includes(name)){const d=message.result.structuredContent;try{mutation(d)}catch{}message.result.content[0].text=JSON.stringify(d);}}});
  await assert.rejects(run(request('wan-3.0'),TOKEN,f));assert.equal(f.calls.filter(c=>c.name==='generate_video').length,0);
 }
 const f=fixture();await assert.rejects(run(request('minimax-h3',{resolution:'720p'}),TOKEN,f));assert.equal(f.calls.length,0);
});
test('workspace balance refuses negative monthly allocation',async()=>{
 const {result}=require('../src/video/workspace');
 const balance={plan:{name:'Fixture',billing_period:'yearly',monthly_compute_units:-1},compute_units:{total:1,plan:1,purchased:0,free:0}};
 assert.throws(()=>result({action:'balance'},balance),/Invalid Krea balance/);
});
test('recorded prompt length and duration schema boundaries are enforced',async()=>{
 const {prepare}=require('../src/video/krea-preset');
 for(const [model,id,max,type,minimum,maximum] of [['minimax-h3','minimax/hailuo-3',7000,'integer',5,15],['wan-3.0','alibaba/wan-3.0',5000,'integer',2,30],['seedance-2.0','bytedance/seedance-2',null,'number',4,15],['seedance-2.5','bytedance/seedance-2-5',null,'number',4,30]]) {
  const s=schema(model);if(max!==null)s.properties.prompt.maxLength=max;s.properties.duration={type,minimum,maximum};
  assert.equal(prepare(model,'x'.repeat(max || 1),[id],s).input.duration,5);
  if(max!==null)assert.throws(()=>prepare(model,'x'.repeat(max+1),[id],s),/schema/);
  s.properties.duration.minimum=6;assert.throws(()=>prepare(model,'x',[id],s),/schema/);
  s.properties.duration.minimum=minimum;s.properties.duration.maximum=4;assert.throws(()=>prepare(model,'x',[id],s),/schema/);
 }
});
test('helper IPC rejects token in output and sends no token in errors',async()=>{
 const {main}=require('../bin/dshproxy-krea');const {Readable}=require('node:stream');
 const makeStore=()=>({load:async()=>({accessToken:TOKEN,resource:'https://api.krea.ai/mcp',expiresAt:Date.now()+120000})});
 const output=[];
 await assert.rejects(main({args:[],input:Readable.from(['{"action":"balance"}']),makeStore,output:s=>output.push(s),run:async()=>({plan:{name:TOKEN}})}),e=>!String(e).includes(TOKEN));
 assert.deepEqual(output,[]);
 const f=fixture({change:()=>{throw Error(TOKEN)}});
 await assert.rejects(run(request('wan-3.0'),TOKEN,f),e=>!`${e.message}${e.stack}`.includes(TOKEN));
});
test('CLI propagates optional resolution without changing legacy quote shape',async()=>{
 let seen,output;await command(['quote','wan-3.0','krea','--prompt',prompt,'--resolution','1080p'],s=>output=JSON.parse(s),{workspace:async req=>{seen=req;return {mode:'preflight',compute_units:1.25,is_estimated:false,available_compute_units:10,affordable:true};}});
 assert.deepEqual(seen,request('wan-3.0',{resolution:'1080p'}));assert.equal(output.compute_units,1.25);assert.equal(output.route,'krea');
 await command(['submit','wan-3.0','krea','--max-units','1.25','--confirm-charge','--resolution','480p',prompt],()=>{},{workspace:async req=>{assert.deepEqual(req,{action:'submit',model:'wan-3.0',prompt,maxUnits:1.25,confirmCharge:true,resolution:'480p'});return {id:'job-1',status:'scheduled'};}});
});
