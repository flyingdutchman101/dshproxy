'use strict';
// The video catalog: for each model, each route and each resolution, whether
// the combination exists and what the reference clip (5 seconds, 16:9, text
// only) costs there. A combination that exists is an entry.
//
// Benchmark snapshots, not live invoices. Amounts include VideoRouter's 2.5%
// platform charge where applicable and round up to the next whole USD micro.
//
// Nothing here is interpolated or guessed: a combination without a published
// figure is left out. The figures and their sources are collected in
// docs/work/0010-video-resolution-pricing, docs/work/0012-new-models-check and
// docs/work/0011-video-in-model-picker/evidence/krea-live-shapes.md.
const CLIP = Object.freeze({ durationSeconds: 5, aspectRatio: '16:9' });
// The day the 720p (768p for MiniMax H3) figures were first verified, and the
// day every other figure was read. The first set was read again on the second
// day and had not changed; it keeps its date and sources.
const FIRST = '2026-11-21';
const DAY = '2026-11-22';
// The signed-in workspace route. It has no fixed price.
const WORKSPACE_ROUTE = 'krea';
const PROVIDERS = Object.freeze({
  videorouter: 'VideoRouter',
  'videorouter-replicate': 'VideoRouter (Replicate)',
  kovapi: 'KovAPI',
  callirra: 'Callirra',
  krea: 'Krea',
});

// VideoRouter prices belong to one host, the last part of the model id; the
// request names that host and switches fallbacks off (see transport.js). The
// host of a resolution is the one the price was read from, and only for a
// resolution that host's own page lists: VideoRouter ignores a resolution a
// host does not offer instead of refusing it.
function vr(modelId, usdMicros, verifiedOn = DAY) {
  const page = `https://videorouter.sh/video/${modelId}`;
  return { modelId, host: modelId.split('/')[2], usdMicros, verifiedOn,
    sourceUrls: verifiedOn === FIRST ? [page] : [page, 'https://videorouter.sh/pricing-index.json'] };
}
function kov(modelId, usdMicros, verifiedOn = DAY) {
  return { modelId, usdMicros, verifiedOn,
    sourceUrls: [verifiedOn === FIRST ? `https://kovapi.com/model/${modelId}` : `https://docs.kovapi.com/${modelId}/md`] };
}
// Callirra bills plan credits. The dollar figure is what those credits cost on
// the monthly Pro plan at full use, rounded up to the next whole micro.
function callirra(credits, usdMicros, clips, verifiedOn = DAY) {
  return { modelId: 'minimax-h3', usdMicros, credits, priceBasis: 'effective',
    assumption: `Full use of monthly Pro: $29.90 for 3,000 credits (${clips} clips).`, verifiedOn,
    sourceUrls: verifiedOn === FIRST
      ? ['https://callirra.com/pricing', 'https://callirra.com/guides/minimax-h3/h3-api-mcp-cli-contract']
      : ['https://callirra.com/credit-costs', 'https://callirra.com/pricing', 'https://callirra.com/minimax-h3'] };
}
// Krea: quoted live by a preflight in the signed-in workspace. `units` are
// what one free preflight returned on 2026-11-22 in one workspace (individual
// Max 4): a dated reference, not a price. The resolutions are the ones that
// model's live input schema listed and a preflight answered for.
const KREA_PAGES = ['https://www.krea.ai/docs/developers/mcp.md', 'https://api.krea.ai/openapi.json'];
function kreaRow(modelId, units, page, fixedTier) {
  return { modelId, units, fixedTier, verifiedOn: DAY, sourceUrls: page ? [...KREA_PAGES, page] : [...KREA_PAGES] };
}
function krea(modelId, unitsByResolution, page) {
  return Object.fromEntries(Object.entries(unitsByResolution).map(([resolution, units]) => [resolution, kreaRow(modelId, units, page, false)]));
}
// A fixed tier: the route offers this model without a resolution choice. It is
// listed under the name the provider gives the tier, and is sent no resolution.
function kreaTier(modelId, name, units, page) {
  return { [name]: kreaRow(modelId, units, page, true) };
}

// `resolution` is the one used when none is named. Rows are in rising order.
const catalog = {
  'seedance-2.5': { name: 'Seedance 2.5', defaultRoute: 'videorouter', resolution: '720p', routes: {
    // SoCheap-Overseas lists 720p only; at 480p and 1080p the cheapest host is BotSmart ($0.0799 and $0.4435 a second).
    videorouter: {
      '480p': vr('bytedance/seedance-2.5/botsmart', 409488),
      '720p': vr('bytedance/seedance-2.5/socheap-overseas', 702125, FIRST),
      '1080p': vr('bytedance/seedance-2.5/botsmart', 2272938),
    },
    kovapi: { '480p': kov('seedance-2.5', 500000), '720p': kov('seedance-2.5', 790000, FIRST), '1080p': kov('seedance-2.5', 1900000) },
    krea: krea('bytedance/seedance-2-5', { '480p': 380.33333333333326, '720p': 856, '1080p': 2106 }),
  } },
  'seedance-2.0': { name: 'Seedance 2.0', defaultRoute: 'videorouter', resolution: '720p', routes: {
    // As for Seedance 2.5: BotSmart at 480p and 1080p ($0.0549 and $0.2968 a second).
    videorouter: {
      '480p': vr('bytedance/seedance-2.0/botsmart', 281363),
      '720p': vr('bytedance/seedance-2.0/socheap-overseas', 459200, FIRST),
      '1080p': vr('bytedance/seedance-2.0/botsmart', 1521100),
    },
    kovapi: { '480p': kov('seedance-2.0', 350000), '720p': kov('seedance-2.0', 525000, FIRST), '1080p': kov('seedance-2.0', 1250000) },
    krea: krea('bytedance/seedance-2', { '480p': 248.8111111111111, '720p': 560, '1080p': 1385.9999999999998 }),
  } },
  'minimax-h3': { name: 'MiniMax H3', defaultRoute: 'kovapi', resolution: '768p', routes: {
    kovapi: { '480p': kov('minimax-h3', 75000), '768p': kov('minimax-h3', 125000, FIRST), '1080p': kov('minimax-h3', 180000) },
    // 5, 10 and 15 credits for the reference clip.
    callirra: { '480p': callirra(5, 49834, 600), '768p': callirra(10, 99667, 300, FIRST), '1080p': callirra(15, 149500, 200) },
    // Krea's minimax/hailuo-3 has no resolution field; Krea describes it as a "Frontier 2K model".
    krea: kreaTier('minimax/hailuo-3', '2K', 481.48148148148147, 'https://www.krea.ai/docs/api-reference/video/minimax-h3.md'),
  } },
  'wan-3.0': { name: 'Wan 3.0', defaultRoute: 'videorouter', resolution: '720p', routes: {
    videorouter: {
      '480p': vr('alibaba/wan-3.0/botsmart', 113263),
      '720p': vr('alibaba/wan-3.0/botsmart', 226013, FIRST),
      '1080p': vr('alibaba/wan-3.0/botsmart', 452025),
    },
    'videorouter-replicate': {
      '480p': vr('alibaba/wan-3.0/replicate', 128125),
      '720p': vr('alibaba/wan-3.0/replicate', 256250, FIRST),
      '1080p': vr('alibaba/wan-3.0/replicate', 512500),
    },
    kovapi: { '480p': kov('wan3.0-video', 200000), '720p': kov('wan3.0-video', 325000, FIRST), '1080p': kov('wan3.0-video', 650000) },
    krea: krea('alibaba/wan-3.0', { '480p': 277.77777777777777, '720p': 555.5555555555555, '1080p': 1111.111111111111 }, 'https://www.krea.ai/docs/api-reference/video/wan-30.md'),
  } },
  // No route offers Flux 3 at 480p. KovAPI and Callirra do not offer it at all.
  'flux-3': { name: 'Flux 3', defaultRoute: 'videorouter', resolution: '720p', routes: {
    // $0.17 and $0.29 a second at Black Forest Labs' own host; four more hosts list the same rates.
    videorouter: {
      '720p': vr('black-forest-labs/flux-3/black-forest-labs', 871250),
      '1080p': vr('black-forest-labs/flux-3/black-forest-labs', 1486250),
    },
    krea: krea('black-forest-labs/flux-3-video', { '720p': 629.6296296296297, '1080p': 1074.0740740740741 }, 'https://www.krea.ai/docs/api-reference/video/flux-3-video.md'),
  } },
};
const models = Object.freeze(Object.keys(catalog));

function known(model) {
  if (typeof model !== 'string' || !models.includes(model)) throw new Error('Unknown video model');
  return catalog[model];
}
function rowsOf(model, route) {
  const { routes } = known(model);
  if (typeof route !== 'string' || !Object.hasOwn(routes, route)) throw new Error(`Unsupported video route for ${model}`);
  return routes[route];
}
// The resolution a route runs when none is named: the model's own where the
// route has it, otherwise the route's one fixed tier.
function defaultOf(model, route) {
  const rows = rowsOf(model, route);
  const { resolution } = catalog[model];
  if (Object.hasOwn(rows, resolution)) return resolution;
  const [only, ...others] = Object.keys(rows);
  if (others.length || !rows[only].fixedTier) throw new Error(`The video catalog has no default resolution for ${model} on ${route}`);
  return only;
}
// One row of the catalog, or a refusal. A refusal never repeats the refused
// value, which could be a credential pasted into the wrong place.
function pick(model, route, resolution) {
  const rows = rowsOf(model, route);
  if (resolution === undefined) resolution = defaultOf(model, route);
  if (typeof resolution === 'string' && Object.hasOwn(rows, resolution)) return [resolution, rows[resolution]];
  const names = Object.keys(rows);
  if (rows[names[0]].fixedTier) throw new Error(`${catalog[model].name} on ${PROVIDERS[route]} is a fixed tier (${names[0]}): it takes no resolution.`);
  throw new Error(`Unsupported video resolution for ${model} on ${route}: that combination is not an entry. It exists at ${names.join(', ')}.`);
}

function describe(model, route, resolution, row) {
  const entry = { model, resolution, route, label: `${catalog[model].name} - ${resolution} - ${PROVIDERS[route]}`, modelId: row.modelId };
  if (row.host) entry.host = row.host;
  Object.assign(entry, { fixedTier: row.fixedTier === true, default: defaultOf(model, route) === resolution, ...CLIP });
  if (route === WORKSPACE_ROUTE) {
    Object.assign(entry, { priceBasis: 'live-quote', unit: 'workspace_compute_units',
      basis: 'Quoted live in workspace compute units by a preflight in the signed-in Krea workspace. There is no fixed price.',
      reference: { computeUnits: row.units, recordedOn: DAY,
        note: 'Units one free preflight returned on that day in one workspace. A dated reference, not a price.',
        record: 'docs/work/0011-video-in-model-picker/evidence/krea-live-shapes.md' } });
  } else if (row.priceBasis === 'effective') {
    Object.assign(entry, { priceBasis: 'effective', unit: 'plan_credits', usdMicros: row.usdMicros, credits: row.credits, assumption: row.assumption });
  } else {
    Object.assign(entry, { priceBasis: 'published', unit: 'USD', usdMicros: row.usdMicros });
  }
  return Object.assign(entry, { verifiedOn: row.verifiedOn, sourceUrls: [...row.sourceUrls] });
}

// Every combination that exists, in catalog order: by model, then route, then
// rising resolution. Each call returns fresh objects.
//   { model, resolution, route, label, modelId, [host], fixedTier, default,
//     durationSeconds, aspectRatio, priceBasis, unit, ..., verifiedOn, sourceUrls }
// `label` is the name a person picks: "Seedance 2.5 - 720p - Krea". A priced
// entry has `usdMicros` (and `credits` on a plan-credit route); a Krea entry
// has `priceBasis: 'live-quote'` and the dated `reference` units instead.
// `default` marks the resolution a route runs when none is named.
function entries() {
  const list = [];
  for (const model of models) {
    for (const [route, rows] of Object.entries(catalog[model].routes)) {
      for (const [resolution, row] of Object.entries(rows)) list.push(describe(model, route, resolution, row));
    }
  }
  return list;
}

// One entry by its three names, or a refusal saying which part does not exist.
function entry(model, resolution, route) {
  known(model);
  if (typeof resolution !== 'string') throw new Error('A video entry is named by a model, a resolution and a route.');
  const [name, row] = pick(model, route, resolution);
  return describe(model, route, name, row);
}

// The dated estimate of an API route. With no resolution it answers for the
// model's own one (720p, or 768p for MiniMax H3), exactly as it did before
// resolutions existed. The Krea route has no estimate: it is quoted live.
function quote(model, route, resolution) {
  const { defaultRoute } = known(model);
  if (route === undefined) route = defaultRoute;
  if (route === WORKSPACE_ROUTE) throw new Error(`Unsupported video route for ${model}`);
  const [name, row] = pick(model, route, resolution);
  return { model, route, resolution: name, ...CLIP, verifiedOn: row.verifiedOn, priceBasis: row.priceBasis || 'published',
    modelId: row.modelId, usdMicros: row.usdMicros,
    ...(row.credits === undefined ? {} : { credits: row.credits, assumption: row.assumption }),
    sourceUrls: [...row.sourceUrls] };
}

// The clip the Krea route runs for a model: at the named resolution, or at
// the route's own when none is named. `sends` is the resolution to hand to
// Krea; a fixed tier has none, and is named only by its tier.
function workspaceClip(model, resolution) {
  const [name, row] = pick(model, WORKSPACE_ROUTE, resolution);
  return { model, route: WORKSPACE_ROUTE, modelId: row.modelId, resolution: name, fixedTier: row.fixedTier, ...(row.fixedTier ? {} : { sends: name }) };
}

function routesFor(model) {
  const routes = Object.keys(known(model).routes);
  return [...routes.filter((route) => route !== WORKSPACE_ROUTE), ...routes.filter((route) => route === WORKSPACE_ROUTE)];
}

module.exports = { models, quote, routesFor, entries, entry, workspaceClip };
