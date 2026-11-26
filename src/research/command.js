'use strict';
const fs = require('node:fs');
const path = require('node:path');
const secrets = require('../secrets');
const { withLock, replaceFile } = require('../filelock');
const { homeDir } = require('../settings');

// Verified against https://docs.foreplay.co/openapi.json (2026-11-26).
// Authorization is the raw API key, not a Bearer token. No auto-pagination.
const LIMIT = 10;
const MAX_BODY = 2 * 1024 * 1024;
const TIMEOUT = 15000;
const help = `dshproxy research search --query TEXT --confirm-credits
  research boards --confirm-credits
  research key set       Read a key from piped stdin only (never an argument)
  research key remove    Remove the locally saved key; environment is unchanged
Returns JSON {items:[{label:string,id:string}]}, first 10 results only.
Search costs 1 credit per returned ad (up to 10); boards costs 1 credit per
successful nonempty call. Empty/error responses are free per provider docs.
--confirm-credits authorizes a credit-consuming request, not a price guarantee.
One request, no retries or pagination; 15 second timeout, 2 MiB response limit.
FOREPLAY_API_KEY overrides the encrypted local foreplay-key.json in the data
folder. Uses the existing OS-protected master.key; no account validation on set.
The search query is sent to Foreplay. No media or returned URLs are fetched.`;

function validKey(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(value)) throw new Error('Invalid Foreplay API key; use 1–512 printable ASCII characters without whitespace.');
  return value;
}
function savedFile(context) { return path.join(context.home === undefined ? homeDir() : context.home, 'foreplay-key.json'); }
function loadSaved(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 4096) throw new Error('Invalid store');
    const buffer = Buffer.alloc(4097);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 4096) throw new Error('Invalid store');
    const data = JSON.parse(buffer.subarray(0,size).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k=>k!=='keyEnc') || (data.keyEnc !== undefined && (typeof data.keyEnc !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.keyEnc)))) throw new Error('Invalid store');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('The saved Foreplay key cannot be read.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
async function master(context, create) {
  return (context.loadMasterKey || secrets.loadMasterKey)(path.join(path.dirname(savedFile(context)), 'master.key'), {create});
}
async function resolveKey(context) {
  const env = context.env || process.env;
  if (env.FOREPLAY_API_KEY !== undefined && env.FOREPLAY_API_KEY !== '') return validKey(env.FOREPLAY_API_KEY);
  try {
    const {keyEnc} = loadSaved(savedFile(context));
    if (keyEnc) return validKey(secrets.decryptWithKey(await master(context,false),keyEnc));
  } catch { throw new Error('The saved Foreplay key cannot be unlocked. Set FOREPLAY_API_KEY to use an environment key instead.'); }
  throw new Error('Set FOREPLAY_API_KEY or use research key set. No request sent.');
}
async function stdinKey(input) {
  if (input.isTTY) throw new Error('Pipe the Foreplay key to stdin; interactive input and arguments are not accepted.');
  return new Promise((resolve,reject)=>{
    let text=''; let bytes=0;
    const finish=(error)=>{
      clearTimeout(timer); input.removeListener('data',data); input.removeListener('end',end); input.removeListener('error',fail); input.pause();
      if(error) reject(error); else { try { resolve(validKey(text.trim())); } catch(e) { reject(e); } }
    };
    const data=chunk=>{ bytes+=Buffer.byteLength(chunk); if(bytes>1024) return finish(new Error('Foreplay key stdin exceeds 1024 bytes.')); text+=chunk.toString(); };
    const end=()=>finish();
    const fail=()=>finish(new Error('Could not read Foreplay key from stdin.'));
    const timer=setTimeout(()=>finish(new Error('Foreplay key stdin timed out.')),TIMEOUT);
    input.on('data',data); input.once('end',end); input.once('error',fail);
  });
}
async function keyCommand(args, out, context) {
  if (args.length!==2 || !['set','remove'].includes(args[1])) throw new Error('Use research key set (stdin only) or research key remove.');
  const value=args[1]==='set' ? await stdinKey(context.stdin || process.stdin) : null;
  try {
    const file=savedFile(context);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    await withLock(file,async()=>{
      loadSaved(file); // Never overwrite a corrupt store unseen.
      const data=value===null ? {} : {keyEnc:secrets.encryptWithKey(await master(context,true),value)};
      await replaceFile(file,JSON.stringify(data)+'\n');
      if (loadSaved(file).keyEnc!==data.keyEnc) throw new Error('Readback failed');
    });
  } catch { throw new Error('Could not update the local Foreplay key. No account request sent.'); }
  out(JSON.stringify({saved:value!==null}));
}
function options(args, search) {
  let confirmed=false, query;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--confirm-credits' && !confirmed) confirmed=true;
    else if(search && args[i]==='--query' && query===undefined) {
      query=args[++i];
      if(typeof query!=='string' || !query.trim() || query.length>1024 || query.startsWith('--') || /[\x00-\x1f\x7f]/.test(query)) throw new Error('Search requires --query TEXT (1–1024 characters, no control characters).');
    } else throw new Error('Unknown or repeated research option; use research help.');
  }
  if(search && query===undefined) throw new Error('Search requires --query TEXT.');
  if(!confirmed) throw new Error('Research requests consume credits; add --confirm-credits. No request sent.');
  return query;
}
async function request(url,key,context) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),TIMEOUT);
  let response;
  try {
    response=await (context.fetch || globalThis.fetch)(url,{method:'GET',headers:{Authorization:key,Accept:'application/json'},redirect:'error',signal:controller.signal});
    if(response.status!==200 || response.redirected) throw new Error('Rejected response');
    if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length'))>MAX_BODY) throw new Error('Invalid response');
    const chunks=[]; let size=0;
    for await(const chunk of response.body) {
      size+=chunk.byteLength;
      if(size>MAX_BODY) throw new Error('Response too large');
      chunks.push(chunk);
    }
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!data || data.metadata?.success!==true || data.error || !Array.isArray(data.data)) throw new Error('Invalid response');
    return {items:data.data.slice(0,LIMIT).map(row=>{
      if(!row || typeof row.id!=='string' || !row.id || row.id.length>512 || /[\x00-\x1f\x7f]/.test(row.id) || typeof row.name!=='string') throw new Error('Invalid item');
      // Labels are plain bounded text, not provider objects or executable links.
      return {label:row.name.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300),id:row.id};
    })};
  } catch {
    throw new Error('Foreplay request failed or returned an invalid response. No retry was made; credits may have been consumed.');
  } finally {
    controller.abort(); clearTimeout(timer);
    if(response?.body && !response.body.locked) await response.body.cancel().catch(()=>{});
  }
}
async function run(args,out,context={}) {
  if(!args.length || (args.length===1 && ['help','--help','-h'].includes(args[0]))) return out(help);
  if(args[0]==='key') return keyCommand(args,out,context);
  if(!['search','boards'].includes(args[0])) throw new Error('Unknown research command; use research help.');
  const search=args[0]==='search';
  const query=options(args.slice(1),search);
  const url=new URL(search ? '/api/discovery/ads' : '/api/boards','https://public.api.foreplay.co');
  url.searchParams.set('limit',String(LIMIT));
  if(search) url.searchParams.set('query',query);
  else { url.searchParams.set('folders','false'); url.searchParams.set('offset','0'); }
  const key=await resolveKey(context);
  out(JSON.stringify(await request(url,key,context)));
}
module.exports={run,help};
