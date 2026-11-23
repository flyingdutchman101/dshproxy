'use strict';
// The second line of defence of the video picker, in
// <home>/video-picker/settings.json:
//
//   { "purchases": false,
//     "ceiling": { "clips": 10, "krea_units": 15000, "usd_micros": 20000000, "callirra_credits": 2000 } }
//
// `purchases` says whether a confirmation in chat may buy at all; while it is
// false a confirmation runs a rehearsal. `ceiling` limits what is bought in
// any 24 hours: the number of clips over all routes, and the quoted amounts
// per unit. It is changed with `dshproxy video picker`, never from chat.
//
// A missing file is these defaults. A file that is there but is not exactly
// such an object means purchases are off and the defaults apply, and it is
// never replaced unseen: a change is refused until the file is fixed or moved
// away. A lost update here cannot spend anything, so the file is written
// under the ordinary lock of src/filelock.js.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { withLock, replaceFile } = require('../../filelock');

const FOLDER = 'video-picker';
const FILE_NAME = 'settings.json';
// The limits, in the order they are shown, with the largest value each takes.
const BOUNDS = { clips: 1000, krea_units: 1e12, usd_micros: 1e12, callirra_credits: 1e12 };
const LIMITS = Object.keys(BOUNDS);

function defaults() {
  return { purchases: false, ceiling: { clips: 10, krea_units: 15000, usd_micros: 20000000, callirra_credits: 2000 } };
}

function file(home) {
  if (typeof home !== 'string' || !home.trim()) throw new Error('The video picker settings need the data folder as a path.');
  return path.join(home, FOLDER, FILE_NAME);
}

function plain(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function limit(name, value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= BOUNDS[name];
}

// The settings a file holds, or null when it is not exactly a settings object.
function settingsOf(value) {
  if (!plain(value) || !isDeepStrictEqual(Object.keys(value).sort(), ['ceiling', 'purchases'])) return null;
  if (typeof value.purchases !== 'boolean' || !plain(value.ceiling)) return null;
  if (!isDeepStrictEqual(Object.keys(value.ceiling).sort(), [...LIMITS].sort())) return null;
  const ceiling = {};
  for (const name of LIMITS) {
    if (!limit(name, value.ceiling[name])) return null;
    ceiling[name] = value.ceiling[name];
  }
  return { purchases: value.purchases, ceiling };
}

// { purchases, ceiling, problem }. `problem` is null, or says why the file
// was not used: 'unreadable' or 'invalid'. With a problem, purchases are off
// and the default ceilings apply. Never throws for what the file holds.
function read(home) {
  const target = file(home);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    return { ...defaults(), problem: error.code === 'ENOENT' ? null : 'unreadable' };
  }
  let saved = null;
  try {
    saved = settingsOf(JSON.parse(text));
  } catch {
    saved = null;
  }
  return saved === null ? { ...defaults(), problem: 'invalid' } : { ...saved, problem: null };
}

// What a change may hold: `purchases` (true or false) and `ceiling` with any
// of the four limits as whole numbers within their bounds.
function changeOf(change) {
  if (!plain(change) || Object.keys(change).length === 0 || Object.keys(change).some((key) => key !== 'purchases' && key !== 'ceiling')) {
    throw new Error('A change to the video picker settings must be { purchases } or { ceiling: { NAME: N } }.');
  }
  const clean = { ceiling: {} };
  if (Object.hasOwn(change, 'purchases')) {
    if (typeof change.purchases !== 'boolean') throw new Error('"purchases" must be true or false.');
    clean.purchases = change.purchases;
  }
  if (Object.hasOwn(change, 'ceiling')) {
    if (!plain(change.ceiling)) throw new Error('"ceiling" must be an object of limits.');
    for (const name of Object.keys(change.ceiling)) {
      if (!LIMITS.includes(name)) throw new Error(`The ceiling has no limit of that name. The limits are ${LIMITS.join(', ')}.`);
      if (!limit(name, change.ceiling[name])) throw new Error(`The limit ${name} must be a whole number from 0 to ${BOUNDS[name]}.`);
      clean.ceiling[name] = change.ceiling[name];
    }
  }
  return clean;
}

// Applies a change and returns the new settings. Only the named fields
// change. An invalid change, or a file that is there and is not valid, is
// refused and nothing is written. The new state is returned only once the
// file, read back, holds it. `io` is for tests (see src/filelock.js).
async function write(home, change, { io = {} } = {}) {
  const target = file(home);
  const wanted = changeOf(change);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return withLock(target, async () => {
    const current = read(home);
    if (current.problem !== null) {
      throw new Error(`${target} ${current.problem === 'invalid' ? 'does not hold valid video picker settings' : 'cannot be read'}. Fix it, or move it away to start again with purchases off and the default ceiling. Nothing was changed.`);
    }
    const next = {
      purchases: Object.hasOwn(wanted, 'purchases') ? wanted.purchases : current.purchases,
      ceiling: { ...current.ceiling, ...wanted.ceiling }
    };
    // Put in place as a whole, so a reader never sees a half-written file.
    await replaceFile(target, `${JSON.stringify(next, null, 2)}\n`, io);
    const saved = read(home);
    if (saved.problem !== null || !isDeepStrictEqual({ purchases: saved.purchases, ceiling: saved.ceiling }, next)) {
      throw new Error(`The change to ${target} could not be confirmed: reading the file back did not show it. Run the command again.`);
    }
    return saved;
  }, io);
}

module.exports = { read, write, file, defaults, LIMITS, BOUNDS };
