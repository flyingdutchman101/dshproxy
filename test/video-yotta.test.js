'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/video/catalog');
const transport = require('../src/video/transport');
const base = {route:'yotta', modelId:'kling-v3-std-text', prompt:'A cloud', key:'fixture-secret'};
test('Yotta standard preset quotes five silent seconds without claiming pixels', () => {
 const q = catalog.quote('kling-v3-standard', 'yotta');
 assert.equal(q.usdMicros,357000); assert.equal(q.resolution,'standard');
 assert.throws(() => catalog.quote('kling-v3-standard','yotta','720p'));
});
test('Yotta documented submit and separate status contracts', async () => {
 const calls=[];
 const fetchImpl=async (url,init)=>{calls.push({url,init});return {ok:true,json:async()=> calls.length===1?{code:10000,data:{request_id:'job-1'}}:{code:10000,data:{status:'completed',output_url:'https://example.org/video.mp4'}}};};
 assert.deepEqual(await transport.submit({...base,fetchImpl}),{id:'job-1',status:'queued'});
 assert.deepEqual(JSON.parse(calls[0].init.body),{model:'kling-v3-std-text',parameters:{prompt:'A cloud',duration:5,aspect_ratio:'16:9',multi_shot:false,generate_audio:false}});
 assert.equal(calls[0].init.headers['X-API-KEY'],base.key);
 assert.deepEqual(await transport.status({...base,jobId:'job-1',fetchImpl}),{id:'job-1',status:'completed',outputUrl:'https://example.org/video.mp4'});
 assert.equal(calls[1].init.method,'GET');
 assert.equal(calls[1].url,'https://gateway.yottalabs.ai/api/maas/text-to-video/generations/job-1');
});
test('Yotta rejects unsupported inputs before network and sanitizes provider errors', async () => {
 let calls=0;
 const fetchImpl=async()=>{calls++;return {ok:true,json:async()=>({code:40000,message:base.key})};};
 for (const extra of [{image:'https://example.org/a.png'},{audio:'x'},{durationSeconds:10},{resolution:'720p'}]) {
  await assert.rejects(transport.submit({...base,...extra,fetchImpl}));
 }
 assert.equal(calls,0);
 await assert.rejects(transport.submit({...base,fetchImpl}),error=> !error.message.includes(base.key) && /do not retry/.test(error.message));
 assert.equal(calls,1);
});
test('Yotta CLI quote is offline and an insufficient cap cannot buy', async () => {
 const {run}=require('../src/video/command'); const out=[]; let calls=0;
 const options={env:{YOTTA_API_KEY:base.key},fetchImpl:async()=>{calls++;throw Error('unexpected');}};
 await run(['quote','kling-v3-standard','yotta'],value=>out.push(JSON.parse(value)),options);
 assert.equal(out[0].usdMicros,357000);
 await assert.rejects(run(['submit','kling-v3-standard','yotta','--max-usd','0.356','--confirm-charge','A cloud'],()=>{},options),/exceeds/);
 assert.equal(calls,0);
});
test('Yotta ambiguous submission never retries',async()=>{
 let calls=0; await assert.rejects(transport.submit({...base,fetchImpl:async()=>{calls++;throw Error('disconnect');}}),/do not retry/); assert.equal(calls,1);
});
