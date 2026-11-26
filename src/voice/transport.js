'use strict';
const keys = require('../video/keys');
const MAX_JSON = 4 * 1024 * 1024;
const MAX_AUDIO = 50 * 1024 * 1024;
// No configurable origin, redirects, retries, or provider error text. In particular,
// never retry a paid POST whose outcome is ambiguous.
async function request(route, {body, json=false}={}, {env=process.env, fetchImpl=globalThis.fetch, loadMasterKey}={}) {
  const key = await keys.resolve(env.DSHPROXY_HOME || undefined, 'elevenlabs', {env, loadMasterKey});
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(key)) throw new Error('Invalid ElevenLabs credential.');
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 120000);
  try {
    const headers = {'xi-api-key':key, Accept:json ? 'application/json' : 'audio/mpeg'};
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';
    const response = await fetchImpl(`https://api.elevenlabs.io${route}`, {method:body === undefined ? 'GET' : 'POST', body, headers, redirect:'error', signal:controller.signal});
    if (response.status !== 200) throw new Error();
    const type = (response.headers.get('content-type') || '').split(';')[0];
    if (json ? type !== 'application/json' : !['audio/mpeg','audio/mp3','application/octet-stream'].includes(type)) throw new Error();
    const limit = json ? MAX_JSON : MAX_AUDIO;
    if (Number(response.headers.get('content-length')) > limit || !response.body) throw new Error();
    const chunks=[]; let size=0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) { controller.abort(); throw new Error(); }
      chunks.push(Buffer.from(chunk));
    }
    if (!size) throw new Error();
    const bytes = Buffer.concat(chunks);
    return json ? JSON.parse(bytes.toString('utf8')) : bytes;
  } catch {
    controller.abort();
    throw new Error('ElevenLabs request failed or returned an invalid/oversized response. No retry was made; a submitted request may have been charged.');
  }
  finally { clearTimeout(timer); }
}
module.exports = {request};
