'use strict';
// The video entries a chat application is offered in its model picker, and
// the id of each. An entry is one model at one resolution on one route, such
// as "Seedance 2.5 - 720p - Krea"; it is offered when the user switched it on
// (`dshproxy video entries set ... on`).
//
// The profile writer and the gateway both ask this one module, so the list the
// application shows and the list the gateway answers cannot differ. An id is
// looked up in the map; it is never taken apart again.
const settings = require('../settings');

const WORKSPACE_ROUTE = 'krea';
const ID = /^[a-z0-9][a-z0-9./-]{2,79}$/;

// Lower case, and every run of anything but a-z, 0-9 and the dot as one hyphen.
function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9.]+/g, '-');
}

// "seedance-2.5/720p/krea". For a fixed tier the tier's name stands where the
// resolution would be: "minimax-h3/2k/krea".
function idOf(entry) {
  return `${entry.model}/${slug(entry.resolution)}/${entry.route}`;
}

// What a quoted amount of this entry is counted in: Krea compute units, US
// dollar micros, or Callirra plan credits.
function unitOf(entry) {
  if (entry.route === WORKSPACE_ROUTE) return 'krea_units';
  return entry.priceBasis === 'effective' ? 'callirra_credits' : 'usd_micros';
}

// A Map from id to entry, in the order given. Each value is a fresh object:
// the catalog's entry (model, resolution, route, label, modelId, fixedTier,
// verifiedOn, and usdMicros or credits where the route has a published price)
// with `id` and with `unit` as unitOf() names it.
//
// Two entries with one id are both left out, and so is an entry whose id is
// not well formed: an id that could mean two things, or that a profile could
// not carry, is never offered.
function byId(list) {
  const found = new Map();
  const dropped = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry === null || typeof entry !== 'object') continue;
    if (![entry.model, entry.resolution, entry.route].every((name) => typeof name === 'string' && name)) continue;
    const id = idOf(entry);
    if (!ID.test(id) || dropped.has(id)) continue;
    if (found.has(id)) {
      found.delete(id);
      dropped.add(id);
      continue;
    }
    const { on, ...rest } = entry;
    found.set(id, { ...rest, id, unit: unitOf(entry) });
  }
  return found;
}

// The entries that are switched on in the data folder `home`, by id. Read from
// the settings file at every call, so an entry switched off stops being
// offered at once. Resolves to a Map (see byId); the read itself is
// asynchronous because the settings module's is.
async function offered(home) {
  return offeredNow(home);
}

// The same, answered at once (the settings file is read synchronously).
function offeredNow(home) {
  return byId(settings.entriesOnNow(home));
}

// The same entries as the models of a route in a DeepSeek Harness profile.
// The window is large and the output small so that the application neither
// compacts the conversation nor expects long answers.
async function models(home) {
  return [...(await offered(home)).values()].map((entry) => ({
    id: entry.id,
    name: entry.label,
    api: 'video',
    input: ['text'],
    contextWindow: 1000000,
    maxTokens: 4096,
    efforts: [],
  }));
}

module.exports = { idOf, slug, unitOf, byId, offered, offeredNow, models };
