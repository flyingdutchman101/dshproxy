'use strict';
// The catalog by model, resolution and route. Every table here is written out
// by hand from docs/work/0010-video-resolution-pricing (report.md and its two
// parts), docs/work/0011-video-in-model-picker/evidence/krea-live-shapes.md and
// docs/work/0012-new-models-check/video-providers.md, never computed from the
// catalog, so a figure that changes in the catalog fails here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/video/catalog');

// [model, resolution, route, label, provider model id, US dollar micros]
const PRICED = [
  ['seedance-2.5', '480p', 'videorouter', 'Seedance 2.5 - 480p - VideoRouter', 'bytedance/seedance-2.5/botsmart', 409488],
  ['seedance-2.5', '720p', 'videorouter', 'Seedance 2.5 - 720p - VideoRouter', 'bytedance/seedance-2.5/socheap-overseas', 702125],
  ['seedance-2.5', '1080p', 'videorouter', 'Seedance 2.5 - 1080p - VideoRouter', 'bytedance/seedance-2.5/botsmart', 2272938],
  ['seedance-2.5', '480p', 'kovapi', 'Seedance 2.5 - 480p - KovAPI', 'seedance-2.5', 500000],
  ['seedance-2.5', '720p', 'kovapi', 'Seedance 2.5 - 720p - KovAPI', 'seedance-2.5', 790000],
  ['seedance-2.5', '1080p', 'kovapi', 'Seedance 2.5 - 1080p - KovAPI', 'seedance-2.5', 1900000],
  ['seedance-2.0', '480p', 'videorouter', 'Seedance 2.0 - 480p - VideoRouter', 'bytedance/seedance-2.0/botsmart', 281363],
  ['seedance-2.0', '720p', 'videorouter', 'Seedance 2.0 - 720p - VideoRouter', 'bytedance/seedance-2.0/socheap-overseas', 459200],
  ['seedance-2.0', '1080p', 'videorouter', 'Seedance 2.0 - 1080p - VideoRouter', 'bytedance/seedance-2.0/botsmart', 1521100],
  ['seedance-2.0', '480p', 'kovapi', 'Seedance 2.0 - 480p - KovAPI', 'seedance-2.0', 350000],
  ['seedance-2.0', '720p', 'kovapi', 'Seedance 2.0 - 720p - KovAPI', 'seedance-2.0', 525000],
  ['seedance-2.0', '1080p', 'kovapi', 'Seedance 2.0 - 1080p - KovAPI', 'seedance-2.0', 1250000],
  ['minimax-h3', '480p', 'kovapi', 'MiniMax H3 - 480p - KovAPI', 'minimax-h3', 75000],
  ['minimax-h3', '768p', 'kovapi', 'MiniMax H3 - 768p - KovAPI', 'minimax-h3', 125000],
  ['minimax-h3', '1080p', 'kovapi', 'MiniMax H3 - 1080p - KovAPI', 'minimax-h3', 180000],
  ['minimax-h3', '480p', 'callirra', 'MiniMax H3 - 480p - Callirra', 'minimax-h3', 49834],
  ['minimax-h3', '768p', 'callirra', 'MiniMax H3 - 768p - Callirra', 'minimax-h3', 99667],
  ['minimax-h3', '1080p', 'callirra', 'MiniMax H3 - 1080p - Callirra', 'minimax-h3', 149500],
  ['wan-3.0', '480p', 'videorouter', 'Wan 3.0 - 480p - VideoRouter', 'alibaba/wan-3.0/botsmart', 113263],
  ['wan-3.0', '720p', 'videorouter', 'Wan 3.0 - 720p - VideoRouter', 'alibaba/wan-3.0/botsmart', 226013],
  ['wan-3.0', '1080p', 'videorouter', 'Wan 3.0 - 1080p - VideoRouter', 'alibaba/wan-3.0/botsmart', 452025],
  ['wan-3.0', '480p', 'videorouter-replicate', 'Wan 3.0 - 480p - VideoRouter (Replicate)', 'alibaba/wan-3.0/replicate', 128125],
  ['wan-3.0', '720p', 'videorouter-replicate', 'Wan 3.0 - 720p - VideoRouter (Replicate)', 'alibaba/wan-3.0/replicate', 256250],
  ['wan-3.0', '1080p', 'videorouter-replicate', 'Wan 3.0 - 1080p - VideoRouter (Replicate)', 'alibaba/wan-3.0/replicate', 512500],
  ['wan-3.0', '480p', 'kovapi', 'Wan 3.0 - 480p - KovAPI', 'wan3.0-video', 200000],
  ['wan-3.0', '720p', 'kovapi', 'Wan 3.0 - 720p - KovAPI', 'wan3.0-video', 325000],
  ['wan-3.0', '1080p', 'kovapi', 'Wan 3.0 - 1080p - KovAPI', 'wan3.0-video', 650000],
  ['flux-3', '720p', 'videorouter', 'Flux 3 - 720p - VideoRouter', 'black-forest-labs/flux-3/black-forest-labs', 871250],
  ['flux-3', '1080p', 'videorouter', 'Flux 3 - 1080p - VideoRouter', 'black-forest-labs/flux-3/black-forest-labs', 1486250],
];
// Plan credits for the reference clip on Callirra.
const CREDITS = { '480p': 5, '768p': 10, '1080p': 15 };
// [model, resolution or tier name, label, Krea model id, units a free preflight returned on 2026-11-22]
const WORKSPACE = [
  ['seedance-2.5', '480p', 'Seedance 2.5 - 480p - Krea', 'bytedance/seedance-2-5', 380.33333333333326],
  ['seedance-2.5', '720p', 'Seedance 2.5 - 720p - Krea', 'bytedance/seedance-2-5', 856],
  ['seedance-2.5', '1080p', 'Seedance 2.5 - 1080p - Krea', 'bytedance/seedance-2-5', 2106],
  ['seedance-2.0', '480p', 'Seedance 2.0 - 480p - Krea', 'bytedance/seedance-2', 248.8111111111111],
  ['seedance-2.0', '720p', 'Seedance 2.0 - 720p - Krea', 'bytedance/seedance-2', 560],
  ['seedance-2.0', '1080p', 'Seedance 2.0 - 1080p - Krea', 'bytedance/seedance-2', 1385.9999999999998],
  ['minimax-h3', '2K', 'MiniMax H3 - 2K - Krea', 'minimax/hailuo-3', 481.48148148148147],
  ['wan-3.0', '480p', 'Wan 3.0 - 480p - Krea', 'alibaba/wan-3.0', 277.77777777777777],
  ['wan-3.0', '720p', 'Wan 3.0 - 720p - Krea', 'alibaba/wan-3.0', 555.5555555555555],
  ['wan-3.0', '1080p', 'Wan 3.0 - 1080p - Krea', 'alibaba/wan-3.0', 1111.111111111111],
  ['flux-3', '720p', 'Flux 3 - 720p - Krea', 'black-forest-labs/flux-3-video', 629.6296296296297],
  ['flux-3', '1080p', 'Flux 3 - 1080p - Krea', 'black-forest-labs/flux-3-video', 1074.0740740740741],
];
const ELEVEN = [
  ['seedance-2.0','Seedance 2.0',['480p','720p','1080p','4k']],
  ['seedance-2.5','Seedance 2.5',['480p','720p','1080p','4k']],
  ['seedance-2.0-fast','Seedance 2.0 Fast',['480p','720p']],
  ['seedance-2.0-mini','Seedance 2.0 Mini',['480p','720p']],
  ['veo-3.1','Veo 3.1',['720p','1080p','4K']],
  ['veo-3.1-fast','Veo 3.1 Fast',['720p','1080p','4K']],
  ['aurora','Aurora',['480p','720p']],
].flatMap(([model,name,resolutions])=>resolutions.map(resolution=>({model,resolution,route:'elevenlabs',label:`${name} - ${resolution} - ElevenLabs`})));
const key = (entry) => `${entry.model} / ${entry.resolution} / ${entry.route}`;
const find = (model, resolution, route) => catalog.entries().find((entry) => entry.model === model && entry.resolution === resolution && entry.route === route);

test('entries() lists exactly the combinations with a published price or a recorded workspace schema, each under its picker name', () => {
  const listed = catalog.entries();
  const expected = [...PRICED.map(([model, resolution, route, label]) => ({ model, resolution, route, label })),
    ...WORKSPACE.map(([model, resolution, label]) => ({ model, resolution, route: 'krea', label })), ...ELEVEN];
  assert.equal(listed.length, 61);
  assert.deepEqual(listed.map(key).sort(), expected.map(key).sort());
  for (const want of expected) assert.equal(find(want.model, want.resolution, want.route).label, want.label);
  assert.equal(new Set(listed.map((entry) => entry.label)).size, listed.length);
  assert.equal(listed.filter((entry) => entry.route === 'krea').length, 12);
});

test('every entry carries a price or the live-quote marker, a date and at least one source', () => {
  for (const entry of catalog.entries()) {
    const name = key(entry);
    if (entry.route === 'elevenlabs') {
      assert.equal(entry.priceBasis, 'unavailable');
      assert.equal(entry.usdMicros, undefined);
      assert.equal(entry.verifiedOn, '2026-11-26');
      assert.deepEqual(entry.sourceUrls, ['https://api.elevenlabs.io/openapi.json']);
      continue;
    }
    assert.deepEqual([entry.durationSeconds, entry.aspectRatio], [5, '16:9'], name);
    assert.match(entry.verifiedOn, /^2026-11-2[12]$/, name);
    assert.ok(Array.isArray(entry.sourceUrls) && entry.sourceUrls.length >= 1, name);
    for (const url of entry.sourceUrls) assert.match(url, /^https:\/\/[^\s"<>\\]+$/, name);
    assert.equal(typeof entry.modelId, 'string', name);
    assert.equal(typeof entry.default, 'boolean', name);
    if (entry.route === 'krea') {
      assert.equal(entry.priceBasis, 'live-quote', name);
      assert.equal(entry.unit, 'workspace_compute_units', name);
      assert.match(entry.basis, /quoted live in workspace/i, name);
      assert.equal(entry.usdMicros, undefined, name);
      assert.equal(entry.credits, undefined, name);
    } else {
      assert.ok(['published', 'effective'].includes(entry.priceBasis), name);
      assert.ok(Number.isSafeInteger(entry.usdMicros) && entry.usdMicros > 0, name);
      assert.equal(entry.fixedTier, false, name);
      assert.equal(entry.reference, undefined, name);
    }
  }
});

test('each priced entry has the provider model id and the price of its own resolution', () => {
  for (const [model, resolution, route, , modelId, usdMicros] of PRICED) {
    const entry = find(model, resolution, route);
    assert.deepEqual([entry.modelId, entry.usdMicros], [modelId, usdMicros], key(entry));
    const q = catalog.quote(model, route, resolution);
    assert.deepEqual([q.model, q.route, q.resolution, q.modelId, q.usdMicros, q.durationSeconds, q.aspectRatio], [model, route, resolution, modelId, usdMicros, 5, '16:9'], key(entry));
    assert.deepEqual([q.verifiedOn, q.sourceUrls, q.priceBasis], [entry.verifiedOn, entry.sourceUrls, entry.priceBasis], key(entry));
    if (route === 'callirra') {
      assert.deepEqual([entry.priceBasis, entry.credits, entry.unit, q.credits], ['effective', CREDITS[resolution], 'plan_credits', CREDITS[resolution]], key(entry));
      assert.match(entry.assumption, /full use of monthly Pro: \$29\.90 for 3,000 credits/i);
    } else {
      assert.deepEqual([entry.priceBasis, entry.credits, entry.unit], ['published', undefined, 'USD'], key(entry));
    }
  }
});

// Today's nine answers, whole: the 720p (768p for MiniMax H3) figures, their
// date and their sources stay exactly as they were before resolutions existed.
const TODAY = [
  { model: 'seedance-2.5', route: 'videorouter', resolution: '720p', durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21', priceBasis: 'published',
    modelId: 'bytedance/seedance-2.5/socheap-overseas', usdMicros: 702125, sourceUrls: ['https://videorouter.sh/video/bytedance/seedance-2.5/socheap-overseas'] },
  { model: 'seedance-2.5', route: 'kovapi', resolution: '720p', durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21', priceBasis: 'published',
    modelId: 'seedance-2.5', usdMicros: 790000, sourceUrls: ['https://kovapi.com/model/seedance-2.5'] },
  { model: 'seedance-2.0', route: 'videorouter', resolution: '720p', durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21', priceBasis: 'published',
    modelId: 'bytedance/seedance-2.0/socheap-overseas', usdMicros: 459200, sourceUrls: ['https://videorouter.sh/video/bytedance/seedance-2.0/socheap-overseas'] },
  { model: 'seedance-2.0', route: 'kovapi', resolution: '720p', durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21', priceBasis: 'published',
    modelId: 'seedance-2.0', usdMicros: 525000, sourceUrls: ['https://kovapi.com/model/seedance-2.0'] },
  { model: 'minimax-h3', route: 'kovapi', resolution: '768p', durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21', priceBasis: 'published',
    modelId: 'minimax-h3', usdMicros: 125000, sourceUrls: ['https://kovapi.com/model/minimax-h3'] },
  { model: 'minimax-h3', route: 'callirra', resolution: '768p', durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21', priceBasis: 'effective',
    modelId: 'minimax-h3', usdMicros: 99667, credits: 10, assumption: 'Full use of monthly Pro: $29.90 for 3,000 credits (300 clips).',
    sourceUrls: ['https://callirra.com/pricing', 'https://callirra.com/guides/minimax-h3/h3-api-mcp-cli-contract'] },
  { model: 'wan-3.0', route: 'videorouter', resolution: '720p', durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21', priceBasis: 'published',
    modelId: 'alibaba/wan-3.0/botsmart', usdMicros: 226013, sourceUrls: ['https://videorouter.sh/video/alibaba/wan-3.0/botsmart'] },
  { model: 'wan-3.0', route: 'videorouter-replicate', resolution: '720p', durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21', priceBasis: 'published',
    modelId: 'alibaba/wan-3.0/replicate', usdMicros: 256250, sourceUrls: ['https://videorouter.sh/video/alibaba/wan-3.0/replicate'] },
  { model: 'wan-3.0', route: 'kovapi', resolution: '720p', durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21', priceBasis: 'published',
    modelId: 'wan3.0-video', usdMicros: 325000, sourceUrls: ['https://kovapi.com/model/wan3.0-video'] },
];
test('without a resolution a quote is exactly the answer given before resolutions existed, and naming that resolution changes nothing', () => {
  for (const want of TODAY) {
    assert.deepEqual(catalog.quote(want.model, want.route), want, `${want.model} ${want.route}`);
    assert.deepEqual(catalog.quote(want.model, want.route, want.resolution), want, `${want.model} ${want.route}`);
    const entry = find(want.model, want.resolution, want.route);
    assert.deepEqual([entry.usdMicros, entry.modelId, entry.verifiedOn, entry.sourceUrls, entry.default], [want.usdMicros, want.modelId, want.verifiedOn, want.sourceUrls, true]);
  }
  for (const [model, route] of [['seedance-2.5', 'videorouter'], ['seedance-2.0', 'videorouter'], ['minimax-h3', 'kovapi'], ['wan-3.0', 'videorouter']]) {
    assert.deepEqual(catalog.quote(model), catalog.quote(model, route));
    assert.deepEqual(catalog.quote(model, undefined, catalog.quote(model).resolution), catalog.quote(model));
  }
  // Exactly one resolution per model and route is the one used when none is named.
  const defaults = catalog.entries().filter((entry) => entry.default);
  assert.deepEqual(defaults.map((entry) => `${entry.model} ${entry.route}`).sort(), [...new Set(catalog.entries().map((entry) => `${entry.model} ${entry.route}`))].sort());
  for (const entry of defaults) assert.ok(entry.fixedTier || entry.resolution === (entry.model === 'minimax-h3' ? '768p' : '720p'), key(entry));
});

test('Flux 3 is a fifth model: on VideoRouter and on Krea at 720p and 1080p, and nowhere at 480p', () => {
  assert.deepEqual(catalog.models, ['seedance-2.5', 'seedance-2.0', 'minimax-h3', 'wan-3.0', 'flux-3', 'seedance-2.0-fast', 'seedance-2.0-mini', 'veo-3.1', 'veo-3.1-fast', 'aurora']);
  assert.deepEqual(catalog.routesFor('flux-3'), ['videorouter', 'krea']);
  assert.deepEqual(catalog.entries().filter((entry) => entry.model === 'flux-3').map((entry) => [entry.resolution, entry.route, entry.modelId]), [
    ['720p', 'videorouter', 'black-forest-labs/flux-3/black-forest-labs'], ['1080p', 'videorouter', 'black-forest-labs/flux-3/black-forest-labs'],
    ['720p', 'krea', 'black-forest-labs/flux-3-video'], ['1080p', 'krea', 'black-forest-labs/flux-3-video'],
  ]);
  const q = catalog.quote('flux-3');
  assert.deepEqual([q.route, q.resolution, q.modelId, q.usdMicros], ['videorouter', '720p', 'black-forest-labs/flux-3/black-forest-labs', 871250]);
  assert.equal(catalog.quote('flux-3', 'videorouter', '1080p').usdMicros, 1486250);
  for (const route of ['kovapi', 'callirra', 'videorouter-replicate', 'krea']) assert.throws(() => catalog.quote('flux-3', route), /route/i, route);
  assert.throws(() => catalog.quote('flux-3', 'videorouter', '480p'), /resolution/i);
});

test('a VideoRouter entry names the host its price belongs to, and that host is the last part of the model id sent', () => {
  const hosts = Object.fromEntries(catalog.entries().filter((entry) => entry.route.startsWith('videorouter')).map((entry) => [key(entry), entry.host]));
  assert.deepEqual(hosts, {
    'seedance-2.5 / 480p / videorouter': 'botsmart', 'seedance-2.5 / 720p / videorouter': 'socheap-overseas', 'seedance-2.5 / 1080p / videorouter': 'botsmart',
    'seedance-2.0 / 480p / videorouter': 'botsmart', 'seedance-2.0 / 720p / videorouter': 'socheap-overseas', 'seedance-2.0 / 1080p / videorouter': 'botsmart',
    'wan-3.0 / 480p / videorouter': 'botsmart', 'wan-3.0 / 720p / videorouter': 'botsmart', 'wan-3.0 / 1080p / videorouter': 'botsmart',
    'wan-3.0 / 480p / videorouter-replicate': 'replicate', 'wan-3.0 / 720p / videorouter-replicate': 'replicate', 'wan-3.0 / 1080p / videorouter-replicate': 'replicate',
    'flux-3 / 720p / videorouter': 'black-forest-labs', 'flux-3 / 1080p / videorouter': 'black-forest-labs',
  });
  for (const entry of catalog.entries()) {
    if (entry.route.startsWith('videorouter')) assert.equal(entry.modelId.split('/')[2], entry.host, key(entry));
    else assert.equal(entry.host, undefined, key(entry));
  }
});

test('a Krea entry has no fixed price: it is quoted live, and the units recorded on 2026-11-22 are kept whole as a dated reference', () => {
  for (const [model, resolution, , modelId, units] of WORKSPACE) {
    const entry = find(model, resolution, 'krea');
    assert.equal(entry.modelId, modelId, key(entry));
    assert.deepEqual([entry.reference.computeUnits, entry.reference.recordedOn], [units, '2026-11-22'], key(entry));
    assert.match(entry.reference.note, /not a price/i, key(entry));
    assert.throws(() => catalog.quote(model, 'krea'), /route/i);
    assert.throws(() => catalog.quote(model, 'krea', resolution), /route/i);
  }
  assert.deepEqual(catalog.entries().filter((entry) => entry.route === 'krea' && entry.default).map((entry) => `${entry.model} ${entry.resolution}`),
    ['seedance-2.5 720p', 'seedance-2.0 720p', 'minimax-h3 2K', 'wan-3.0 720p', 'flux-3 720p']);
});

test('MiniMax H3 on Krea is one fixed tier under the name Krea gives it, and has no resolution', () => {
  const tiers = catalog.entries().filter((entry) => entry.fixedTier);
  assert.deepEqual(tiers.map(key), ['minimax-h3 / 2K / krea']);
  assert.equal(tiers[0].label, 'MiniMax H3 - 2K - Krea');
  assert.deepEqual(catalog.entries().filter((entry) => entry.model === 'minimax-h3' && entry.route === 'krea').map((entry) => entry.resolution), ['2K']);
  assert.deepEqual(catalog.workspaceClip('minimax-h3'), { model: 'minimax-h3', route: 'krea', modelId: 'minimax/hailuo-3', resolution: '2K', fixedTier: true });
  assert.deepEqual(catalog.workspaceClip('minimax-h3', '2K'), catalog.workspaceClip('minimax-h3'));
  for (const resolution of ['480p', '720p', '768p', '1080p', '2k', '4k']) assert.throws(() => catalog.workspaceClip('minimax-h3', resolution), /fixed tier/i, resolution);
});

test('the workspace clip of a model is its Krea entry: the resolution to send, or none for a fixed tier', () => {
  assert.deepEqual(catalog.workspaceClip('wan-3.0'), { model: 'wan-3.0', route: 'krea', modelId: 'alibaba/wan-3.0', resolution: '720p', fixedTier: false, sends: '720p' });
  assert.deepEqual(catalog.workspaceClip('flux-3', '1080p'), { model: 'flux-3', route: 'krea', modelId: 'black-forest-labs/flux-3-video', resolution: '1080p', fixedTier: false, sends: '1080p' });
  assert.throws(() => catalog.workspaceClip('flux-3', '480p'), /resolution/i);
  assert.throws(() => catalog.workspaceClip('seedance-2.5', '768p'), /resolution/i);
  assert.throws(() => catalog.workspaceClip('wan-3.0-prime'), /Unknown video model/);
});

test('nothing is guessed: a combination without a published figure is not an entry and cannot be quoted', () => {
  // Seedance 2.5 has no 768p; SoCheap-Overseas lists 720p only; no route sells Flux 3 at 480p.
  assert.equal(catalog.entries().some((entry) => entry.model.startsWith('seedance') && entry.resolution === '768p'), false);
  assert.equal(catalog.entries().some((entry) => entry.model === 'flux-3' && entry.resolution === '480p'), false);
  assert.equal(catalog.entries().some((entry) => entry.model === 'minimax-h3' && entry.route.startsWith('videorouter')), false);
  assert.equal(catalog.entries().some((entry) => entry.route !== 'elevenlabs' && /^(4k|2160p|1440p|960p)$/i.test(entry.resolution)), false);
  assert.equal(catalog.entries().some((entry) => entry.modelId.includes('socheap-overseas') && entry.resolution !== '720p'), false);
  for (const [model, route, resolution] of [['seedance-2.5', 'videorouter', '768p'], ['seedance-2.5', 'kovapi', '768p'], ['seedance-2.0', 'kovapi', '4k'], ['minimax-h3', 'kovapi', '720p'],
    ['minimax-h3', 'callirra', '960p'], ['wan-3.0', 'videorouter', '1440p'], ['wan-3.0', 'videorouter', '720P'], ['wan-3.0', 'videorouter', ' 720p'], ['wan-3.0', 'videorouter', ''],
    ['wan-3.0', 'videorouter', 'constructor'], ['wan-3.0', 'videorouter', '__proto__'], ['wan-3.0', 'videorouter', 'toString'], ['wan-3.0', 'videorouter', null], ['wan-3.0', 'videorouter', 720],
    ['wan-3.0', undefined, '768p']]) {
    assert.throws(() => catalog.quote(model, route, resolution), /resolution/i, `${model} ${route} ${String(resolution)}`);
  }
  assert.throws(() => catalog.quote('minimax-h3', 'videorouter', '768p'), /route/i);
  assert.throws(() => catalog.quote('wan-3.0-prime', 'videorouter', '720p'), /Unknown video model/);
  // A refusal never repeats the refused value, which could be a credential pasted into the wrong place.
  assert.throws(() => catalog.quote('wan-3.0', 'videorouter', 'synthetic-SECRET-res'), (error) => !error.message.includes('SECRET'));
});

test('entries() hands out copies: changing one changes nothing for the next caller', () => {
  const first = catalog.entries();
  first[0].usdMicros = 1; first[0].sourceUrls.push('https://example.invalid/'); first.pop();
  const second = catalog.entries();
  assert.equal(second.length, 61);
  assert.equal(second[0].usdMicros, 409488);
  assert.equal(second[0].sourceUrls.includes('https://example.invalid/'), false);
});

// The Krea helper takes its model ids and its default resolution from
// src/video/krea-preset.js. The two tables must describe the same clips.
test('every Krea entry is a clip the Krea helper can prepare, under the same Krea model id', () => {
  const { prepare, modelId } = require('../src/video/krea-preset');
  const schema = (resolutions) => ({ type: 'object', properties: { prompt: { type: 'string' }, duration: { type: 'integer' }, aspect_ratio: { type: 'string' },
    ...(resolutions ? { resolution: { type: 'string', enum: resolutions } } : {}) } });
  for (const entry of catalog.entries().filter((item) => item.route === 'krea')) {
    assert.equal(modelId(entry.model), entry.modelId, key(entry));
    if (entry.fixedTier) {
      assert.deepEqual(prepare(entry.model, 'A wave', [entry.modelId], schema()).input, { prompt: 'A wave', duration: 5, aspect_ratio: '16:9' }, key(entry));
      continue;
    }
    const input = { prompt: 'A wave', duration: 5, aspect_ratio: '16:9', resolution: entry.resolution };
    assert.deepEqual(prepare(entry.model, 'A wave', [entry.modelId], schema([entry.resolution]), entry.resolution).input, input, key(entry));
    if (entry.default) assert.deepEqual(prepare(entry.model, 'A wave', [entry.modelId], schema([entry.resolution])).input, input, key(entry));
  }
});
