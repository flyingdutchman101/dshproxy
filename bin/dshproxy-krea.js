#!/usr/bin/env node
'use strict';
// On macOS what this helper creates is private to this account (spec 0014).
if(process.platform==='darwin')process.umask(0o077);
// Dedicated process: DSHProxy does not import this module or gain access to tokens.
const {access,login,status,windowsStore}=require('../src/krea-helper/oauth');
const codes=new Set(['KREA_LOGIN_REQUIRED','KREA_UNCERTAIN','KREA_REFUSED']);
function refuse(){throw Error('KREA_REFUSED');}
async function readRequest(stream) {
  const chunks=[];let size=0;for await(const chunk of stream){size+=Buffer.byteLength(chunk);if(size>65536)refuse();chunks.push(Buffer.from(chunk));}
  const text=Buffer.concat(chunks).toString('utf8').trimEnd();if(text.includes('\n')||text.includes('\r'))refuse();
  const request=JSON.parse(text);if(!request || !['quote','submit','status','balance'].includes(request.action))refuse();return request;
}
async function main({args=process.argv.slice(2),input=process.stdin,output=s=>process.stdout.write(s+'\n'),makeStore=windowsStore,run=(r,t)=>require('../src/krea-helper/mcp').run(r,t)}={}) {
  if(args[0]==='login' && (args.length===1 || (args.length===3 && args[1]==='--client-id'))) {
    await login({clientId:args[2],store:makeStore(),showUrl:output});return;
  }
  if(args.length===1 && args[0]==='logout'){await makeStore().clear();return;}
  // One line, {"signedIn":true,"expiresAt":<ms>} or {"signedIn":false}, and success either way.
  if(args.length===1 && args[0]==='status'){let state={signedIn:false};try{state=await status(makeStore());}catch{}output(JSON.stringify(state));return;}
  if(args.length)refuse();const request=await readRequest(input);const token=await access(makeStore());
  let result;try{result=await run(request,token);}catch(e){const c=e?.code||e?.message;if(codes.has(c))throw Error(c);throw Error(request.action==='submit'?'KREA_UNCERTAIN':'KREA_REFUSED');}
  const unsafe=()=>{throw Error(request.action==='submit'?'KREA_UNCERTAIN':'KREA_REFUSED')};
  try {
    const json=JSON.stringify(result,(k,v)=>{if(k.includes(token) || /(?:token|authorization|secret|credential)/i.test(k) || typeof v==='string'&&v.includes(token))unsafe();return v;});
    if(!json || json[0]!=='{' || Buffer.byteLength(json)>65536)unsafe();output(json);
  } catch {unsafe();}
}
if(require.main===module)main().catch(e=>{process.stderr.write((codes.has(e?.message)?e.message:'KREA_REFUSED')+'\n');process.exitCode=1;});
module.exports={main};
