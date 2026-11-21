'use strict';

// https://videorouter.sh/docs/api-reference-video and /docs/provider-selection
const vr = {
  submit: 'https://videorouter.sh/api/v1/videos', jobs: 'https://videorouter.sh/api/v1/videos/',
  body: (model, prompt) => ({model, prompt, resolution: '720p', duration_secs: 5, aspect_ratio: '16:9',
    provider: {only: [model.split('/')[2]], allow_fallbacks: false}}),
};
const providers = new Map([
  ['videorouter', {...vr, models: ['bytedance/seedance-2.0/socheap-overseas', 'bytedance/seedance-2.5/socheap-overseas', 'alibaba/wan-3.0/botsmart']}],
  ['videorouter-replicate', {...vr, models: ['alibaba/wan-3.0/replicate']}],
  // https://docs.kovapi.com/minimax-h3 (same job protocol for Seedance and Wan)
  ['kovapi', {submit: 'https://kovapi.com/v1/videos/generations', jobs: 'https://kovapi.com/v1/videos/jobs/',
    models: ['minimax-h3', 'seedance-2.0', 'seedance-2.5', 'wan3.0-video'],
    body: (model, prompt) => ({model, prompt, duration: 5, resolution: model === 'minimax-h3' ? '768P' : '720P', size: '16:9'})}],
  // https://callirra.com/guides/minimax-h3/h3-api-mcp-cli-contract
  ['callirra', {submit: 'https://api.callirra.com/v1/videos', jobs: 'https://api.callirra.com/v1/videos/', models: ['minimax-h3'],
    body: (model, prompt) => ({model, prompt, mode: 'text_to_video', duration_seconds: 5, resolution: '768P', aspect_ratio: '16:9'})}],
]);

const STATES = {
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
async function request(isSubmit, {route, modelId, jobId, prompt, key, fetchImpl = fetch}) {
  const provider = providers.get(route);
  if (!provider?.models.includes(modelId)) throw new Error('Invalid video route or model');
  if (typeof key !== 'string' || !key || key.length > 4096 || /[^\x21-\x7e]/.test(key)) throw new Error('Invalid video provider credential');
  if (isSubmit ? typeof prompt !== 'string' || !prompt.trim() : !validId(jobId) || jobId.includes(key)) throw new Error(isSubmit ? 'Invalid video prompt' : 'Invalid video job ID');
  const init = {method: isSubmit ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: {Authorization: `Bearer ${key}`}};
  if (isSubmit) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(provider.body(modelId, prompt));
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
      const url = outputLink(route === 'callirra' ? job.content_url : job.data?.[0]?.url, key);
      if (url) result.outputUrl = url;
    }
    return result;
  } catch {
    // Even a non-2xx or malformed response cannot prove the provider didn't queue a paid job.
    throw new Error(isSubmit ? 'Video submission unconfirmed; do not retry until provider history is checked.' : 'Video job status could not be verified.');
  }
}
module.exports = {submit: args => request(true, args), status: args => request(false, args)};
