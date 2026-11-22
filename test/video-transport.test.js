'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {submit, status} = require('../src/video/transport');
const key = 'test-only-credential';
const prompt = 'paper boat';
const wan = 'alibaba/wan-3.0/botsmart';
const options = {route: 'videorouter', modelId: wan, prompt, key};
function recording(json) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({url, ...init}); return Response.json(json); };
  return {calls, fetchImpl};
}
test('VideoRouter submits one five-second benchmark to exactly one pinned host', async () => {
  const {calls, fetchImpl} = recording({id: 'video_123', status: 'queued', ignored: key});
  assert.deepEqual(await submit({...options, fetchImpl}), {id:'video_123', status:'queued'});
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'https://videorouter.sh/api/v1/videos');
  assert.equal(call.method, 'POST');
  assert.equal(call.redirect, 'error');
  assert.equal(new Headers(call.headers).get('authorization'), `Bearer ${key}`);
  assert.ok(call.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(call.body), {model:wan, prompt, resolution:'720p', duration_secs:5, aspect_ratio:'16:9', provider:{only:['botsmart'], allow_fallbacks:false}});
});
const fixtures = [
  {route:'videorouter-replicate', modelId:'alibaba/wan-3.0/replicate', base:'https://videorouter.sh/api/v1/videos', get:'https://videorouter.sh/api/v1/videos/vid_123', body:{resolution:'720p', duration_secs:5, aspect_ratio:'16:9', provider:{only:['replicate'], allow_fallbacks:false}}},
  {route:'kovapi', modelId:'minimax-h3', base:'https://kovapi.com/v1/videos/generations', get:'https://kovapi.com/v1/videos/jobs/vid_123', body:{duration:5, resolution:'768P', size:'16:9'}},
  {route:'kovapi', modelId:'wan3.0-video', base:'https://kovapi.com/v1/videos/generations', get:'https://kovapi.com/v1/videos/jobs/vid_123', body:{duration:5, resolution:'720P', size:'16:9'}},
  {route:'callirra', modelId:'minimax-h3', base:'https://api.callirra.com/v1/videos', get:'https://api.callirra.com/v1/videos/vid_123', body:{mode:'text_to_video', duration_seconds:5, resolution:'768P', aspect_ratio:'16:9'}}
];
for (const {route, modelId, base, get, body} of fixtures) {
  test(`${route}/${modelId} submits and polls documented paths without resubmission`, async () => {
    const job = {id:'vid_123', status:'queued'};
    const wrap = j => route === 'callirra' ? {object:'video.job', job:j} : j;
    const post = recording(wrap(job));
    assert.deepEqual(await submit({route, modelId, prompt, key, fetchImpl:post.fetchImpl}), job);
    assert.equal(post.calls.length, 1);
    assert.equal(post.calls[0].url, base);
    assert.deepEqual(JSON.parse(post.calls[0].body), {model:modelId, prompt,...body});
    const outputUrl = 'https://cdn.example/clip.mp4?signature=synthetic';
    const state = route === 'kovapi' ? 'succeeded' : 'completed';
    const poll = recording(wrap({...job, status:state, ...(route === 'callirra' ? {content_url:outputUrl} : {data:[{url:outputUrl}]}), error:key}));
    assert.deepEqual(await status({route,modelId,jobId:job.id,key,fetchImpl:poll.fetchImpl}), {id:job.id,status:state,outputUrl});
    assert.equal(poll.calls.length, 1);
    assert.equal(poll.calls[0].url, get);
    assert.equal(poll.calls[0].method, 'GET');
    assert.equal(poll.calls[0].body, undefined);
    assert.equal(poll.calls[0].redirect, 'error');
  });
}

test('status distinguishes actual VideoRouter charges from Callirra reservations and missing amounts', async () => {
  const jobId = 'vid_123';
  const check = (job) => status({...options,jobId,fetchImpl:recording(job).fetchImpl});
  assert.equal((await check({id:jobId,status:'completed',cost_usd:0.42})).chargedUsd,0.42);
  assert.equal((await check({id:jobId,status:'failed',cost_usd:0})).chargedUsd,0);
  assert.equal((await check({id:jobId,status:'completed'})).chargedUsd,undefined);
  const c = await status({jobId,key,route:'callirra',modelId:'minimax-h3',fetchImpl:recording({object:'video.job',job:{id:jobId,status:'queued',credits_reserved:'1000'}}).fetchImpl});
  assert.equal(c.reservedCredits,10); assert.equal(c.chargedUsd,undefined);
});
test('invalid route, model, prompt, credential or job path is rejected before network', async () => {
  let calls = 0;
  const fetchImpl = async () => {calls++; throw Error('unexpected I/O');};
  for (const fields of [{route:'https://example.org'}, {route:'__proto__'}, {modelId:'alibaba/wan-3.0'}, {route:'videorouter-replicate'}, {key:'bad\nkey'}, {key:''}, {prompt:' '}]) {
    await assert.rejects(submit({...options, ...fields, fetchImpl}));
  }
  for (const jobId of [null, 42, '..','../secret','%2fadmin','a?x','a#b','a\n','x'.repeat(300)]) {
    await assert.rejects(status({...options, jobId, fetchImpl}));
  }
  assert.equal(calls, 0);
});
test('failed or ambiguous submissions are never retried, raw response/errors are never exposed', async () => {
  for (const fail of [() => {throw Error(key);}, () => new Response(key, {status:307}), () => new Response(key, {status:500}), () => new Response('{not json'), () => Response.json({id:key,status:'queued'}), () => Response.json({id:'../x', status:'queued'}), () => Response.json({id:'ok', status:key})]) {
    let calls = 0;
    await assert.rejects(submit({...options, fetchImpl:async () => {calls++;return fail();}}), err => !err.message.includes(key) && /do not retry/i.test(err.message) && !err.cause);
    assert.equal(calls, 1);
  }
});
test('polling rejects mismatched jobs and does not expose unsafe or nonterminal output', async () => {
  const jobId = 'video_123';
  await assert.rejects(status({...options,jobId,fetchImpl:recording({id:'other',status:'completed'}).fetchImpl}));
  for (const [state,url] of [['queued','https://example.org/not-ready'], ['completed','http://example.org/'], ['completed','https://u:p@example.org/v'], ['completed','javascript:alert(1)'], ['completed',`https://example.org/?k=${key}`]]) {
    const job = {id:jobId,status:state,data:[{url}]};
    assert.deepEqual(await status({...options,jobId,fetchImpl:recording(job).fetchImpl}), {id:jobId,status:state});
  }
});
