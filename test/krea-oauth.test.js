'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const resource='https://api.krea.ai/mcp', issuer='https://api.krea.ai';
const callback='http://127.0.0.1:12345/callback';
function fixture(overrides={}) {
  const calls=[]; let saved, url;
  const responses=[{resource,authorization_servers:[issuer]}, {issuer, authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',registration_endpoint:issuer+'/register',code_challenge_methods_supported:['S256'],response_types_supported:['code']}, {client_id:'public-client',token_endpoint_auth_method:'none',redirect_uris:[callback]}, {access_token:'synthetic-access',refresh_token:'discard',token_type:'Bearer',expires_in:1800}];
  return {calls,responses,get saved(){return saved},get url(){return url}, options:{
    fetchImpl:async (u,o)=>{calls.push({u:String(u),o}); return Response.json(responses[calls.length-1]);},
    openCallback:async state=>({redirectUri:callback,wait:async()=>({code:'fake-code',state}),close(){}}),showUrl:value=>{url=new URL(value)},store:{save:async v=>{saved=v}},now:()=>1000,...overrides}};
}
test('login exchanges only an S256-bound authorization code for a resource-specific bearer session',async()=>{
 const f=fixture(); const {login}=require('../src/krea-helper/oauth'); await login(f.options);
 assert.equal(f.calls.length,4); assert.deepEqual(JSON.parse(f.calls[2].o.body).grant_types,['authorization_code']); assert.equal(f.url.origin,issuer); assert.equal(f.url.searchParams.get('resource'),resource);
 const body=new URLSearchParams(f.calls[3].o.body);assert.equal(body.get('resource'),resource);assert.equal(body.get('redirect_uri'),callback);
 assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),f.url.searchParams.get('code_challenge'));assert.equal(f.url.searchParams.get('code_challenge_method'),'S256');
 assert.deepEqual(f.saved,{accessToken:'synthetic-access',expiresAt:1801000,resource,clientId:'public-client',tokenEndpoint:issuer+'/token',refreshToken:'discard'}); assert.ok(f.calls.every(c=>c.o.redirect==='error'));
});
const {login,access}=require('../src/krea-helper/oauth');
const {main}=require('../bin/dshproxy-krea');
const {Readable}=require('node:stream');
test('login refuses untrusted metadata before callback, registration or authorization',async()=>{
 for(const corrupt of [r=>r[0].resource+='2',r=>r[0].authorization_servers=['https://api.krea.ai.attacker.invalid'],r=>r[1].issuer+='/other',r=>r[1].code_challenge_methods_supported=['plain'],r=>r[1].authorization_endpoint='https://external.invalid/a',r=>r[1].token_endpoint='https://api.krea.ai@external.invalid/token',r=>r[1].registration_endpoint='https://external.invalid/register']){
  const f=fixture();corrupt(f.responses);await assert.rejects(login(f.options));assert.equal(f.url,undefined);assert.equal(f.saved,undefined);assert.ok(f.calls.length<=2);
 }
});
test('public client ID avoids registration; invalid callback state never exchanges a code',async()=>{
 let closed=false;const f=fixture({clientId:'existing-public',openCallback:async()=>({redirectUri:callback,wait:async()=>({state:'other',code:'synthetic'}),close(){closed=true;}})});
 await assert.rejects(login(f.options));assert.equal(closed,true);assert.equal(f.calls.length,2);assert.equal(f.saved,undefined);assert.equal(f.url.searchParams.get('client_id'),'existing-public');
});
test('opaque sessions must be unexpired, bearer and bound to the resource',async()=>{
 for(const change of [{expires_in:30},{access_token:'test\ninvalid'},{token_type:'other'},{resource:'https://api.krea.ai/other'}]){
  const f=fixture();Object.assign(f.responses[3],change);await assert.rejects(login(f.options));assert.equal(f.saved,undefined);
 }
 const valid={resource,expiresAt:99999,accessToken:'synthetic-token'};
 for(const change of [{expiresAt:30000},{resource:'other'},{accessToken:''}])await assert.rejects(access({load:async()=>({...valid,...change})},()=>0),/KREA_LOGIN_REQUIRED/);
 assert.equal(await access({load:async()=>valid},()=>0),'synthetic-token');
});
function io(text,run){const output=[];return {output,params:{args:[],input:Readable.from([text]),output:s=>output.push(s),makeStore:()=>({load:async()=>({accessToken:'synthetic-bearer',resource,expiresAt:Date.now()+120000})}),run}};}
test('IPC processes exactly one request; disallows multi-call and never returns a credential',async()=>{
 let calls=0;const x=io('{"action":"quote"}\n',async(req,token)=>{calls++;assert.equal(token,'synthetic-bearer');assert.equal(req.action,'quote');return {amount:10}});await main(x.params);assert.deepEqual(x.output,['{"amount":10}']);assert.equal(calls,1);
 for(const text of ['{"action":"quote"}\n{"action":"submit"}\n','{"action":"login"}\n']){const y=io(text,async()=>{calls++});await assert.rejects(main(y.params));assert.deepEqual(y.output,[]);}assert.equal(calls,1);
 for(const response of [{nested:['synthetic-bearer']},{'synthetic-bearer':1},{authorization:'other'},{secret:'rejected'},{unserializable:1n}]){const y=io('{"action":"submit"}',async()=>response);await assert.rejects(main(y.params),/KREA_UNCERTAIN/);assert.deepEqual(y.output,[]);}
});
test('companion hides unsafe upstream error details and never retries a submit',async()=>{
 let count=0;const y=io('{"action":"submit"}',async()=>{count++;throw Error('unsafe sample')});await assert.rejects(main(y.params),/^Error: KREA_UNCERTAIN$/);assert.equal(count,1);assert.deepEqual(y.output,[]);
});

// ------------------------------- status: is a sign-in present -------------------------------

const oauth=require('../src/krea-helper/oauth');
const TOKEN='synthetic-STATUS-bearer.0042';
const NOW=1789999000000;
const session=(change={})=>({accessToken:TOKEN,resource,expiresAt:NOW+3600000,...change});
const signedOut=[
 ['expired',{load:async()=>session({expiresAt:NOW-1})}],
 ['30 seconds left',{load:async()=>session({expiresAt:NOW+30000})}],
 ['missing',{load:async()=>{throw Object.assign(Error('ENOENT: no such file'),{code:'ENOENT'})}}],
 ['unreadable store',{load:async()=>{throw Error('KREA_REFUSED')}}],
 ['another resource',{load:async()=>session({resource:'https://api.krea.ai/other'})}],
 ['no resource',{load:async()=>({accessToken:TOKEN,expiresAt:NOW+3600000})}],
 ['empty token',{load:async()=>session({accessToken:''})}],
 ['token with a line break',{load:async()=>session({accessToken:'synthetic\nSTATUS'})}],
 ['token that is not text',{load:async()=>session({accessToken:7})}],
 ['expiry as text',{load:async()=>session({expiresAt:String(NOW+3600000)})}],
 ['fractional expiry',{load:async()=>session({expiresAt:NOW+3600000.5})}],
 ['endless expiry',{load:async()=>session({expiresAt:Infinity})}],
 ['no expiry',{load:async()=>({accessToken:TOKEN,resource})}],
 ['null session',{load:async()=>null}],
 ['text session',{load:async()=>TOKEN}],
 ['list session',{load:async()=>[session()]}],
 ['store without load',{}],
 ['no store',undefined],
];
test('status reports a stored session that a request would accept, with its expiry and nothing else',async()=>{
 const state=await oauth.status({load:async()=>session()},()=>NOW);
 assert.deepEqual(state,{signedIn:true,expiresAt:NOW+3600000,canRenew:false});
 assert.equal(JSON.stringify(state),`{"signedIn":true,"expiresAt":${NOW+3600000},"canRenew":false}`);
 assert.deepEqual(await oauth.status({load:async()=>session({expiresAt:NOW+30001})},()=>NOW),{signedIn:true,expiresAt:NOW+30001,canRenew:false});
 // More than was stored never comes out, whatever the store holds.
 assert.deepEqual(await oauth.status({load:async()=>session({refreshToken:'synthetic-STATUS-refresh',note:TOKEN})},()=>NOW),{signedIn:true,expiresAt:NOW+3600000,canRenew:false});
 assert.equal(await access({load:async()=>session()},()=>NOW),TOKEN);
});
test('status is signed out for an expired, missing or corrupt session, exactly where a request would ask for a sign-in',async()=>{
 for(const [name,store] of signedOut){
  const state=await oauth.status(store,()=>NOW);
  assert.deepEqual(state,{signedIn:false,canRenew:false},name);assert.equal(JSON.stringify(state),'{"signedIn":false,"canRenew":false}',name);
  await assert.rejects(access(store,()=>NOW),/KREA_LOGIN_REQUIRED/,name);
 }
});
test('status never changes or clears the store',async()=>{
 const touched=[];const store={load:async()=>session(),save:async()=>{touched.push('save')},clear:async()=>{touched.push('clear')}};
 await oauth.status(store,()=>NOW);await oauth.status({...store,load:async()=>null},()=>NOW);assert.deepEqual(touched,[]);
});
// The helper command. Standard input, the workspace client and the network must stay unused.
function statusRun(makeStore,args=['status']){
 const output=[];let used=0;
 const input={[Symbol.asyncIterator](){used++;throw Error('standard input was read')}};
 return {output,get used(){return used},params:{args,input,output:s=>output.push(s),makeStore,run:async()=>{used++;throw Error('workspace client was used')}}};
}
test('helper status prints exactly one JSON line and succeeds whether signed in or not, contacting nothing',async t=>{
 const realFetch=globalThis.fetch;let fetched=0;globalThis.fetch=async()=>{fetched++;throw Error('network is forbidden in this test')};t.after(()=>{globalThis.fetch=realFetch});
 const expiresAt=Date.now()+3600000;
 const present=statusRun(()=>({load:async()=>session({expiresAt})}));
 assert.equal(await main(present.params),undefined);
 assert.deepEqual(present.output,[`{"signedIn":true,"expiresAt":${expiresAt},"canRenew":false}`]);
 assert.equal(present.output.join('').includes(TOKEN),false);assert.equal(present.used,0);

 const absent=[['expired',()=>({load:async()=>session({expiresAt:Date.now()-1000})})],['about to expire',()=>({load:async()=>session({expiresAt:Date.now()+20000})})],
  ['missing',()=>({load:async()=>{throw Object.assign(Error('ENOENT'),{code:'ENOENT'})}})],['corrupt',()=>({load:async()=>{throw Error('KREA_REFUSED')}})],
  ['wrong shape',()=>({load:async()=>({accessToken:TOKEN})})],['no store on this system',()=>{throw Error('KREA_REFUSED')}]];
 for(const [name,makeStore] of absent){
  const x=statusRun(makeStore);assert.equal(await main(x.params),undefined,name);
  assert.deepEqual(x.output,[name==='no store on this system' ? '{"signedIn":false}' : '{"signedIn":false,"canRenew":false}'],name);assert.equal(x.used,0,name);
 }
 assert.equal(fetched,0);
});
test('helper status takes no further argument, and sign-out still clears the store',async()=>{
 for(const args of [['status','--json'],['status','status'],['status','login'],['--status'],['Status']]){
  let made=0;const x=statusRun(()=>{made++;return {load:async()=>session({expiresAt:Date.now()+3600000})}},args);
  await assert.rejects(main(x.params),/KREA_REFUSED/,args.join(' '));assert.deepEqual(x.output,[]);assert.equal(made,0);
 }
 const touched=[];const x=statusRun(()=>({load:async()=>{touched.push('load');return session()},clear:async()=>{touched.push('clear')}}),['logout']);
 await main(x.params);assert.deepEqual(touched,['clear']);assert.deepEqual(x.output,[]);
});
test('the real helper with an empty or damaged temporary store answers signed out, exits 0 and writes nothing',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const {spawnSync}=require('node:child_process');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dshproxy-krea-status-'));
 const helper=path.resolve(__dirname,'../bin/dshproxy-krea.js');
 const run=(env)=>spawnSync(process.execPath,[helper,'status'],{env:{SystemRoot:process.env.SystemRoot,HOME:dir,USERPROFILE:dir,TEMP:dir,TMP:dir,...env},input:'{"action":"quote"}\n',encoding:'utf8',windowsHide:true,timeout:20000});
 const signedOutLine=r=>{assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'{"signedIn":false,"canRenew":false}\n');assert.equal(r.stderr,'');};
 try {
  signedOutLine(run({LOCALAPPDATA:dir}));
  assert.deepEqual(await fs.readdir(dir),[]);
  // No store location at all, as on a system this helper does not support.
  const unsupported=run({});assert.equal(unsupported.status,0,unsupported.stderr);assert.equal(unsupported.stdout,'{"signedIn":false}\n');assert.equal(unsupported.stderr,'');
  // A session file that is not one: refused before Windows is asked to unwrap anything.
  const store=path.join(dir,'DSHProxy','KreaOAuth');await fs.mkdir(store,{recursive:true});
  for(const text of ['not a session {','["only","two"]','{"accessToken":"synthetic-STATUS-plain","resource":"https://api.krea.ai/mcp","expiresAt":99999999999999}','']){
   await fs.writeFile(path.join(store,'session.v1'),text);
   signedOutLine(run({LOCALAPPDATA:dir}));
   assert.equal(await fs.readFile(path.join(store,'session.v1'),'utf8'),text);
   assert.deepEqual(await fs.readdir(store),['session.v1']);
  }
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
