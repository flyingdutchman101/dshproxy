'use strict';
// This module belongs exclusively to the standalone companion. Never import from DSHProxy.
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {withLock} = require('../filelock');
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
async function jsonRequest(fetchImpl, url, options={}, timeoutMs=15000) {
  const response = await fetchImpl(url, {...options, redirect:'error', signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok) { const e=Error('KREA_REFUSED');e.status=response.status;throw e; }
  check(response.body);let size=0;const parts=[];
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
async function login(options) {
  // The store is locked only while the new sign-in is saved, not while the
  // consent page is open: calls with the present sign-in go on meanwhile.
  const {store, clientId:givenClientId, fetchImpl=globalThis.fetch, openCallback=openLoopback, showUrl, now=Date.now}=options;
  let clientId=givenClientId;
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
      const register=grants=>jsonRequest(fetchImpl,registration,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'DSHProxy Krea companion',redirect_uris:[callback.redirectUri],grant_types:grants,response_types:['code'],token_endpoint_auth_method:'none'})});
      // Renewal is asked for where Krea offers it. A registration that Krea
      // turns down for that reason is made again without it: a sign-in that
      // lasts an hour is better than none.
      const renewing=Array.isArray(as.grant_types_supported) && as.grant_types_supported.includes('refresh_token');
      let registered;
      try { registered=await register(renewing ? ['authorization_code','refresh_token'] : ['authorization_code']); }
      catch(e) { if(!renewing || !(e.status>=400 && e.status<500)) throw e; registered=await register(['authorization_code']); }
      check(validId(registered.client_id) && !registered.client_secret && registered.token_endpoint_auth_method==='none' && Array.isArray(registered.redirect_uris) && registered.redirect_uris.includes(callback.redirectUri));clientId=registered.client_id;
    }
    authorize.search=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:callback.redirectUri,state,code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),resource}).toString();
    showUrl(authorize.href);
    const result=await callback.wait();check(result.state===state && validId(result.code) && (!result.issuer || result.issuer===issuer));
    const t=await jsonRequest(fetchImpl,token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,redirect_uri:callback.redirectUri,code:result.code,code_verifier:verifier,resource}).toString()});
    check(validToken(t.access_token) && typeof t.token_type==='string' && t.token_type.toLowerCase()==='bearer' && Number.isSafeInteger(t.expires_in) && t.expires_in>30 && t.expires_in<=31622400);
    if(t.resource!==undefined) check(t.resource===resource);
    if(t.refresh_token!==undefined) check(validToken(t.refresh_token));
    await store.save({accessToken:t.access_token,expiresAt:now()+t.expires_in*1000,resource,clientId,tokenEndpoint:token.href,...(t.refresh_token ? {refreshToken:t.refresh_token} : {})});
  } finally {callback.close();}
}
// DPAPI protects only an independent AES key. No OAuth token ever crosses the
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
const IN_USE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Tries again for a moment while Windows says another program has the file open.
async function patiently(work) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await work(); }
    catch (e) { if (!IN_USE.has(e.code) || attempt === 6) throw e; await pause(10 << attempt); }
  }
}
// The sign-in on disk: one file, encrypted for the current Windows user, in
// <LOCALAPPDATA>/DSHProxy/KreaOAuth.
//
//   load()              the stored session; throws when there is none
//   save(s), clear()    each under the lock
//   transaction(work)   runs work({load, save, clear}) under the lock
//
// The lock is the one of src/filelock.js: it names its holder, so a helper
// that died is recognised at once and its lock taken over; nobody has to
// clear anything by hand. A lock held by a helper that is alive is taken over
// only after two minutes. A renewal cannot take that long: unlocking the key
// twice, the request and saving twice have ten seconds each at most, and a
// helper started for a workspace call is ended after 90 seconds.
const LOCK_STALE_MS = 120000;
function windowsStore({lockWaitMs=30000}={}) {
  check(process.platform==='win32' && process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA));
  const dir=path.join(process.env.LOCALAPPDATA,'DSHProxy','KreaOAuth');const file=path.join(dir,'session.v1');
  const raw={async save(session){
    const key=crypto.randomBytes(32),iv=crypto.randomBytes(12);let packed;
    try {const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(JSON.stringify(session),'utf8'),cipher.final()]);
      packed=JSON.stringify([await dpapi('Protect',key),iv,cipher.getAuthTag(),data].map(x=>x.toString('base64')));
    }finally{key.fill(0)}
    await fs.mkdir(dir,{recursive:true});
    // Written beside the file, flushed to the disk, then put in its place: a
    // reader sees the old sign-in or the new one, and a renewed sign-in that
    // was reported as saved is on the disk.
    const temporary=`${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      const h=await fs.open(temporary,'wx',0o600);
      try{await h.writeFile(packed);await h.sync();}finally{await h.close()}
      await patiently(()=>fs.rename(temporary,file));
    } finally {await fs.rm(temporary,{force:true}).catch(()=>{});}
  },async load(){const h=await patiently(()=>fs.open(file,'r'));let packed;try{check((await h.stat()).size<=65536);packed=JSON.parse(await h.readFile('utf8'));}finally{await h.close()}
    check(Array.isArray(packed) && packed.length===4 && packed.every(v=>typeof v==='string' && /^[A-Za-z0-9+/]+={0,2}$/.test(v)));
    const [wrapped,iv,tag,data]=packed.map(v=>Buffer.from(v,'base64'));check(iv.length===12 && tag.length===16);
    const key=await dpapi('Unprotect',wrapped);try{const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'));}finally{key.fill(0)}
  },async clear(){await patiently(()=>fs.rm(file,{force:true}));}};
  // `waitMs` is how long this call waits for the lock, if not the store's own time.
  async function transaction(work,{waitMs=lockWaitMs}={}) {
    await fs.mkdir(dir,{recursive:true});
    let finished=false,result;
    try { await withLock(file,async()=>{result=await work(raw);finished=true;},{waitMs,staleMs:LOCK_STALE_MS}); }
    // The work is done and its result stands even when the lock was taken
    // over meanwhile; anything else is a failure of the work or of the wait.
    catch(e) { if(!finished) throw e; }
    return result;
  }
  return {load:raw.load,transaction,save:s=>transaction(store=>store.save(s)),clear:()=>transaction(store=>store.clear())};
}

// ------------------------------- staying signed in -------------------------------
//
// Krea's access token lasts an hour. A sign-in that came with a renewal token
// is renewed by the helper itself, with one request to Krea's token endpoint,
// when a call finds less than two minutes left: more than the 90 seconds a
// workspace request may take. A sign-in without one works until 30 seconds
// before its end and then needs a new sign-in, as before.
//
// What a failed renewal means:
//   400, 401, 403   Krea no longer accepts the renewal token. It is dropped;
//                   the sign-in works for what is left of its hour and then a
//                   new sign-in is needed (KREA_LOGIN_REQUIRED).
//   anything else   (no answer, 408, 425, 429, 5xx, an answer that cannot be
//                   read) nothing is changed and the next call tries again
//                   with the same renewal token. Until then KREA_REFUSED,
//                   unless the access token is still good.
// Trying the same renewal token again is safe: at worst Krea had already
// replaced it and refuses, which is the first case.
const RENEW_MARGIN_MS = 120000;
const PLAIN_MARGIN_MS = 30000;
const RENEW_TIMEOUT_MS = 10000;
const STATUS_LOCK_WAIT_MS = 5000;
function validSession(s) {
  return Boolean(s) && typeof s==='object' && !Array.isArray(s) && s.resource===resource && validToken(s.accessToken) && Number.isSafeInteger(s.expiresAt);
}
// Whether a session carries what a renewal needs. The token endpoint must be
// one of Krea's own https addresses: a renewal token is sent nowhere else.
function renewable(s) {
  if(!validSession(s) || !validId(s.clientId) || !validToken(s.refreshToken)) return false;
  try { endpoint(s.tokenEndpoint);return true; } catch { return false; }
}
function validAnswer(t) {
  // As at sign-in: a token must outlast the thirty seconds a call needs.
  check(validToken(t.access_token) && typeof t.token_type==='string' && t.token_type.toLowerCase()==='bearer' && Number.isSafeInteger(t.expires_in) && t.expires_in>PLAIN_MARGIN_MS/1000 && t.expires_in<=31622400);
  if(t.resource!==undefined) check(t.resource===resource);
  if(t.refresh_token!==undefined) check(validToken(t.refresh_token));
}
const loginRequired=()=>Error('KREA_LOGIN_REQUIRED');
const usable=(s,now)=>s.expiresAt>now()+PLAIN_MARGIN_MS;
const fresh=(s,now)=>s.expiresAt>now()+(renewable(s)?RENEW_MARGIN_MS:PLAIN_MARGIN_MS);
// One renewal, under the store's lock. `locked` is the store inside the lock.
async function renew(locked,now,fetchImpl) {
  let s;
  // It was read a moment ago, before the lock. Gone now means signed out
  // meanwhile; any other failure to read it is a fault of this moment.
  try { s=await locked.load(); } catch(e) { throw e && e.code==='ENOENT' ? loginRequired() : Error('KREA_REFUSED'); }
  if(!validSession(s)) throw loginRequired();
  // Another helper renewed it while this one waited for the lock.
  if(fresh(s,now)) return s;
  if(!renewable(s)) throw loginRequired();
  let t;
  try {
    t=await jsonRequest(fetchImpl,endpoint(s.tokenEndpoint),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:s.refreshToken,client_id:s.clientId,resource}).toString()},RENEW_TIMEOUT_MS);
    if(t.error!==undefined) { const e=Error('KREA_REFUSED');e.status=400;throw e; }
    validAnswer(t);
  } catch(e) {
    if([400,401,403].includes(e && e.status)) {
      // Refused. Unless the stored renewal token is no longer the one that
      // was sent: then another helper renewed meanwhile (this one's lock
      // was taken over), and its sign-in stands.
      let stored=s;
      try { stored=await locked.load(); } catch { /* judged by what was read before */ }
      if(validSession(stored) && stored.refreshToken!==s.refreshToken) { if(usable(stored,now)) return stored; throw Error('KREA_REFUSED'); }
      const {refreshToken,...rest}=s;
      // If this cannot be saved the next call asks Krea again and is refused again.
      try { await locked.save(rest); } catch { /* see above */ }
      if(usable(rest,now)) return rest;
      throw loginRequired();
    }
    if(usable(s,now)) return s;
    throw Error('KREA_REFUSED');
  }
  const next={...s,accessToken:t.access_token,expiresAt:now()+t.expires_in*1000,refreshToken:t.refresh_token || s.refreshToken};
  // The renewed sign-in is good whether or not it could be stored; stored it
  // must be for the next call, so a save that fails is tried once more.
  try { await locked.save(next); } catch { await pause(200); try { await locked.save(next); } catch { /* this call still has its token */ } }
  return next;
}
// The session in force now, renewed first when it is about to end. `wait`,
// when given, is passed to the store's lock.
async function current(store,now,fetchImpl,wait) {
  let s;
  try { s=await store.load(); } catch { throw loginRequired(); }
  if(!validSession(s)) throw loginRequired();
  if(fresh(s,now)) return s;
  if(!renewable(s) || typeof store.transaction!=='function') { if(usable(s,now)) return s; throw loginRequired(); }
  try { return await (wait ? store.transaction(locked=>renew(locked,now,fetchImpl),wait) : store.transaction(locked=>renew(locked,now,fetchImpl))); }
  catch(e) {
    if(e && e.message==='KREA_LOGIN_REQUIRED') throw e;
    // The lock could not be had in time, or the renewal could not be done just now.
    if(usable(s,now)) return s;
    throw Error('KREA_REFUSED');
  }
}
// The access token for one workspace call. KREA_LOGIN_REQUIRED: a new sign-in
// is needed. KREA_REFUSED: the sign-in could not be renewed just now.
async function access(store,now=Date.now,{fetchImpl=globalThis.fetch}={}) {
  try { return (await current(store,now,fetchImpl)).accessToken; }
  catch(e) { throw Error(e && e.message==='KREA_REFUSED' ? 'KREA_REFUSED' : 'KREA_LOGIN_REQUIRED'); }
}
// Whether a sign-in is present, renewing it first when it is about to end, so
// that "signed in" means the next call will work. Never exposes a credential.
//   {signedIn:true, expiresAt, canRenew}   canRenew: it renews itself
//   {signedIn:false, canRenew}             canRenew: a later call may still renew it
async function status(store,now=Date.now,{fetchImpl=globalThis.fetch}={}) {
  // The desktop app gives this command twenty seconds: it does not wait long for the lock.
  try { const s=await current(store,now,fetchImpl,{waitMs:STATUS_LOCK_WAIT_MS}); return {signedIn:true,expiresAt:s.expiresAt,canRenew:renewable(s)}; } catch { /* not usable now */ }
  try { return {signedIn:false,canRenew:renewable(await store.load())}; } catch { return {signedIn:false,canRenew:false}; }
}
module.exports={login,access,status,windowsStore};
