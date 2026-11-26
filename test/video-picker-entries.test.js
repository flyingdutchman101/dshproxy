'use strict';
// The entries the picker offers and their ids. Everything here is offline: a
// throwaway data folder, the real catalog and the real entry switches.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A call that names no data folder uses the default one. For this file that is
// a throwaway folder which must still be empty at the end.
const guard = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-picker-entries-guard-'));
process.env.DSHPROXY_HOME = guard;
test.after(() => {
  try { assert.deepEqual(fs.readdirSync(guard), []); }
  finally { fs.rmSync(guard, { recursive: true, force: true }); }
});

const catalog = require('../src/video/catalog');
const settings = require('../src/video/settings');
const entries = require('../src/video/picker/entries');

const ID = /^[a-z0-9][a-z0-9./-]{2,79}$/;
const UNITS = ['krea_units', 'usd_micros', 'callirra_credits'];

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-picker-entries-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

async function switchAllOn(home) {
  for (const { model, resolution, route } of catalog.entries()) await settings.setEntry(home, { model, resolution, route }, true);
}

test('an id is the model, the slug of the resolution and the route', () => {
  assert.equal(entries.idOf({ model: 'seedance-2.5', resolution: '720p', route: 'krea' }), 'seedance-2.5/720p/krea');
  assert.equal(entries.idOf({ model: 'wan-3.0', resolution: '1080p', route: 'videorouter-replicate' }), 'wan-3.0/1080p/videorouter-replicate');
  // A fixed tier stands where the resolution would be, lower-cased.
  assert.equal(entries.idOf({ model: 'minimax-h3', resolution: '2K', route: 'krea' }), 'minimax-h3/2k/krea');
  // Every run of anything outside a-z, 0-9 and the dot becomes one hyphen.
  assert.equal(entries.idOf({ model: 'm', resolution: 'Ultra  HD_4.5 (beta)', route: 'r' }), 'm/ultra-hd-4.5-beta-/r');
});

test('with every catalog entry switched on, each submit-capable text entry has its own well-formed id', async (t) => {
  const home = tempHome(t);
  await switchAllOn(home);
  const all = catalog.entries().filter((entry) => entry.route !== 'elevenlabs');
  assert.equal(all.length, 41);
  assert.equal((await settings.entriesOn(home)).length, 61, 'all entries remain enabled in settings');
  const offered = await entries.offered(home);
  assert.ok(offered instanceof Map);
  for (const entry of catalog.entries().filter((entry) => entry.route === 'elevenlabs')) {
    assert.equal(offered.has(entries.idOf(entry)), false, 'unpriced ElevenLabs entries cannot be offered for spending');
  }
  assert.equal(offered.size, all.length, 'no entry was left out, so no two share an id and every id is well formed');
  assert.deepEqual([...offered.keys()], all.map((entry) => entries.idOf(entry)), 'catalog order');
  assert.equal(new Set(offered.keys()).size, all.length);
  for (const [id, entry] of offered) {
    assert.match(id, ID);
    assert.equal(entry.id, id);
    assert.equal(id, `${entry.model}/${entry.resolution.toLowerCase()}/${entry.route}`);
    const listed = catalog.entry(entry.model, entry.resolution, entry.route);
    assert.equal(entry.label, listed.label);
    assert.ok(UNITS.includes(entry.unit), `${id} has unit ${entry.unit}`);
    assert.equal(entry.unit, entry.route === 'krea' ? 'krea_units' : entry.route === 'callirra' ? 'callirra_credits' : 'usd_micros');
    assert.equal(entry.fixedTier, listed.fixedTier);
    assert.equal(Object.hasOwn(entry, 'on'), false);
  }
  // All routes are offered, not only Krea.
  assert.deepEqual([...new Set([...offered.values()].map((entry) => entry.route))].sort(), ['callirra', 'kovapi', 'krea', 'videorouter', 'videorouter-replicate']);
});

test('only the entries that are switched on are offered, and switching one off takes it away at once', async (t) => {
  const home = tempHome(t);
  assert.equal((await entries.offered(home)).size, 0);
  assert.deepEqual(await entries.models(home), []);
  await settings.setEntry(home, { model: 'seedance-2.5', resolution: '720p', route: 'krea' }, true);
  await settings.setEntry(home, { model: 'minimax-h3', resolution: '768p', route: 'callirra' }, true);
  await settings.setEntry(home, { model: 'wan-3.0', resolution: '480p', route: 'kovapi' }, true);
  const offered = await entries.offered(home);
  assert.deepEqual([...offered.keys()], ['seedance-2.5/720p/krea', 'minimax-h3/768p/callirra', 'wan-3.0/480p/kovapi']);
  assert.deepEqual(
    [...offered.values()].map(({ id, model, resolution, route, label, unit }) => ({ id, model, resolution, route, label, unit })),
    [
      { id: 'seedance-2.5/720p/krea', model: 'seedance-2.5', resolution: '720p', route: 'krea', label: 'Seedance 2.5 - 720p - Krea', unit: 'krea_units' },
      { id: 'minimax-h3/768p/callirra', model: 'minimax-h3', resolution: '768p', route: 'callirra', label: 'MiniMax H3 - 768p - Callirra', unit: 'callirra_credits' },
      { id: 'wan-3.0/480p/kovapi', model: 'wan-3.0', resolution: '480p', route: 'kovapi', label: 'Wan 3.0 - 480p - KovAPI', unit: 'usd_micros' },
    ],
  );
  await settings.setEntry(home, { model: 'seedance-2.5', resolution: '720p', route: 'krea' }, false);
  assert.deepEqual([...(await entries.offered(home)).keys()], ['minimax-h3/768p/callirra', 'wan-3.0/480p/kovapi']);
});

test('the profile writer gets one model per offered entry, in the shape it writes', async (t) => {
  const home = tempHome(t);
  await settings.setEntry(home, { model: 'seedance-2.5', resolution: '720p', route: 'krea' }, true);
  await settings.setEntry(home, { model: 'minimax-h3', resolution: '2K', route: 'krea' }, true);
  assert.deepEqual(await entries.models(home), [
    { id: 'seedance-2.5/720p/krea', name: 'Seedance 2.5 - 720p - Krea', api: 'video', input: ['text'], contextWindow: 1000000, maxTokens: 4096, efforts: [] },
    { id: 'minimax-h3/2k/krea', name: 'MiniMax H3 - 2K - Krea', api: 'video', input: ['text'], contextWindow: 1000000, maxTokens: 4096, efforts: [] },
  ]);
  await switchAllOn(home);
  const models = await entries.models(home);
  const offered = await entries.offered(home);
  assert.deepEqual(models.map((model) => model.id), [...offered.keys()]);
  for (const model of models) assert.equal(model.name, offered.get(model.id).label);
});

test('two entries with one id are both left out, and so is an entry whose id is not well formed', () => {
  const entry = (model, resolution, route) => ({ model, resolution, route, label: `${model} ${resolution} ${route}`, unit: 'USD', priceBasis: 'published', fixedTier: false });
  const map = entries.byId([
    entry('alpha', '720p', 'kovapi'),
    entry('beta', '720p', 'kovapi'),
    // The same id as the first after the slug.
    entry('alpha', '720P', 'kovapi'),
    entry('gamma', '1080p', 'krea'),
    // Not ids: an upper-case model, a route with a space, a name that is not text.
    entry('Delta', '720p', 'kovapi'),
    entry('epsilon', '720p', 'kov api'),
    entry(undefined, '720p', 'kovapi'),
    // A third one with the id that was already dropped stays out too.
    entry('alpha', '720p', 'kovapi'),
  ]);
  assert.deepEqual([...map.keys()], ['beta/720p/kovapi', 'gamma/1080p/krea']);
  assert.equal(map.get('gamma/1080p/krea').unit, 'krea_units');
});

test('what is offered is a fresh copy each time', async (t) => {
  const home = tempHome(t);
  await settings.setEntry(home, { model: 'flux-3', resolution: '720p', route: 'krea' }, true);
  const first = await entries.offered(home);
  first.get('flux-3/720p/krea').label = 'changed';
  first.clear();
  const second = await entries.offered(home);
  assert.equal(second.get('flux-3/720p/krea').label, 'Flux 3 - 720p - Krea');
});
