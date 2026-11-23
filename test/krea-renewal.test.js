'use strict';
// The Krea sign-in renews itself. Everything here runs against a store in
// memory and a fake token endpoint: no network, no real sign-in, and every
// token is invented.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { login, access, status } = require('../src/krea-helper/oauth');

const resource = 'https://api.krea.ai/mcp';
const issuer = 'https://api.krea.ai';
const NOW = 1000000;
const now = () => NOW;
// A sign-in whose hour ended a second ago, with what a renewal needs.
const ended = { resource, accessToken: 'synthetic-old-access', refreshToken: 'synthetic-old-refresh', clientId: 'synthetic-client', tokenEndpoint: `${issuer}/token`, expiresAt: NOW - 1000 };

// A store in memory. `transaction` runs one piece of work at a time, as the
// real one does under its lock. `failSaves` makes that many saves fail.
function store(initial = ended, { failSaves = 0 } = {}) {
  const s = { value: initial === null ? null : { ...initial }, saves: 0, failSaves };
  let chain = Promise.resolve();
  const inner = {
    load: async () => { if (s.value === null) throw Object.assign(new Error('no file'), { code: 'ENOENT' }); return { ...s.value }; },
    save: async (v) => { s.saves += 1; if (s.failSaves > 0) { s.failSaves -= 1; throw new Error('disk'); } s.value = { ...v }; },
    clear: async () => { s.value = null; }
  };
  s.load = inner.load;
  s.transaction = async (work) => {
    const before = chain;
    let release;
    chain = new Promise((resolve) => { release = resolve; });
    await before;
    try { return await work(inner); } finally { release(); }
  };
  return s;
}
const granted = (extra = {}) => Response.json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', token_type: 'Bearer', expires_in: 3600, ...extra });
// A token endpoint that answers from a list and records what it was sent.
function endpoint(...answers) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), sent: Object.fromEntries(new URLSearchParams(options.body)), options });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    return next();
  };
  return { calls, fetchImpl };
}

// ------------------------------- sign-in -------------------------------

function signIn({ grants = ['authorization_code', 'refresh_token'], registration = () => Response.json({ client_id: 'synthetic-client', token_endpoint_auth_method: 'none', redirect_uris: ['http://127.0.0.1:12345/callback'] }), token = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600 } } = {}) {
  const calls = [];
  let saved;
  const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, code_challenge_methods_supported: ['S256'], response_types_supported: ['code'], ...(grants ? { grant_types_supported: grants } : {}) };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('oauth-protected-resource')) return Response.json({ resource, authorization_servers: [issuer] });
    if (String(url).includes('oauth-authorization-server')) return Response.json(metadata);
    if (String(url) === `${issuer}/register`) return registration(JSON.parse(options.body));
    return Response.json(token);
  };
  const done = login({ fetchImpl, openCallback: async (state) => ({ redirectUri: 'http://127.0.0.1:12345/callback', wait: async () => ({ state, code: 'synthetic-code' }), close() {} }), showUrl: () => {}, store: { save: async (s) => { saved = s; } }, now });
  return done.then(() => ({ calls, saved, registrations: calls.filter((call) => call.url === `${issuer}/register`).map((call) => JSON.parse(call.options.body).grant_types) }));
}

test('a sign-in asks Krea for renewal when Krea offers it, and keeps what a renewal needs', async () => {
  const { saved, registrations } = await signIn();
  assert.deepEqual(registrations, [['authorization_code', 'refresh_token']]);
  assert.deepEqual(saved, { accessToken: 'synthetic-access', expiresAt: NOW + 3600000, resource, clientId: 'synthetic-client', tokenEndpoint: `${issuer}/token`, refreshToken: 'synthetic-refresh' });
});

test('a sign-in still works where renewal is not offered, refused at registration, or not granted', async () => {
  const notOffered = await signIn({ grants: null, token: { access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600 } });
  assert.deepEqual(notOffered.registrations, [['authorization_code']]);
  assert.equal(notOffered.saved.refreshToken, undefined);

  // Krea turns down a registration that asks for renewal: asked again without it.
  const refused = await signIn({ registration: (body) => (body.grant_types.includes('refresh_token') ? Response.json({ error: 'invalid_client_metadata' }, { status: 400 }) : Response.json({ client_id: 'synthetic-client', token_endpoint_auth_method: 'none', redirect_uris: ['http://127.0.0.1:12345/callback'] })), token: { access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600 } });
  assert.deepEqual(refused.registrations, [['authorization_code', 'refresh_token'], ['authorization_code']]);
  assert.equal(refused.saved.accessToken, 'synthetic-access');

  const notGranted = await signIn({ token: { access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600 } });
  assert.equal(notGranted.saved.refreshToken, undefined);
  assert.deepEqual(await status({ load: async () => notGranted.saved }, now), { signedIn: true, expiresAt: NOW + 3600000, canRenew: false });
});

// ------------------------------- renewal -------------------------------

test('a sign-in whose hour has ended is renewed with one request, and the new one is stored before the token is used', async () => {
  const s = store();
  const krea = endpoint(granted);
  assert.equal(await access(s, now, krea), 'synthetic-new-access');
  assert.equal(krea.calls.length, 1);
  assert.equal(krea.calls[0].url, `${issuer}/token`);
  assert.deepEqual(krea.calls[0].sent, { grant_type: 'refresh_token', refresh_token: 'synthetic-old-refresh', client_id: 'synthetic-client', resource });
  assert.equal(krea.calls[0].options.redirect, 'error');
  assert.deepEqual(s.value, { ...ended, accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh', expiresAt: NOW + 3600000 });

  // The next call uses what was stored and asks nobody.
  assert.equal(await access(s, now, krea), 'synthetic-new-access');
  assert.equal(krea.calls.length, 1);
});

test('a renewal token that Krea does not replace is kept', async () => {
  const s = store();
  await access(s, now, endpoint(() => granted({ refresh_token: undefined })));
  assert.equal(s.value.refreshToken, 'synthetic-old-refresh');
  assert.equal(s.value.accessToken, 'synthetic-new-access');
});

test('two calls at the same moment make one renewal between them', async () => {
  const s = store();
  const krea = endpoint(async () => { await new Promise((resolve) => setImmediate(resolve)); return granted(); });
  assert.deepEqual(await Promise.all([access(s, now, krea), access(s, now, krea)]), ['synthetic-new-access', 'synthetic-new-access']);
  assert.equal(krea.calls.length, 1);
});

test('it renews with two minutes left and not before; a sign-in without a renewal token keeps its thirty seconds', async () => {
  const krea = endpoint(granted);
  assert.equal(await access(store({ ...ended, expiresAt: NOW + 120001 }), now, krea), 'synthetic-old-access');
  assert.equal(krea.calls.length, 0);
  assert.equal(await access(store({ ...ended, expiresAt: NOW + 120000 }), now, krea), 'synthetic-new-access');
  assert.equal(krea.calls.length, 1);

  const plain = { resource, accessToken: 'synthetic-plain', expiresAt: NOW + 30001 };
  assert.equal(await access(store(plain), now, krea), 'synthetic-plain');
  await assert.rejects(access(store({ ...plain, expiresAt: NOW + 30000 }), now, krea), /^Error: KREA_LOGIN_REQUIRED$/);
  assert.equal(krea.calls.length, 1, 'a sign-in without a renewal token asks nobody');
});

const TRANSIENT = [
  ['no answer', () => { throw new Error('network'); }],
  ['408', () => Response.json({ error: 'timeout' }, { status: 408 })],
  ['425', () => Response.json({ error: 'early' }, { status: 425 })],
  ['429', () => Response.json({ error: 'limited' }, { status: 429 })],
  ['500', () => Response.json({ error: 'server' }, { status: 500 })],
  ['503', () => new Response('unavailable', { status: 503 })],
  ['not JSON', () => new Response('<html>', { status: 200 })],
  ['no access token', () => Response.json({ token_type: 'Bearer', expires_in: 3600 })],
  ['not a bearer token', () => granted({ token_type: 'Basic' })],
  ['a token that ends at once', () => granted({ expires_in: 30 })],
  ['for another resource', () => granted({ resource: 'https://api.krea.ai/other' })],
  ['a renewal token that cannot be one', () => granted({ refresh_token: 'bad\nvalue' })]
];

test('a renewal that cannot be done just now changes nothing, and the next call tries again with the same renewal token', async () => {
  for (const [name, answer] of TRANSIENT) {
    const s = store();
    const krea = endpoint(answer, granted);
    await assert.rejects(access(s, now, krea), /^Error: KREA_REFUSED$/, name);
    assert.deepEqual(s.value, ended, `${name}: the stored sign-in is as it was`);
    assert.equal(await access(s, now, krea), 'synthetic-new-access', name);
    assert.deepEqual(krea.calls.map((call) => call.sent.refresh_token), ['synthetic-old-refresh', 'synthetic-old-refresh'], name);
  }
});

test('a renewal token that Krea refuses is dropped, a new sign-in is asked for, and Krea is not asked again', async () => {
  for (const [name, answer] of [['400 invalid_grant', () => Response.json({ error: 'invalid_grant' }, { status: 400 })], ['401', () => new Response('', { status: 401 })], ['403', () => Response.json({ error: 'forbidden' }, { status: 403 })], ['an error in a 200 answer', () => Response.json({ error: 'invalid_grant' })]]) {
    const s = store();
    const krea = endpoint(answer);
    await assert.rejects(access(s, now, krea), /^Error: KREA_LOGIN_REQUIRED$/, name);
    const { refreshToken, ...rest } = ended;
    assert.deepEqual(s.value, rest, `${name}: only the renewal token is dropped`);
    await assert.rejects(access(s, now, krea), /^Error: KREA_LOGIN_REQUIRED$/, name);
    assert.equal(krea.calls.length, 1, name);
    assert.deepEqual(await status(s, now, krea), { signedIn: false, canRenew: false }, name);
  }
});

test('while the old token is still good, a failed renewal does not stand in the way of the call', async () => {
  const soon = { ...ended, expiresAt: NOW + 60000 };
  const later = store(soon);
  assert.equal(await access(later, now, endpoint(() => { throw new Error('network'); })), 'synthetic-old-access');
  assert.deepEqual(later.value, soon);

  const refused = store(soon);
  assert.equal(await access(refused, now, endpoint(() => Response.json({ error: 'invalid_grant' }, { status: 400 }))), 'synthetic-old-access');
  assert.equal(refused.value.refreshToken, undefined);

  // A lock that cannot be had in time is no reason to refuse a call with a good token either.
  const busy = store(soon);
  busy.transaction = async () => { throw Object.assign(new Error('busy'), { code: 'DSHPROXY_BUSY' }); };
  assert.equal(await access(busy, now, endpoint(granted)), 'synthetic-old-access');
  const busyEnded = store();
  busyEnded.transaction = busy.transaction;
  await assert.rejects(access(busyEnded, now, endpoint(granted)), /^Error: KREA_REFUSED$/);
});

test('a renewed sign-in that could not be stored at first is stored on the second try; if never, the call still has its token', async () => {
  const once = store(ended, { failSaves: 1 });
  assert.equal(await access(once, now, endpoint(granted)), 'synthetic-new-access');
  assert.equal(once.value.refreshToken, 'synthetic-new-refresh');
  assert.equal(once.saves, 2);

  const never = store(ended, { failSaves: 99 });
  assert.equal(await access(never, now, endpoint(granted)), 'synthetic-new-access');
  assert.deepEqual(never.value, ended);
});

test('a renewal token is sent only to one of Krea\'s own https addresses', async () => {
  for (const tokenEndpoint of ['https://evil.example/token', 'http://api.krea.ai/token', 'https://api.krea.ai.evil.example/token', 'https://user:pw@api.krea.ai/token', 'https://api.krea.ai/token?x=1', '', null]) {
    const s = store({ ...ended, tokenEndpoint });
    const krea = endpoint(granted);
    await assert.rejects(access(s, now, krea), /^Error: KREA_LOGIN_REQUIRED$/, String(tokenEndpoint));
    assert.equal(krea.calls.length, 0, String(tokenEndpoint));
  }
});

test('no credential is in anything a failed renewal throws', async () => {
  for (const [, answer] of TRANSIENT) {
    const error = await access(store(), now, endpoint(answer)).then(() => null, (e) => e);
    assert.equal(String(error), 'Error: KREA_REFUSED');
    assert.ok(!JSON.stringify({ ...error, stack: error.stack }).includes('synthetic-'));
  }
});

// ------------------------------- status -------------------------------

test('status renews a sign-in that is about to end, so that "signed in" means the next call works', async () => {
  // Plenty of time: nobody is asked and nothing is stored.
  const fresh = store({ ...ended, expiresAt: NOW + 3000000 });
  const idle = endpoint(granted);
  assert.deepEqual(await status(fresh, now, idle), { signedIn: true, expiresAt: NOW + 3000000, canRenew: true });
  assert.deepEqual([idle.calls.length, fresh.saves], [0, 0]);

  const s = store();
  const krea = endpoint(granted);
  const state = await status(s, now, krea);
  assert.deepEqual(state, { signedIn: true, expiresAt: NOW + 3600000, canRenew: true });
  assert.equal(JSON.stringify(state), `{"signedIn":true,"expiresAt":${NOW + 3600000},"canRenew":true}`);
  assert.equal(krea.calls.length, 1);
  assert.equal(s.value.accessToken, 'synthetic-new-access');

  // Krea cannot be reached and the hour is over: not signed in now, but it can still renew.
  assert.deepEqual(await status(store(), now, endpoint(() => { throw new Error('network'); })), { signedIn: false, canRenew: true });
  assert.deepEqual(await status(store(null), now, endpoint(granted)), { signedIn: false, canRenew: false });
});
