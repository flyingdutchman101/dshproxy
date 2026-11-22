'use strict';
// This module belongs exclusively to the standalone companion. Never import from DSHProxy.
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const resource = 'https://api.krea.ai/mcp';
const trusted = new Set(['https://api.krea.ai', 'https://krea.ai', 'https://www.krea.ai']);
function check(ok) { if (!ok) throw Error('KREA_REFUSED'); }
function validId(s) { return typeof s === 'string' && /^[A-Za-z0-9._~:\/-]{1,512}$/.test(s); }
function validToken(s) { return typeof s === 'string' && /^[A-Za-z0-9._~+/=-]{1,16384}$/.test(s); }
function endpoint(value, origin) {
  check(typeof value === 'string'); const url = new URL(value);
  check(trusted.has(url.origin) && (!origin || url.origin === origin) && !url.username && !url.password && !url.search && !url.hash && !value.includes('\\') && !/\s/.test(value));
  return url;
}
async function jsonRequest(fetchImpl, url, options={}) {
  const response = await fetchImpl(url, {...options, redirect:'error', signal:AbortSignal.timeout(15000)});
  check(response.ok && response.body);let size=0;const parts=[];
  for await (const chunk of response.body) {size+=chunk.length;check(size<=131072);parts.push(chunk);}
  const json=JSON.parse(Buffer.concat(parts).toString('utf8'));check(json && typeof json==='object' && !Array.isArray(json));return json;
}
async function openLoopback(expectedState) {
  let resolve, reject, port;
  const received=new Promise((a,b)=>{resolve=a; reject=b}); received.catch(()=>{});
  let completed=false;
  const server=http.createServer({requestTimeout:5000,headersTimeout:5000,maxHeaderSize:8192},(req,res)=>{
    const fail=()=>{res.writeHead(400,{'Cache-Control':'no-store'});res.end('Not accepted.');};
    try {
      if(completed || req.method!=='GET' || req.headers.host!==`127.0.0.1:${port}` || !req.url.startsWith('/callback?')) return fail();
      const url=new URL(req.url,`http://127.0.0.1:${port}`);const params=url.searchParams;
      if(url.pathname!=='/callback' || params.getAll('state').length!==1 || params.get('state')!==expectedState) return fail();
      completed=true;
      if(params.has('error') || params.getAll('code').length!==1 || !validId(params.get('code'))) {reject(Error('KREA_REFUSED'));return fail();}
      res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}); res.end('Authorization received. Close this tab.');
      resolve({state:expectedState, code:params.get('code'),issuer:params.get('iss')});
    } catch {fail();}
  });
  await new Promise((a,b)=>{server.once('error',b);server.listen(0,'127.0.0.1',a)});port=server.address().port;
  server.on('error',()=>reject(Error('KREA_REFUSED'))); const timer=setTimeout(()=>reject(Error('KREA_REFUSED')),180000);
  return {redirectUri:`http://127.0.0.1:${port}/callback`,wait:()=>received,close(){clearTimeout(timer);server.close();server.closeAllConnections();}};
}
async function login({clientId, fetchImpl=globalThis.fetch, openCallback=openLoopback, showUrl, store, now=Date.now}) {
  if(clientId!==undefined) check(validId(clientId));
  const meta=await jsonRequest(fetchImpl,'https://api.krea.ai/.well-known/oauth-protected-resource/mcp');
  check(meta.resource===resource && Array.isArray(meta.authorization_servers) && meta.authorization_servers.length===1);
  const issuer=meta.authorization_servers[0];const i=endpoint(issuer);
  const metadataUrl=i.origin+'/.well-known/oauth-authorization-server'+(i.pathname==='/'?'':i.pathname);
  const as=await jsonRequest(fetchImpl,metadataUrl);check(as.issuer===issuer);
  const authorize=endpoint(as.authorization_endpoint,i.origin), token=endpoint(as.token_endpoint,i.origin);
  check(Array.isArray(as.code_challenge_methods_supported) && as.code_challenge_methods_supported.includes('S256') && Array.isArray(as.response_types_supported) && as.response_types_supported.includes('code'));
  if(as.token_endpoint_auth_methods_supported) check(Array.isArray(as.token_endpoint_auth_methods_supported) && as.token_endpoint_auth_methods_supported.includes('none'));
  const verifier=crypto.randomBytes(48).toString('base64url'), state=crypto.randomBytes(32).toString('base64url');
  const callback=await openCallback(state);
  try {
    if(!clientId) {
      const registration=endpoint(as.registration_endpoint,i.origin);
      const registered=await jsonRequest(fetchImpl,registration,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'DSHProxy Krea companion',redirect_uris:[callback.redirectUri],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'})});
      check(validId(registered.client_id) && !registered.client_secret && registered.token_endpoint_auth_method==='none' && Array.isArray(registered.redirect_uris) && registered.redirect_uris.includes(callback.redirectUri));clientId=registered.client_id;
    }
    authorize.search=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:callback.redirectUri,state,code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),resource}).toString();
    showUrl(authorize.href);
    const result=await callback.wait();check(result.state===state && validId(result.code) && (!result.issuer || result.issuer===issuer));
    const t=await jsonRequest(fetchImpl,token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,redirect_uri:callback.redirectUri,code:result.code,code_verifier:verifier,resource}).toString()});
    check(validToken(t.access_token) && typeof t.token_type==='string' && t.token_type.toLowerCase()==='bearer' && Number.isSafeInteger(t.expires_in) && t.expires_in>30 && t.expires_in<=31622400);
    if(t.resource!==undefined) check(t.resource===resource);
    await store.save({accessToken:t.access_token,expiresAt:now()+t.expires_in*1000,resource});
  } finally {callback.close();}
}
// DPAPI protects only an independent AES key. The OAuth token never crosses the
// PowerShell subprocess boundary. Both programs and pipes are non-interactive.
function dpapi(mode,data) {
  check(process.platform==='win32' && ['Protect','Unprotect'].includes(mode));
  const root=process.env.SystemRoot;check(root && path.win32.isAbsolute(root));
  const ps=path.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $o=[Security.Cryptography.ProtectedData]::${mode}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
  return new Promise((resolve,reject)=>{const fail=()=>reject(Error('KREA_REFUSED'));
    const child=execFile(ps,['-NoProfile','-NoLogo','-NonInteractive','-Command',script],{timeout:10000,maxBuffer:32768,windowsHide:true,env:{SystemRoot:root,WINDIR:root,LOCALAPPDATA:process.env.LOCALAPPDATA,TEMP:process.env.TEMP}},(err,out)=>{
      if(err || !/^[A-Za-z0-9+/]+={0,2}$/.test(out))return fail();resolve(Buffer.from(out,'base64'));
    });child.stdin.on('error',fail);child.stdin.end(data.toString('base64'));
  });
}
function windowsStore() {
  check(process.platform==='win32' && process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA));
  const dir=path.join(process.env.LOCALAPPDATA,'DSHProxy','KreaOAuth');const file=path.join(dir,'session.v1');
  return {async save(session){
    const key=crypto.randomBytes(32),iv=crypto.randomBytes(12);let packed;
    try {const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(JSON.stringify(session),'utf8'),cipher.final()]);
      packed=JSON.stringify([await dpapi('Protect',key),iv,cipher.getAuthTag(),data].map(x=>x.toString('base64')));
    }finally{key.fill(0)}
    await fs.mkdir(dir,{recursive:true});const tmp=path.join(dir,crypto.randomUUID()+'.tmp');
    try {await fs.writeFile(tmp,packed,{flag:'wx',mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}
  },async load(){const h=await fs.open(file,'r');let packed;try{check((await h.stat()).size<=65536);packed=JSON.parse(await h.readFile('utf8'));}finally{await h.close()}
    check(Array.isArray(packed) && packed.length===4 && packed.every(v=>typeof v==='string' && /^[A-Za-z0-9+/]+={0,2}$/.test(v)));
    const [wrapped,iv,tag,data]=packed.map(v=>Buffer.from(v,'base64'));check(iv.length===12 && tag.length===16);
    const key=await dpapi('Unprotect',wrapped);try{const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'));}finally{key.fill(0)}
  },async clear(){await fs.rm(file,{force:true});}};
}
// The one rule for a usable sign-in: a stored session for the Krea resource
// with a well-formed token and more than 30 seconds left.
async function usable(store,now) {
  const s=await store.load();check(s.resource===resource && validToken(s.accessToken) && Number.isSafeInteger(s.expiresAt) && s.expiresAt>now()+30000);return s;
}
async function access(store,now=Date.now) {
  try{return (await usable(store,now)).accessToken;}catch{throw Error('KREA_LOGIN_REQUIRED');}
}
// Whether a request would find a sign-in, and until when. Never the token.
// Any failure to read the store counts as signed out. Contacts nothing.
async function status(store,now=Date.now) {
  try{return {signedIn:true,expiresAt:(await usable(store,now)).expiresAt};}catch{return {signedIn:false};}
}
module.exports={login,access,status,windowsStore};
