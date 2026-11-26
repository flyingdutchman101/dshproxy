'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/research/command');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const key = 'synthetic-foreplay-test-key';
const response = data => new Response(JSON.stringify({metadata:{success:true},data}),{headers:{'content-type':'application/json'}});

test('search sends one documented bounded request and emits only machine items', async () => {
  const output=[]; let calls=0;
  await run(['search','--query','coffee & tea','--confirm-credits'], x=>output.push(JSON.parse(x)), {
    env:{FOREPLAY_API_KEY:key}, fetch:async (url,options)=>{
      calls++;
      assert.equal(url.origin,'https://public.api.foreplay.co');
      assert.equal(url.pathname,'/api/discovery/ads');
      assert.equal(url.searchParams.get('query'),'coffee & tea');
      assert.equal(url.searchParams.get('limit'),'10');
      assert.equal(options.headers.Authorization,key);
      assert.equal(options.redirect,'error');
      assert.ok(options.signal instanceof AbortSignal);
      return response([{id:'ad1',name:'Coffee',video:'https://untrusted.invalid'}]);
    }
  });
  assert.equal(calls,1);
  assert.deepEqual(output,[{items:[{label:'Coffee',id:'ad1'}]}]);
});

test('boards requests flat first page and bounds output, ignoring all links and pagination', async()=>{
  let calls=0, output;
  await run(['boards','--confirm-credits'],x=>output=JSON.parse(x),{env:{FOREPLAY_API_KEY:key},fetch:async url=>{
    calls++;
    assert.equal(url.pathname,'/api/boards');
    assert.deepEqual(Object.fromEntries(url.searchParams),{limit:'10',folders:'false',offset:'0'});
    return response(Array.from({length:20},(_,i)=>({id:String(i),name:'A\n'+ 'x'.repeat(400),url:'https://evil.invalid'})));
  }});
  assert.equal(calls,1); assert.equal(output.items.length,10);
  assert.deepEqual(Object.keys(output),['items']);
  assert.equal(output.items[0].label.length,300);
  assert.ok(!output.items[0].label.includes('\n'));
});

test('invalid options and missing confirmation refuse before any I/O',async()=>{
  for(const args of [ ['search','--query','coffee'], ['boards'], ['boards','--confirm-credits','--confirm-credits'], ['boards','--query','x','--confirm-credits'], ['search','--query','','--confirm-credits'], ['search','--query','x'.repeat(1025),'--confirm-credits'], ['search','--query','x\ny','--confirm-credits'], ['boards','--confirm-credits','--base-url','https://evil.invalid'], ['key','set',key]]) {
    let calls=0;
    await assert.rejects(run(args,()=>assert.fail('unexpected output'),{env:{FOREPLAY_API_KEY:key},fetch:async()=>{calls++;},loadMasterKey:async()=>assert.fail('unexpected key access')}));
    assert.equal(calls,0);
  }
});

test('errors never echo response bodies, queries, credentials or transport details; never retry',async()=>{
  const cases=[()=>new Response(key,{status:302,headers:{location:'https://evil.invalid'}}),()=>new Response(key,{status:401}),()=>new Response(key,{status:402}),()=>new Response(key,{status:429}),()=>new Response(key,{status:500}),()=>new Response(key,{headers:{'content-type':'application/json'}}),()=>response([{id:1,name:'bad'}]),()=>response([{id:'ok',name:{secret:key}}]),()=>new Response(JSON.stringify({metadata:{success:false},data:[]})),()=>{throw new Error(key);}];
  for(const make of cases) {
    let calls=0;
    await assert.rejects(run(['boards','--confirm-credits'],()=>assert.fail('unexpected output'),{env:{FOREPLAY_API_KEY:key},fetch:async()=>{calls++; return make();}}),e=>!e.message.includes(key) && /No retry/.test(e.message));
    assert.equal(calls,1);
  }
});

test('oversized bodies refused both by header and streamed byte count',async()=>{
  for(const headers of [{'content-type':'application/json','content-length':String(3*1024*1024)},{'content-type':'application/json'}]) {
    await assert.rejects(run(['boards','--confirm-credits'],()=>assert.fail('unexpected output'),{env:{FOREPLAY_API_KEY:key},fetch:async()=>new Response(' '.repeat(2*1024*1024+1),{headers})}),/Foreplay request failed/);
  }
});

test('network timeout aborts the single request',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let started;
  const ready=new Promise(resolve=>started=resolve);
  const pending=run(['boards','--confirm-credits'],()=>{}, {env:{FOREPLAY_API_KEY:key},fetch:async(url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error(key)),{once:true}); started();
  })});
  const rejected=assert.rejects(pending,/No retry/);
  await ready; t.mock.timers.tick(15000); await rejected;
});

test('encrypted local key lifecycle, environment priority, no network or shared catalog writes',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'foreplay-test-'));
  t.after(()=>{assert.ok(home.startsWith(path.join(os.tmpdir(),'foreplay-test-')));fs.rmSync(home,{recursive:true,force:true});});
  const master=Buffer.alloc(32,42);
  const context={home,env:{},loadMasterKey:async()=>master,fetch:async()=>assert.fail('unexpected network')};
  const outputs=[];
  await run(['key','set'],x=>outputs.push(JSON.parse(x)),{...context,stdin:Readable.from([key+'\n'])});
  assert.deepEqual(outputs,[{saved:true}]);
  const stored=fs.readFileSync(path.join(home,'foreplay-key.json'),'utf8');
  assert.ok(!stored.includes(key));
  assert.deepEqual(fs.readdirSync(home),['foreplay-key.json']);
  await run(['boards','--confirm-credits'],()=>{}, {...context,fetch:async(url,opts)=>{assert.equal(opts.headers.Authorization,key);return response([]);}});
  await run(['boards','--confirm-credits'],()=>{}, {...context,env:{FOREPLAY_API_KEY:'env-key'},loadMasterKey:async()=>assert.fail('environment must win'),fetch:async(url,opts)=>{assert.equal(opts.headers.Authorization,'env-key');return response([]);}});
  await run(['key','remove'],x=>assert.deepEqual(JSON.parse(x),{saved:false}),context);
  await assert.rejects(run(['boards','--confirm-credits'],()=>{},context),/Set FOREPLAY_API_KEY/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home,'foreplay-key.json'),'utf8')),{});
});

test('corrupt store is not overwritten; wrong master key fails closed',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'foreplay-test-'));
  t.after(()=>{assert.ok(home.startsWith(path.join(os.tmpdir(),'foreplay-test-')));fs.rmSync(home,{recursive:true,force:true});});
  const file=path.join(home,'foreplay-key.json');
  const context={home,env:{},loadMasterKey:async()=>Buffer.alloc(32,1),fetch:async()=>assert.fail('network')};
  fs.writeFileSync(file,'broken-secret-store');
  await assert.rejects(run(['key','set'],()=>{}, {...context,stdin:Readable.from([key])}),/Could not update/);
  await assert.rejects(run(['key','remove'],()=>{},context),/Could not update/);
  assert.equal(fs.readFileSync(file,'utf8'),'broken-secret-store');
  fs.writeFileSync(file,'{}');
  await run(['key','set'],()=>{}, {...context,stdin:Readable.from([key])});
  await assert.rejects(run(['boards','--confirm-credits'],()=>{}, {...context,loadMasterKey:async()=>Buffer.alloc(32,2)}),/cannot be unlocked/);
});

test('help is offline and documents credit and credential contracts',async()=>{
  let output;
  await run(['help'],x=>output=x,{fetch:async()=>assert.fail('network'),loadMasterKey:async()=>assert.fail('master access')});
  assert.match(output,/1 credit per returned ad/);
  assert.match(output,/FOREPLAY_API_KEY/);
  assert.match(output,/stdin/);
});

test('response body timeout remains active after headers arrive',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let ready;
  const started=new Promise(resolve=>ready=resolve);
  const pending=assert.rejects(run(['boards','--confirm-credits'],()=>{}, {env:{FOREPLAY_API_KEY:key},fetch:async(url,{signal})=>{
    const body=new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(new Error('aborted')),{once:true});}});
    ready();
    return new Response(body,{headers:{'content-type':'application/json'}});
  }}),/No retry/);
  await started; await Promise.resolve(); t.mock.timers.tick(15000); await pending;
});

test('stdin is bounded, noninteractive and timed out; malformed env keys refused offline',async t=>{
  for(const input of [Readable.from(['x'.repeat(1025)]),Readable.from(['a b']),Object.assign(Readable.from([key]),{isTTY:true})]) {
    await assert.rejects(run(['key','set'],()=>assert.fail('output'),{stdin:input,loadMasterKey:async()=>assert.fail('master access')}));
  }
  for(const value of ['a\nb','a b','x'.repeat(513),'💡']) await assert.rejects(run(['boards','--confirm-credits'],()=>{}, {env:{FOREPLAY_API_KEY:value},fetch:async()=>assert.fail('network')}),/Invalid Foreplay API key/);
  t.mock.timers.enable({apis:['setTimeout']});
  const input=new PassThrough();
  const pending=assert.rejects(run(['key','set'],()=>{}, {stdin:input}),/timed out/);
  t.mock.timers.tick(15000);await pending; input.destroy();
});
