'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/video/catalog');
const {run} = require('../src/video/command');
const transport = require('../src/video/transport');
test('ElevenLabs transport authenticates correctly, validates duration, and polls without resubmission', async () => {
  const args = {route:'elevenlabs', modelId:'veo-3.1-generate-001', key:'synthetic-key', resolution:'720p'};
  let calls=0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(init.headers['xi-api-key'], args.key);
    assert.equal(init.headers.Authorization, undefined);
    if (init.method === 'POST') {
      assert.equal(url, 'https://api.elevenlabs.io/v1/flows/video');
      assert.deepEqual(JSON.parse(init.body), {model_id:args.modelId,prompt:'test',resolution:'720p',duration_secs:6,aspect_ratio:'16:9',generate_audio:true});
      return Response.json({id:'job1',status:'pending'});
    }
    assert.equal(url, 'https://api.elevenlabs.io/v1/flows/video/job1');
    return Response.json({id:'job1',status:'completed',content_url:'https://example.com/video.mp4'});
  };
  await assert.rejects(transport.submit({...args,prompt:'test',durationSeconds:5,fetchImpl}), /duration/);
  assert.equal(calls,0);
  assert.deepEqual(await transport.submit({...args,prompt:'test',durationSeconds:6,fetchImpl}), {id:'job1',status:'pending'});
  assert.deepEqual(await transport.status({...args,jobId:'job1',fetchImpl}), {id:'job1',status:'completed',outputUrl:'https://example.com/video.mp4'});
  assert.equal(calls,2);
});
test('Aurora is image plus audio only, and sends neither prompt nor invented duration', async () => {
  const args={route:'elevenlabs',modelId:'creatify-aurora',key:'synthetic-key'};
  let calls=0;
  const fetchImpl=async (_, init)=>{calls++; assert.deepEqual(JSON.parse(init.body), {model_id:'creatify-aurora',resolution:'720p',image:{type:'asset',asset_id:'image1'},audio:{type:'asset',asset_id:'audio1'}}); return Response.json({id:'job2',status:'pending'});};
  await assert.rejects(transport.submit({...args,prompt:'test',fetchImpl}), /image and audio/);
  await assert.rejects(transport.submit({...args,image:{type:'asset',asset_id:'image1'},fetchImpl}), /image and audio/);
  assert.equal(calls,0);
  await transport.submit({...args,image:{type:'asset',asset_id:'image1'},audio:{type:'asset',asset_id:'audio1'},fetchImpl});
  assert.equal(calls,1);
});
test('ElevenLabs exposes exactly seven approved models without fabricated prices', () => {
  const rows = catalog.entries().filter(e => e.route === 'elevenlabs');
  assert.equal(new Set(rows.map(e => e.model)).size, 7);
  for (const row of rows) {
    assert.equal(row.priceBasis, 'unavailable');
    assert.equal(row.usdMicros, undefined);
  }
  assert.deepEqual(rows.find(e => e.model === 'veo-3.1').supportedDurations, [4,6,8]);
  assert.equal(rows.find(e => e.model === 'aurora').inputMode, 'image-audio');
});
test('ElevenLabs CLI quotes unknown pricing and refuses paid submission', async () => {
  let output;
  await run(['quote','veo-3.1','elevenlabs','--duration','6'], x => output=JSON.parse(x));
  assert.equal(output.durationSeconds, 6);
  assert.equal(output.priceBasis, 'unavailable');
  assert.equal(output.estimatedUsd, undefined);
  await assert.rejects(run(['submit','veo-3.1','elevenlabs','--max-usd','100','--confirm-charge','test'],()=>{}, {fetchImpl:()=>assert.fail('no network')}), /pricing.*unavailable/i);
});
