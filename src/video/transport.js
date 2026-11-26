'use strict';

const {entries} = require('./catalog');

// How each provider is sent the resolution of a clip. Only a route, provider
// model id and resolution that are one catalog entry are ever sent: a wrong or
// ignored resolution would buy a different clip than the one quoted.
//
// VideoRouter, https://videorouter.sh/docs/api-reference-video: `resolution`
// is "a tier the specific model supports", written as on the model's page
// ("480p", "720p", "1080p"). The same page says an unsupported one is
// "silently ignored (model default used), never a 400", so the request names
// the one host whose page lists that tier at the quoted price and switches
// fallbacks off (https://videorouter.sh/docs/provider-selection). The host is
// the last part of the model id.
const vr = {
  submit: 'https://videorouter.sh/api/v1/videos', jobs: 'https://videorouter.sh/api/v1/videos/',
  body: (model, prompt, resolution) => ({model, prompt, resolution, duration_secs: 5, aspect_ratio: '16:9',
    provider: {only: [model.split('/')[2]], allow_fallbacks: false}}),
};
const providers = new Map([
  ['elevenlabs', {submit:'https://api.elevenlabs.io/v1/flows/video', jobs:'https://api.elevenlabs.io/v1/flows/video/'}],
  ['videorouter', vr],
  ['videorouter-replicate', vr],
  // KovAPI, https://docs.kovapi.com/seedance-2.5/md (the same parameter on
  // /seedance-2.0/md, /wan3.0-video/md and /minimax-h3/md): `resolution` is
  // "480P / 720P / 1080P" ("480P / 768P / 1080P" for MiniMax H3), upper case,
  // "Keep the P". Always sent: MiniMax H3 renders 1080P when it is omitted.
  ['kovapi', {submit: 'https://kovapi.com/v1/videos/generations', jobs: 'https://kovapi.com/v1/videos/jobs/',
    body: (model, prompt, resolution) => ({model, prompt, duration: 5, resolution: resolution.toUpperCase(), size: '16:9'})}],
  // Callirra, https://callirra.com/guides/minimax-h3/h3-api-mcp-cli-contract:
  // `resolution` as "768P", "matched case-insensitively"; the tiers 480P, 768P
  // and 1080P are on https://callirra.com/minimax-h3. An unsupported one is
  // refused with HTTP 400 before a job exists.
  ['callirra', {submit: 'https://api.callirra.com/v1/videos', jobs: 'https://api.callirra.com/v1/videos/',
    body: (model, prompt, resolution) => ({model, prompt, mode: 'text_to_video', duration_seconds: 5, resolution: resolution.toUpperCase(), aspect_ratio: '16:9'})}],
]);
// The catalog entry a request is for. With no resolution named it is the one
// the route runs by default (720p, or 768p for MiniMax H3), as before
// resolutions existed.
function clip(route, modelId, resolution) {
  if (!providers.has(route)) return undefined;
  return entries().find((entry) => entry.route === route && entry.modelId === modelId
    && (resolution === undefined ? entry.default : entry.resolution === resolution));
}
const STATES = {
  elevenlabs: ['pending','generating','completed','failed'],
  videorouter: ['queued', 'in_progress', 'processing', 'completed', 'failed'],
  kovapi: ['queued', 'processing', 'succeeded', 'failed'],
  callirra: ['queued', 'running', 'completed', 'failed', 'cancelled', 'expired'],
};
function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);
}
function outputLink(value, key) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('https://') || /[\s\x00-\x1f\x7f\\]/.test(value)) return;
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.hash && !value.includes(key) && !decodeURIComponent(value).includes(key)) return url.href;
  } catch { /* Malformed or unsafe provider metadata is omitted, not echoed. */ }
}
async function request(isSubmit, {route, modelId, resolution, jobId, prompt, durationSeconds, image, audio, key, fetchImpl = fetch}) {
  const entry = clip(route, modelId, resolution);
  if (!entry) throw new Error('Invalid video route or model');
  const provider = providers.get(route);
  if (typeof key !== 'string' || !key || key.length > 4096 || /[^\x21-\x7e]/.test(key)) throw new Error('Invalid video provider credential');
  const elevenBody = isSubmit && route === 'elevenlabs' ? require('./elevenlabs').body(entry, {prompt,durationSeconds,image,audio}) : undefined;
  if (isSubmit ? !elevenBody && (typeof prompt !== 'string' || !prompt.trim()) : !validId(jobId) || jobId.includes(key)) throw new Error(isSubmit ? 'Invalid video prompt' : 'Invalid video job ID');
  const init = {method: isSubmit ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: {Authorization: `Bearer ${key}`}};
  if (route === 'elevenlabs') init.headers = {'xi-api-key':key};
  if (isSubmit) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(elevenBody || provider.body(modelId, prompt, entry.resolution));
  }
  try {
    const response = await fetchImpl(isSubmit ? provider.submit : provider.jobs + jobId, init);
    if (!response.ok || response.redirected) {
      await response.body?.cancel();
      throw new Error();
    }
    const json = await response.json();
    const job = route === 'callirra' ? json.job : json;
    const {id, status} = job;
    const states = STATES[route === 'videorouter-replicate' ? 'videorouter' : route];
    if (!validId(id) || id.includes(key) || (!isSubmit && id !== jobId) || !states.includes(status)) throw new Error();
    const result = {id, status};
    // A missing final cost is unknown, not zero. A reservation is not a charge.
    if (!isSubmit && route.startsWith('videorouter') && ['failed', 'completed'].includes(status)
        && Number.isFinite(job.cost_usd) && job.cost_usd >= 0) result.chargedUsd = job.cost_usd;
    if (route === 'callirra' && typeof job.credits_reserved === 'string' && /^\d{1,12}$/.test(job.credits_reserved)) {
      result.reservedCredits = Number(job.credits_reserved) / 100;
    }
    if (status === 'succeeded' || status === 'completed') {
      const url = outputLink(['callirra','elevenlabs'].includes(route) ? job.content_url : job.data?.[0]?.url, key);
      if (url) result.outputUrl = url;
    }
    return result;
  } catch {
    // Even a non-2xx or malformed response cannot prove the provider didn't queue a paid job.
    throw new Error(isSubmit ? 'Video submission unconfirmed; do not retry until provider history is checked.' : 'Video job status could not be verified.');
  }
}
module.exports = {submit: args => request(true, args), status: args => request(false, args)};
