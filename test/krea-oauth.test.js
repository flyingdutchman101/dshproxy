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
 assert.equal(f.calls.length,4); assert.equal(f.url.origin,issuer); assert.equal(f.url.searchParams.get('resource'),resource);
 const body=new URLSearchParams(f.calls[3].o.body);assert.equal(body.get('resource'),resource);assert.equal(body.get('redirect_uri'),callback);
 assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),f.url.searchParams.get('code_challenge'));assert.equal(f.url.searchParams.get('code_challenge_method'),'S256');
 assert.deepEqual(f.saved,{accessToken:'synthetic-access',expiresAt:1801000,resource}); assert.ok(f.calls.every(c=>c.o.redirect==='error'));
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
