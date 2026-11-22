'use strict';
// Benchmark snapshots, not live invoices. Amounts include VideoRouter's 2.5%
// platform charge where applicable and round up to the next whole USD micro.
function vr(modelId, usdMicros) {
  return { modelId, usdMicros, sourceUrls: [`https://videorouter.sh/video/${modelId}`] };
}
function kov(modelId, usdMicros) {
  return { modelId, usdMicros, sourceUrls: [`https://kovapi.com/model/${modelId}`] };
}
const catalog = {
  'seedance-2.5': { defaultRoute: 'videorouter', resolution: '720p', routes: {
    videorouter: vr('bytedance/seedance-2.5/socheap-overseas', 702125),
    kovapi: kov('seedance-2.5', 790000),
  } },
  'seedance-2.0': { defaultRoute: 'videorouter', resolution: '720p', routes: {
    videorouter: vr('bytedance/seedance-2.0/socheap-overseas', 459200),
    kovapi: kov('seedance-2.0', 525000),
  } },
  'minimax-h3': { defaultRoute: 'kovapi', resolution: '768p', routes: {
    kovapi: kov('minimax-h3', 125000),
    callirra: { modelId: 'minimax-h3', usdMicros: 99667, credits: 10, priceBasis: 'effective',
      assumption: 'Full use of monthly Pro: $29.90 for 3,000 credits (300 clips).',
      sourceUrls: ['https://callirra.com/pricing', 'https://callirra.com/guides/minimax-h3/h3-api-mcp-cli-contract'] },
  } },
  'wan-3.0': { defaultRoute: 'videorouter', resolution: '720p', routes: {
    videorouter: vr('alibaba/wan-3.0/botsmart', 226013),
    'videorouter-replicate': vr('alibaba/wan-3.0/replicate', 256250),
    kovapi: kov('wan3.0-video', 325000),
  } },
};
const models = Object.freeze(Object.keys(catalog));
function quote(model, route) {
  if (!models.includes(model)) throw new Error('Unknown video model');
  const { defaultRoute, resolution, routes } = catalog[model];
  if (route === undefined) route = defaultRoute;
  if (typeof route !== 'string' || !Object.hasOwn(routes, route)) throw new Error(`Unsupported video route for ${model}`);
  const { sourceUrls, ...details } = routes[route];
  return { model, route, resolution, durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21',
    priceBasis: 'published', ...details, sourceUrls: [...sourceUrls] };
}
function routesFor(model) {
  if (!models.includes(model)) throw new Error('Unknown video model');
  return [...Object.keys(catalog[model].routes), 'krea'];
}
module.exports = { models, quote, routesFor };
