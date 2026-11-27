'use strict';
// Which video models the user switched on, and the one route each is billed
// through. Kept in its own file in the data folder: saving the chat settings
// rewrites settings.json from a fixed list of keys, so anything stored there
// would be lost on the next chat change. This module never opens that file.
//
// Beside them, the entries the user switched on: one model at one resolution
// on one route, such as "Seedance 2.5 - 720p - Krea". An entry is its own
// switch; the per-model settings above keep their meaning.
//
// The file holds catalog model names, true/false, catalog route names and
// catalog resolution names, and nothing else. Whatever is not exactly that is
// refused when written and ignored when read, so no credential can be stored
// here or come back out.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const catalog = require('./catalog');
const { models, quote, routesFor } = catalog;
const { withLock, replaceFile } = require('../filelock');
const { homeDir } = require('../settings');

const FILE_NAME = 'video-settings.json';
// With every entry of the catalog switched on the file is a few kilobytes. One
// far beyond that is not a settings file, and is refused before it is read.
const MAX_BYTES = 64 * 1024;
// Signed-in workspace route: the `video` command takes it for every model, but
// whether an account can run a given model there is not known in advance.
const WORKSPACE_ROUTE = 'krea';

function folder(home) {
  if (home === undefined) return homeDir();
  if (typeof home !== 'string' || !home.trim()) throw new Error('The video settings need the data folder as a path.');
  return home;
}

function file(home) {
  return path.join(folder(home), FILE_NAME);
}

function known(model) {
  return typeof model === 'string' && models.includes(model);
}

function priced(model, route) {
  try {
    return ['published','effective'].includes(quote(model, route).priceBasis);
  } catch {
    return false;
  }
}

// The routes a model can be set to. A catalog route has a dated published
// price ("published-estimate"), which does not show that the route works; the
// workspace route has not even that ("unverified"). Nothing is called verified.
function routes(model) {
  if (!known(model)) throw new Error('Unknown video model');
  return routesFor(model)
    .map((route) => ({ route, compatibility: priced(model, route) ? 'published-estimate' : 'unverified' }));
}

function plain(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// One rule for a change being written and for an entry found in the file:
// only `enabled` (true or false) and `route` (a route of this model, or null).
// Returns a fresh object holding just those. Messages never repeat a refused
// value, which could be a credential pasted into the wrong place.
function entry(model, value) {
  if (!plain(value)) throw new Error(`The video setting for ${model} must be an object with "enabled" and "route".`);
  const clean = {};
  for (const key of Object.keys(value)) {
    const given = value[key];
    if (key === 'enabled') {
      if (typeof given !== 'boolean') throw new Error(`"enabled" for video model ${model} must be true or false.`);
    } else if (key === 'route') {
      if (given !== null && !routes(model).some((option) => option.route === given)) throw new Error(`Unsupported video route for ${model}`);
    } else throw new Error(`The video setting for ${model} takes only "enabled" and "route".`);
    clean[key] = given;
  }
  return clean;
}

function changes(config) {
  if (!plain(config) || !plain(config.models) || Object.keys(config).some((key) => key !== 'models')) {
    throw new Error('A video settings change must be { models: { MODEL: { enabled, route } } }.');
  }
  return Object.keys(config.models).map((model) => {
    if (!known(model)) throw new Error('Unknown video model');
    return [model, entry(model, config.models[model])];
  });
}

function defaults() {
  return { models: Object.fromEntries(models.map((model) => [model, { enabled: false, route: null }])) };
}

// An entry is named by its model, its resolution and its route. For a fixed
// tier the tier's name stands where the resolution would be.
const ENTRY_NAMES = ['model', 'resolution', 'route'];
const entryId = (entry) => JSON.stringify(ENTRY_NAMES.map((name) => entry[name]));
const namesOf = (entry) => Object.fromEntries(ENTRY_NAMES.map((name) => [name, entry[name]]));
// Every entry of the catalog, in catalog order, by its id.
const catalogIds = () => catalog.entries().map((entry) => [entryId(entry), entry]);

// One rule for a switch being written and for an entry found in the file:
// exactly the three names, of a combination the catalog lists. Returns the
// entry's id. Messages never repeat a refused value.
function named(value) {
  if (!plain(value) || Object.keys(value).length !== ENTRY_NAMES.length || !ENTRY_NAMES.every((name) => Object.hasOwn(value, name))) {
    throw new Error('A video entry is named by exactly { model, resolution, route }.');
  }
  return entryId(catalog.entry(value.model, value.resolution, value.route));
}

// A missing file means nothing is enabled. A file that is there but cannot be
// read or is not a JSON object is an error, for a change as well, so that it
// is never replaced unseen. Inside a readable file, an entry that is not
// exactly valid counts as disabled with no route.
//
// Entries: a file from before entries existed has none, so every entry is off.
// A saved entry that is not exactly an entry of today's catalog (a combination
// that no longer exists, or anything else) is passed over; the next write
// leaves it out.
//
// Returns { models, on }, where `on` is the set of ids of the entries that are
// switched on.
function loadAll(home) {
  const target = file(home);
  const state = { ...defaults(), on: new Set(), off: new Set() };
  let text;
  let size;
  try {
    const handle = fs.openSync(target, 'r');
    try {
      size = fs.fstatSync(handle).size;
      if (size <= MAX_BYTES) text = fs.readFileSync(handle, 'utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return state;
    throw new Error(`${target} cannot be read (${error.code || 'unknown error'}).`);
  }
  if (text === undefined) throw new Error(`${target} is larger than 64 KB, which no video settings file is. Fix it, or move it away to start with every video model disabled.`);
  let saved;
  try {
    saved = JSON.parse(text);
  } catch {
    throw new Error(`${target} is not valid JSON. Fix it, or move it away to start with every video model disabled.`);
  }
  if (!plain(saved)) throw new Error(`${target} does not hold a settings object. Fix it, or move it away to start with every video model disabled.`);
  for (const model of plain(saved.models) ? models : []) {
    if (!Object.hasOwn(saved.models, model)) continue;
    try {
      Object.assign(state.models[model], entry(model, saved.models[model]));
    } catch {
      // not a valid entry: stays disabled with no route
    }
  }
  for (const item of Array.isArray(saved.entries) ? saved.entries : []) {
    try {
      state.on.add(named(item));
    } catch {
      // not an entry of the catalog: off, and gone after the next write
    }
  }
  for (const item of Array.isArray(saved.pickerExclusions) ? saved.pickerExclusions : []) {
    try { state.off.add(named(item)); } catch { /* obsolete preset */ }
  }
  return state;
}

function load(home) {
  return { models: loadAll(home).models };
}

// What is written: today's settings as they always were, and the entries that
// are on, in catalog order, each by its three names. With no entry on, the
// file is the one a DSHProxy from before entries wrote.
function serialised(state) {
  const on = catalogIds().filter(([id]) => state.on.has(id)).map(([, item]) => namesOf(item));
  const off = catalogIds().filter(([id]) => state.off.has(id)).map(([, item]) => namesOf(item));
  return `${JSON.stringify({ models: state.models, ...(on.length ? { entries: on } : {}), ...(off.length ? { pickerExclusions: off } : {}) }, null, 2)}\n`;
}

// Reads the file, applies `change` to what it holds and puts the result in
// place, all under the file's lock. Several commands can change the settings
// at the same moment: without the lock two of them start from the same saved
// state and the later write drops the earlier change. The new state is
// returned only once the file, read back, holds it. `io` is for tests (see
// src/filelock.js).
function update(dir, change, io) {
  const target = file(dir);
  return withLock(target, async () => {
    const state = loadAll(dir);
    change(state);
    // Put in place as a whole, so a reader never sees a half-written file.
    await replaceFile(target, serialised(state), io);
    const saved = loadAll(dir);
    if (!isDeepStrictEqual(saved, state)) throw new Error(`The change to ${target} could not be confirmed: reading the file back did not show it. Run the command again.`);
    return saved;
  }, io);
}

const listed = (state) => catalogIds().map(([id, item]) => ({ ...item, on: state.on.has(id) }));

// Every catalog model, in catalog order: { models: { MODEL: { enabled, route } } }.
// An enabled model whose route is null is not usable yet; see offered().
async function read(home) {
  return load(home);
}

// Applies { models: { MODEL: { enabled?, route? } } } and returns the new
// state. Only the named fields change. One invalid part refuses the whole
// change and nothing is written. The entries that are switched on are kept as
// they are. `io` is for tests (see update()).
async function write(home, config, { io = {} } = {}) {
  const dir = folder(home);
  const wanted = changes(config);
  const saved = await update(dir, (state) => {
    for (const [model, change] of wanted) Object.assign(state.models[model], change);
  }, io);
  return { models: saved.models };
}

// Every entry of the catalog, in catalog order, as catalog.entries() gives it
// and with `on`: true where the user switched it on. All are off until then.
async function entries(home) {
  return listed(loadAll(home));
}

// The entries that are switched on: what may be listed for picking, each with
// its `label` ("Seedance 2.5 - 720p - Krea"), in catalog order.
async function entriesOn(home) {
  return entriesOnNow(home);
}

// The same, answered at once: the file is read synchronously. For a caller
// that must decide inside one step, such as the gateway answering a request.
function entriesOnNow(home) {
  return listed(loadAll(home)).filter((item) => item.on);
}

// Switches one entry, named { model, resolution, route }, on (true) or off
// (false), and returns every entry as entries() does. Only a combination the
// catalog lists can be switched; anything else is refused and nothing is
// written. The per-model settings are not touched.
async function setEntry(home, name, on, { io = {} } = {}) {
  const dir = folder(home);
  const id = named(name);
  if (typeof on !== 'boolean') throw new Error('A video entry is switched with true or false.');
  return listed(await update(dir, (state) => {
    if (on) {
      state.off.delete(id);
      state.on.add(id);
    } else {
      state.on.delete(id);
      const model = state.models[name.model];
      if (model.enabled && model.route === name.route) state.off.add(id);
    }
  }, io));
}

// What may be offered for generation: models that are enabled and have a
// route chosen by the user. No route is ever filled in from a default.
async function offered(home) {
  const state = load(home);
  return models
    .filter((model) => state.models[model].enabled && state.models[model].route !== null)
    .map((model) => ({ model, route: state.models[model].route }));
}

// Explicit preset choices remain independent of the model switch. In addition,
// a model enabled on a chosen billing route offers that route's presets unless
// the user explicitly excluded one. Always decide from one settings snapshot.
function pickerEntriesNow(home) {
  const state = loadAll(home);
  return catalogIds().filter(([id, item]) => {
    const model = state.models[item.model];
    return !state.off.has(id) && (state.on.has(id) || (model.enabled && model.route === item.route));
  }).map(([, item]) => item);
}

module.exports = { read, write, offered, routes, file, entries, entriesOn, entriesOnNow, setEntry, pickerEntriesNow };
