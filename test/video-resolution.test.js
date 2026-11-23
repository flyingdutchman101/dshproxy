'use strict';
require("./support/keychain"); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
// `--resolution R` on video quote, submit and status, for every route. Nothing
// here reaches a provider: the API routes get an injected fetch that records
// what would be sent, and the Krea route gets a stand-in for the helper.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The default data folder of this process is a throwaway one that must stay empty.
const guard = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-resolution-guard-'));
process.env.DSHPROXY_HOME = guard;
after(() => {
  try { assert.deepEqual(fs.readdirSync(guard), []); } finally { fs.rmSync(guard, { recursive: true, force: true }); }
});

const { submit, status } = require('../src/video/transport');
const { run: command } = require('../src/video/command');
const KEY = 'test-only-credential';
const PROMPT = 'paper boat';
const ENV = { DSHPROXY_HOME: guard, VIDEOROUTER_API_KEY: KEY, KOVAPI_API_KEY: KEY, CALLIRRA_API_KEY: KEY };

function recording(reply = { id: 'vid_123', status: 'queued' }) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body), redirect: init.redirect }); return Response.json(reply); };
  return { calls, fetchImpl };
}
// A provider and a workspace helper that must never be reached.
function untouched() {
  const seen = [];
  return { seen, fetchImpl: async (...args) => { seen.push(['fetch', ...args]); throw new Error('unexpected request'); }, workspace: async (request) => { seen.push(['workspace', request]); throw new Error('unexpected helper call'); } };
}
async function printed(args, deps) {
  const lines = [];
  await command(args, (text) => lines.push(text), { env: ENV, ...deps });
  return JSON.parse(lines.join('\n'));
}

// ------------------------------- what each API route sends -------------------------------

// [route, provider model id, resolution, submit URL, the body beside model and prompt]
const SENT = [
  ['videorouter', 'bytedance/seedance-2.5/botsmart', '480p', 'https://videorouter.sh/api/v1/videos',
    { resolution: '480p', duration_secs: 5, aspect_ratio: '16:9', provider: { only: ['botsmart'], allow_fallbacks: false } }],
  ['videorouter', 'bytedance/seedance-2.5/botsmart', '1080p', 'https://videorouter.sh/api/v1/videos',
    { resolution: '1080p', duration_secs: 5, aspect_ratio: '16:9', provider: { only: ['botsmart'], allow_fallbacks: false } }],
  ['videorouter', 'bytedance/seedance-2.0/botsmart', '480p', 'https://videorouter.sh/api/v1/videos',
    { resolution: '480p', duration_secs: 5, aspect_ratio: '16:9', provider: { only: ['botsmart'], allow_fallbacks: false } }],
  ['videorouter', 'bytedance/seedance-2.0/socheap-overseas', '720p', 'https://videorouter.sh/api/v1/videos',
    { resolution: '720p', duration_secs: 5, aspect_ratio: '16:9', provider: { only: ['socheap-overseas'], allow_fallbacks: false } }],
  ['videorouter', 'alibaba/wan-3.0/botsmart', '1080p', 'https://videorouter.sh/api/v1/videos',
    { resolution: '1080p', duration_secs: 5, aspect_ratio: '16:9', provider: { only: ['botsmart'], allow_fallbacks: false } }],
  ['videorouter', 'black-forest-labs/flux-3/black-forest-labs', '720p', 'https://videorouter.sh/api/v1/videos',
    { resolution: '720p', duration_secs: 5, aspect_ratio: '16:9', provider: { only: ['black-forest-labs'], allow_fallbacks: false } }],
  ['videorouter', 'black-forest-labs/flux-3/black-forest-labs', '1080p', 'https://videorouter.sh/api/v1/videos',
    { resolution: '1080p', duration_secs: 5, aspect_ratio: '16:9', provider: { only: ['black-forest-labs'], allow_fallbacks: false } }],
  ['videorouter-replicate', 'alibaba/wan-3.0/replicate', '480p', 'https://videorouter.sh/api/v1/videos',
    { resolution: '480p', duration_secs: 5, aspect_ratio: '16:9', provider: { only: ['replicate'], allow_fallbacks: false } }],
  ['kovapi', 'seedance-2.5', '480p', 'https://kovapi.com/v1/videos/generations', { duration: 5, resolution: '480P', size: '16:9' }],
  ['kovapi', 'seedance-2.0', '1080p', 'https://kovapi.com/v1/videos/generations', { duration: 5, resolution: '1080P', size: '16:9' }],
  ['kovapi', 'wan3.0-video', '1080p', 'https://kovapi.com/v1/videos/generations', { duration: 5, resolution: '1080P', size: '16:9' }],
  ['kovapi', 'minimax-h3', '480p', 'https://kovapi.com/v1/videos/generations', { duration: 5, resolution: '480P', size: '16:9' }],
  ['kovapi', 'minimax-h3', '1080p', 'https://kovapi.com/v1/videos/generations', { duration: 5, resolution: '1080P', size: '16:9' }],
  ['callirra', 'minimax-h3', '480p', 'https://api.callirra.com/v1/videos', { mode: 'text_to_video', duration_seconds: 5, resolution: '480P', aspect_ratio: '16:9' }],
  ['callirra', 'minimax-h3', '1080p', 'https://api.callirra.com/v1/videos', { mode: 'text_to_video', duration_seconds: 5, resolution: '1080P', aspect_ratio: '16:9' }],
];
for (const [route, modelId, resolution, url, body] of SENT) {
  test(`${route} ${modelId} at ${resolution} sends that resolution the way the provider documents it, once`, async () => {
    const wrap = (job) => (route === 'callirra' ? { object: 'video.job', job } : job);
    const post = recording(wrap({ id: 'vid_123', status: 'queued' }));
    assert.deepEqual(await submit({ route, modelId, resolution, prompt: PROMPT, key: KEY, fetchImpl: post.fetchImpl }), { id: 'vid_123', status: 'queued' });
    assert.deepEqual(post.calls, [{ url, method: 'POST', body: { model: modelId, prompt: PROMPT, ...body }, redirect: 'error' }]);
    // A status check asks for the job only, and sends no resolution anywhere.
    const poll = recording(wrap({ id: 'vid_123', status: 'queued' }));
    assert.deepEqual(await status({ route, modelId, resolution, jobId: 'vid_123', key: KEY, fetchImpl: poll.fetchImpl }), { id: 'vid_123', status: 'queued' });
    assert.equal(poll.calls.length, 1);
    assert.deepEqual([poll.calls[0].method, poll.calls[0].body], ['GET', undefined]);
    assert.ok(poll.calls[0].url.endsWith('/vid_123'));
  });
}

test('the transport refuses a route, model id and resolution that are not one entry, before any request', async () => {
  const none = untouched();
  const wan = { route: 'videorouter', modelId: 'alibaba/wan-3.0/botsmart', prompt: PROMPT, key: KEY, fetchImpl: none.fetchImpl };
  for (const fields of [
    // The price of a resolution belongs to one host: no other host is sent that resolution.
    { modelId: 'bytedance/seedance-2.5/socheap-overseas', resolution: '480p' }, { modelId: 'bytedance/seedance-2.5/socheap-overseas', resolution: '1080p' },
    { modelId: 'bytedance/seedance-2.5/botsmart', resolution: '720p' }, { modelId: 'bytedance/seedance-2.5/botsmart' }, { modelId: 'bytedance/seedance-2.0/botsmart' },
    { modelId: 'black-forest-labs/flux-3/black-forest-labs', resolution: '480p' }, { modelId: 'black-forest-labs/flux-3/replicate', resolution: '720p' },
    { resolution: '768p' }, { resolution: '4k' }, { resolution: '720P' }, { resolution: '' }, { resolution: 720 }, { resolution: null }, { resolution: ['720p'] },
    { resolution: 'constructor' }, { resolution: '__proto__' },
    { route: 'videorouter-replicate', resolution: '480p' }, { route: 'kovapi', modelId: 'seedance-2.5', resolution: '768p' }, { route: 'kovapi', modelId: 'minimax-h3', resolution: '720p' },
    { route: 'kovapi', modelId: 'flux-3', resolution: '720p' }, { route: 'callirra', modelId: 'minimax-h3', resolution: '720p' }, { route: 'callirra', modelId: 'minimax-h3', resolution: '960p' },
    { route: 'krea', modelId: 'alibaba/wan-3.0', resolution: '720p' }, { route: 'krea', modelId: 'minimax/hailuo-3', resolution: '2K' },
  ]) {
    await assert.rejects(submit({ ...wan, ...fields }), /Invalid video route or model/, JSON.stringify(fields));
    await assert.rejects(status({ ...wan, ...fields, jobId: 'vid_123' }), /Invalid video route or model/, JSON.stringify(fields));
  }
  assert.deepEqual(none.seen, []);
});

// ------------------------------- the command, API routes -------------------------------

test('video quote takes --resolution on an API route and answers with that resolution\'s dated estimate', async () => {
  const none = untouched();
  const q = await printed(['quote', 'seedance-2.5', 'videorouter', '--resolution', '1080p'], none);
  assert.deepEqual([q.model, q.route, q.resolution, q.modelId, q.usdMicros, q.currency, q.amount, q.estimatedUsd, q.budgetFlag, q.verifiedOn],
    ['seedance-2.5', 'videorouter', '1080p', 'bytedance/seedance-2.5/botsmart', 2272938, 'USD', 2.272938, 2.272938, '--max-usd', '2026-11-22']);
  assert.ok(q.sourceUrls.length >= 1 && q.sourceUrls.every((url) => url.startsWith('https://')));
  const low = await printed(['quote', 'seedance-2.0', 'kovapi', '--resolution', '480p'], none);
  assert.deepEqual([low.resolution, low.usdMicros, low.amount], ['480p', 350000, 0.35]);
  // Without a route the model's own route is used, as for a quote without a resolution.
  const wan = await printed(['quote', 'wan-3.0', '--resolution', '480p'], none);
  assert.deepEqual([wan.route, wan.resolution, wan.usdMicros], ['videorouter', '480p', 113263]);
  const credits = await printed(['quote', 'minimax-h3', 'callirra', '--resolution', '1080p'], none);
  assert.deepEqual([credits.resolution, credits.currency, credits.amount, credits.estimatedUsd, credits.budgetFlag], ['1080p', 'credits', 15, 0.1495, '--max-credits']);
  const flux = await printed(['quote', 'flux-3', '--resolution', '1080p'], none);
  assert.deepEqual([flux.route, flux.modelId, flux.usdMicros], ['videorouter', 'black-forest-labs/flux-3/black-forest-labs', 1486250]);
  assert.deepEqual(none.seen, []);
});

test('without --resolution an API quote is the one given before, whole', async () => {
  const none = untouched();
  const q = await printed(['quote', 'wan-3.0', 'videorouter'], none);
  assert.deepEqual(q, { model: 'wan-3.0', route: 'videorouter', resolution: '720p', durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21', priceBasis: 'published',
    modelId: 'alibaba/wan-3.0/botsmart', usdMicros: 226013, sourceUrls: ['https://videorouter.sh/video/alibaba/wan-3.0/botsmart'], currency: 'USD', amount: 0.226013, budgetFlag: '--max-usd', estimatedUsd: 0.226013 });
  assert.deepEqual(await printed(['quote', 'wan-3.0', 'videorouter', '--resolution', '720p'], none), q);
  const h3 = await printed(['quote', 'minimax-h3', 'callirra'], none);
  assert.deepEqual([h3.resolution, h3.amount, h3.usdMicros, h3.verifiedOn], ['768p', 10, 99667, '2026-11-21']);
  assert.deepEqual(none.seen, []);
});

test('video submit on an API route checks the cap against the price of the named resolution and sends that resolution once', async () => {
  const none = untouched();
  const args = (cap) => ['submit', 'seedance-2.5', 'videorouter', '--max-usd', cap, '--confirm-charge', '--resolution', '1080p', PROMPT];
  // A cap that covers 720p ($0.702125) does not cover 1080p ($2.272938).
  for (const cap of ['0.702125', '2.272937']) await assert.rejects(command(args(cap), () => {}, { env: ENV, ...none }), /exceeds --max-usd; no job submitted/);
  assert.deepEqual(none.seen, []);

  const post = recording();
  const result = await printed(args('2.272938'), { fetchImpl: post.fetchImpl });
  assert.deepEqual(result, { id: 'vid_123', status: 'queued', model: 'seedance-2.5', route: 'videorouter', resolution: '1080p' });
  assert.deepEqual(post.calls, [{ url: 'https://videorouter.sh/api/v1/videos', method: 'POST', redirect: 'error',
    body: { model: 'bytedance/seedance-2.5/botsmart', prompt: PROMPT, resolution: '1080p', duration_secs: 5, aspect_ratio: '16:9', provider: { only: ['botsmart'], allow_fallbacks: false } } }]);

  const kov = recording();
  await printed(['submit', 'minimax-h3', 'kovapi', '--max-usd', '0.075', '--confirm-charge', '--resolution', '480p', PROMPT], { fetchImpl: kov.fetchImpl });
  assert.deepEqual(kov.calls.map((call) => call.body), [{ model: 'minimax-h3', prompt: PROMPT, duration: 5, resolution: '480P', size: '16:9' }]);

  const credits = recording({ object: 'video.job', job: { id: 'vid_123', status: 'queued', credits_reserved: '1500' } });
  await assert.rejects(command(['submit', 'minimax-h3', 'callirra', '--max-credits', '14', '--confirm-charge', '--resolution', '1080p', PROMPT], () => {}, { env: ENV, fetchImpl: credits.fetchImpl }), /Insufficient credit budget; no job submitted/);
  assert.equal(credits.calls.length, 0);
  const reserved = await printed(['submit', 'minimax-h3', 'callirra', '--max-credits', '15', '--confirm-charge', '--resolution', '1080p', PROMPT], { fetchImpl: credits.fetchImpl });
  assert.deepEqual([reserved.reservedCredits, reserved.resolution], [15, '1080p']);
  assert.deepEqual(credits.calls.map((call) => call.body), [{ model: 'minimax-h3', prompt: PROMPT, mode: 'text_to_video', duration_seconds: 5, resolution: '1080P', aspect_ratio: '16:9' }]);
});

test('video submit and status without --resolution send and print what they did before', async () => {
  const post = recording();
  const result = await printed(['submit', 'seedance-2.5', 'videorouter', '--max-usd', '0.702125', '--confirm-charge', PROMPT], { fetchImpl: post.fetchImpl });
  assert.deepEqual(result, { id: 'vid_123', status: 'queued', model: 'seedance-2.5', route: 'videorouter' });
  assert.deepEqual(post.calls.map((call) => call.body), [{ model: 'bytedance/seedance-2.5/socheap-overseas', prompt: PROMPT, resolution: '720p', duration_secs: 5, aspect_ratio: '16:9', provider: { only: ['socheap-overseas'], allow_fallbacks: false } }]);
  const poll = recording();
  assert.deepEqual(await printed(['status', 'seedance-2.5', 'videorouter', 'vid_123'], { fetchImpl: poll.fetchImpl }), { id: 'vid_123', status: 'queued', model: 'seedance-2.5', route: 'videorouter' });
  assert.deepEqual(poll.calls.map((call) => [call.url, call.method]), [['https://videorouter.sh/api/v1/videos/vid_123', 'GET']]);
});

test('video status takes --resolution, checks the job once and never submits', async () => {
  const poll = recording();
  for (const args of [['status', 'seedance-2.5', 'videorouter', 'vid_123', '--resolution', '480p'], ['status', 'seedance-2.5', 'videorouter', '--resolution', '480p', 'vid_123']]) {
    assert.deepEqual(await printed(args, { fetchImpl: poll.fetchImpl }), { id: 'vid_123', status: 'queued', model: 'seedance-2.5', route: 'videorouter', resolution: '480p' });
  }
  assert.deepEqual(poll.calls, [1, 2].map(() => ({ url: 'https://videorouter.sh/api/v1/videos/vid_123', method: 'GET', body: undefined, redirect: 'error' })));
});

// ------------------------------- the command, Krea route -------------------------------

const QUOTE = { mode: 'preflight', compute_units: 1074.0740740740741, is_estimated: false, available_compute_units: 5000.75, affordable: true };
function helper() {
  const requests = [];
  return { requests, workspace: async (request) => { requests.push(request); return request.action === 'quote' ? QUOTE : { id: 'job-1', status: request.action === 'status' ? 'processing' : 'scheduled' }; } };
}

test('the Krea route passes the named resolution to the helper request, wherever the option stands', async () => {
  const h = helper();
  const deps = { workspace: h.workspace, fetchImpl: untouched().fetchImpl };
  const quoted = await printed(['quote', 'flux-3', 'krea', '--prompt', PROMPT, '--resolution', '1080p'], deps);
  // Fractional units are passed on as they came.
  assert.deepEqual(quoted, { model: 'flux-3', route: 'krea', ...QUOTE, currency: 'workspace_compute_units', budgetFlag: '--max-units', resolution: '1080p' });
  await printed(['quote', 'flux-3', 'krea', '--resolution', '720p', '--prompt', PROMPT], deps);
  const job = await printed(['submit', 'seedance-2.5', 'krea', '--max-units', '380.333334', '--confirm-charge', '--resolution', '480p', PROMPT], deps);
  assert.deepEqual(job, { model: 'seedance-2.5', route: 'krea', id: 'job-1', status: 'scheduled', resolution: '480p' });
  await printed(['submit', 'seedance-2.5', 'krea', '--resolution', '1080p', '--max-units', '2106', '--confirm-charge', PROMPT], deps);
  assert.deepEqual(h.requests, [
    { action: 'quote', model: 'flux-3', prompt: PROMPT, resolution: '1080p' },
    { action: 'quote', model: 'flux-3', prompt: PROMPT, resolution: '720p' },
    { action: 'submit', model: 'seedance-2.5', prompt: PROMPT, maxUnits: 380.333334, confirmCharge: true, resolution: '480p' },
    { action: 'submit', model: 'seedance-2.5', prompt: PROMPT, maxUnits: 2106, confirmCharge: true, resolution: '1080p' },
  ]);
});

test('without --resolution the Krea helper request and the printed answer are the ones from before, for Flux 3 too', async () => {
  const h = helper();
  const deps = { workspace: h.workspace };
  assert.deepEqual(await printed(['quote', 'flux-3', 'krea', '--prompt', PROMPT], deps), { model: 'flux-3', route: 'krea', ...QUOTE, currency: 'workspace_compute_units', budgetFlag: '--max-units' });
  assert.deepEqual(await printed(['submit', 'wan-3.0', 'krea', '--max-units', '556', '--confirm-charge', PROMPT], deps), { model: 'wan-3.0', route: 'krea', id: 'job-1', status: 'scheduled' });
  assert.deepEqual(await printed(['status', 'wan-3.0', 'krea', 'job-1'], deps), { model: 'wan-3.0', route: 'krea', id: 'job-1', status: 'processing' });
  assert.deepEqual(h.requests, [{ action: 'quote', model: 'flux-3', prompt: PROMPT }, { action: 'submit', model: 'wan-3.0', prompt: PROMPT, maxUnits: 556, confirmCharge: true }, { action: 'status', model: 'wan-3.0', jobId: 'job-1' }]);
});

test('a Krea status check takes --resolution as part of the job\'s origin and asks the helper for the job only', async () => {
  const h = helper();
  assert.deepEqual(await printed(['status', 'flux-3', 'krea', 'job-1', '--resolution', '1080p'], { workspace: h.workspace }), { model: 'flux-3', route: 'krea', id: 'job-1', status: 'processing', resolution: '1080p' });
  assert.deepEqual(h.requests, [{ action: 'status', model: 'flux-3', jobId: 'job-1' }]);
});

test('the fixed tier is reached without a resolution or under its own name, and the helper is sent no resolution for it', async () => {
  const h = helper();
  const deps = { workspace: h.workspace };
  await printed(['quote', 'minimax-h3', 'krea', '--prompt', PROMPT], deps);
  const named = await printed(['quote', 'minimax-h3', 'krea', '--prompt', PROMPT, '--resolution', '2K'], deps);
  assert.equal(named.resolution, '2K');
  await printed(['submit', 'minimax-h3', 'krea', '--max-units', '481.481482', '--confirm-charge', '--resolution', '2K', PROMPT], deps);
  assert.deepEqual(h.requests, [{ action: 'quote', model: 'minimax-h3', prompt: PROMPT }, { action: 'quote', model: 'minimax-h3', prompt: PROMPT },
    { action: 'submit', model: 'minimax-h3', prompt: PROMPT, maxUnits: 481.481482, confirmCharge: true }]);
});

// ------------------------------- refused before any request -------------------------------

test('a combination that is not an entry is refused before any request, on every route and for every action', async () => {
  const none = untouched();
  const deps = { env: ENV, fetchImpl: none.fetchImpl, workspace: none.workspace };
  const refuse = async (args, pattern) => {
    let output = '';
    await assert.rejects(command(args, (text) => { output += text; }, deps), pattern, args.join(' '));
    assert.equal(output, '', args.join(' '));
  };
  const api = (model, route, resolution) => [
    ['quote', model, route, '--resolution', resolution],
    ['submit', model, route, '--max-usd', '99', '--confirm-charge', '--resolution', resolution, PROMPT],
    ['status', model, route, 'vid_123', '--resolution', resolution],
  ];
  const krea = (model, resolution) => [
    ['quote', model, 'krea', '--prompt', PROMPT, '--resolution', resolution],
    ['submit', model, 'krea', '--max-units', '9999', '--confirm-charge', '--resolution', resolution, PROMPT],
    ['status', model, 'krea', 'job-1', '--resolution', resolution],
  ];
  // An unknown resolution, and resolutions that exist elsewhere but not for this model on this route.
  for (const [model, route, resolution] of [['wan-3.0', 'videorouter', '999p'], ['seedance-2.5', 'videorouter', '768p'], ['seedance-2.5', 'kovapi', '768p'], ['seedance-2.0', 'kovapi', '4k'],
    ['minimax-h3', 'kovapi', '720p'], ['minimax-h3', 'callirra', '720p'], ['flux-3', 'videorouter', '480p'], ['wan-3.0', 'videorouter-replicate', '4k'], ['wan-3.0', 'videorouter', '720P']]) {
    for (const args of api(model, route, resolution)) await refuse(args, /resolution/i);
  }
  for (const [model, resolution] of [['flux-3', '480p'], ['seedance-2.5', '768p'], ['seedance-2.5', '4k'], ['wan-3.0', '1440p'], ['wan-3.0', '2K']]) {
    for (const args of krea(model, resolution)) await refuse(args, /resolution/i);
  }
  // A fixed tier asked for a resolution.
  for (const resolution of ['480p', '720p', '768p', '1080p', '2k']) for (const args of krea('minimax-h3', resolution)) await refuse(args, /fixed tier/i);
  // An unknown model or route stays refused with a resolution named.
  for (const args of [...api('wan-3.0-prime', 'videorouter', '720p'), ...krea('wan-3.0-prime', '720p')]) await refuse(args, /Unknown video model/);
  for (const args of [...api('wan-3.0', 'callirra', '720p'), ...api('flux-3', 'kovapi', '720p'), ...api('minimax-h3', 'videorouter', '768p'), ...api('wan-3.0', 'nowhere', '720p')]) await refuse(args, /route/i);
  // The option itself: no value, a value that is not a resolution, given twice.
  for (const args of [['quote', 'wan-3.0', 'videorouter', '--resolution'], ['quote', 'wan-3.0', 'videorouter', '--resolution', '--max-usd'], ['quote', 'wan-3.0', 'videorouter', '--resolution', '720p', '--resolution', '720p'],
    ['quote', 'wan-3.0', '--resolution'], ['status', 'wan-3.0', 'videorouter', 'vid_123', '--resolution'], ['quote', 'wan-3.0', 'krea', '--prompt', PROMPT, '--resolution'],
    ['submit', 'wan-3.0', 'krea', '--max-units', '9999', '--confirm-charge', '--resolution', '720p', '--resolution', '480p', PROMPT],
    ['submit', 'wan-3.0', 'videorouter', '--max-usd', '99', '--confirm-charge', PROMPT, '--resolution', 'a resolution with spaces']]) {
    await refuse(args, /--resolution/);
  }
  // A refusal never repeats the refused value.
  await assert.rejects(command(['quote', 'wan-3.0', 'videorouter', '--resolution', 'syntheticSECRET'], () => {}, deps), (error) => !error.message.includes('SECRET'));
  assert.deepEqual(none.seen, []);
});

test('a refused resolution never looks for a provider key', async () => {
  let loads = 0;
  const loadMasterKey = async () => { loads++; return null; };
  const none = untouched();
  for (const args of [['submit', 'seedance-2.5', 'videorouter', '--max-usd', '99', '--confirm-charge', '--resolution', '768p', PROMPT], ['status', 'flux-3', 'videorouter', 'vid_123', '--resolution', '480p']]) {
    await assert.rejects(command(args, () => {}, { env: { DSHPROXY_HOME: guard }, fetchImpl: none.fetchImpl, loadMasterKey }), /resolution/i);
  }
  assert.equal(loads, 0);
  assert.deepEqual(none.seen, []);
});

// ------------------------------- what the listing says about the workspace clip -------------------------------

test('the offline listing of a model states the clip its Krea route runs: a resolution, or the fixed tier\'s name', async () => {
  const none = untouched();
  const clip = async (model) => (await printed(['quote', model], none)).workspace;
  for (const model of ['seedance-2.5', 'seedance-2.0', 'wan-3.0', 'flux-3']) assert.deepEqual(await clip(model), { route: 'krea', durationSeconds: 5, aspectRatio: '16:9', resolution: '720p' }, model);
  assert.deepEqual(await clip('minimax-h3'), { route: 'krea', durationSeconds: 5, aspectRatio: '16:9', fixedTier: '2K' });
  assert.deepEqual(none.seen, []);
});

test('the help names --resolution for every route and the entries commands', async () => {
  const lines = []; await command(['help'], (text) => lines.push(text)); const help = lines.join('\n');
  for (const line of ['video quote MODEL [ROUTE] [--resolution R]', 'video entries', 'video entries set MODEL RESOLUTION ROUTE on|off', 'video status MODEL ROUTE JOB_ID [--resolution R]']) assert.ok(help.includes(line), line);
  assert.match(help, /--max-usd AMOUNT --confirm-charge \[--resolution R\] "PROMPT"/);
  assert.match(help, /--max-credits COUNT --confirm-charge \[--resolution R\] "PROMPT"/);
});
