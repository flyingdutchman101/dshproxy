'use strict';
// Which video models the user switched on, and the one route each is billed
// through. Kept in its own file in the data folder: saving the chat settings
// rewrites settings.json from a fixed list of keys, so anything stored there
// would be lost on the next chat change. This module never opens that file.
//
// The file holds catalog model names, true/false and catalog route names, and
// nothing else. Whatever is not exactly that is refused when written and
// ignored when read, so no credential can be stored here or come back out.
const fs = require('node:fs');
const path = require('node:path');
const { models, quote, routesFor } = require('./catalog');
const { homeDir } = require('../settings');

const FILE_NAME = 'video-settings.json';
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
    return quote(model, route).route === route;
  } catch {
    return false;
  }
}

// The routes a model can be set to. A catalog route has a dated published
// price ("published-estimate"), which does not show that the route works; the
// workspace route has not even that ("unverified"). Nothing is called verified.
function routes(model) {
  if (!known(model)) throw new Error('Unknown video model');
  return [...new Set([...routesFor(model), WORKSPACE_ROUTE])]
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

// A missing file means nothing is enabled. A file that is there but cannot be
// read or is not a JSON object is an error, for a change as well, so that it
// is never replaced unseen. Inside a readable file, an entry that is not
// exactly valid counts as disabled with no route.
function load(home) {
  const target = file(home);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return defaults();
    throw new Error(`${target} cannot be read (${error.code || 'unknown error'}).`);
  }
  let saved;
  try {
    saved = JSON.parse(text);
  } catch {
    throw new Error(`${target} is not valid JSON. Fix it, or move it away to start with every video model disabled.`);
  }
  if (!plain(saved)) throw new Error(`${target} does not hold a settings object. Fix it, or move it away to start with every video model disabled.`);
  const state = defaults();
  if (!plain(saved.models)) return state;
  for (const model of models) {
    if (!Object.hasOwn(saved.models, model)) continue;
    try {
      Object.assign(state.models[model], entry(model, saved.models[model]));
    } catch {
      // not a valid entry: stays disabled with no route
    }
  }
  return state;
}

// Written to a temporary file first, so an interrupted save cannot leave a
// half-written file.
function save(home, state) {
  const target = file(home);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(folder(home), { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

// Every catalog model, in catalog order: { models: { MODEL: { enabled, route } } }.
// An enabled model whose route is null is not usable yet; see offered().
async function read(home) {
  return load(home);
}

// Applies { models: { MODEL: { enabled?, route? } } } and returns the new
// state. Only the named fields change. One invalid part refuses the whole
// change and nothing is written.
//
// No step here waits, so two changes started together in one process cannot
// both start from the same saved state and lose one of them.
async function write(home, config) {
  const dir = folder(home);
  const wanted = changes(config);
  const state = load(dir);
  for (const [model, change] of wanted) Object.assign(state.models[model], change);
  save(dir, state);
  return state;
}

// What may be offered for generation: models that are enabled and have a
// route chosen by the user. No route is ever filled in from a default.
async function offered(home) {
  const state = load(home);
  return models
    .filter((model) => state.models[model].enabled && state.models[model].route !== null)
    .map((model) => ({ model, route: state.models[model].route }));
}

module.exports = { read, write, offered, routes, file };
