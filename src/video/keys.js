'use strict';
// Saved API keys of the pay-per-use video providers. Kept in their own file in
// the data folder (saving the chat settings rewrites settings.json from a
// fixed list of entries), each key encrypted with the DSHProxy master key
// through src/secrets.js: the same protection as the Chat API keys, and the
// same master.key file.
//
// A key in the provider's environment variable wins over a saved one. The
// plain key leaves this module only as the return value of resolve(); it is
// never part of a message, and the file holds nothing but provider names and
// encrypted text.
const fs = require('node:fs');
const path = require('node:path');
const secrets = require('../secrets');
const { withLock, replaceFile } = require('../filelock');
const { homeDir } = require('../settings');

const FILE_NAME = 'video-keys.json';
const MAX_KEY_LENGTH = 512;
const MAX_SAVED_LENGTH = 4096;
const MASTER_KEY_BYTES = 32;

// One provider can serve several billing routes with the same key.
const PROVIDERS = new Map([
  ['videorouter', { label: 'VideoRouter', variable: 'VIDEOROUTER_API_KEY', routes: ['videorouter', 'videorouter-replicate'] }],
  ['kovapi', { label: 'KovAPI', variable: 'KOVAPI_API_KEY', routes: ['kovapi'] }],
  ['callirra', { label: 'Callirra', variable: 'CALLIRRA_API_KEY', routes: ['callirra'] }]
]);
const NAMES = [...PROVIDERS.keys()].join(', ');

function folder(home) {
  if (home === undefined) return homeDir();
  if (typeof home !== 'string' || !home.trim()) throw new Error('The video keys need the data folder as a path.');
  return home;
}

function file(home) {
  return path.join(folder(home), FILE_NAME);
}

// The Chat keys' master key (see masterKeyFile in src/app.js).
function masterKeyFile(dir) {
  return path.join(dir, 'master.key');
}

// Messages name the provider only once it is known to be one of ours: what
// was given instead could be a key typed in the wrong place.
function known(provider) {
  if (typeof provider !== 'string' || !PROVIDERS.has(provider)) throw new Error(`Unknown video key provider. Providers: ${NAMES}.`);
  return provider;
}

function providerOf(route) {
  if (typeof route === 'string') {
    for (const [provider, entry] of PROVIDERS) if (entry.routes.includes(route)) return provider;
  }
  throw new Error('Unsupported video route for a provider key.');
}

function present(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

// A key as providers issue them: printable ASCII with nothing else inside.
function usable(text) {
  return typeof text === 'string' && text.length > 0 && text.length <= MAX_KEY_LENGTH && !/[^\x21-\x7e]/.test(text);
}

function accepted(key) {
  const text = typeof key === 'string' ? key.trim() : '';
  if (!text) throw new Error('No video API key was given. Nothing was saved.');
  if (text.length > MAX_KEY_LENGTH) throw new Error(`A video API key can be at most ${MAX_KEY_LENGTH} characters. Nothing was saved.`);
  if (!usable(text)) throw new Error('A video API key cannot contain spaces, line breaks or anything else outside printable ASCII. Nothing was saved.');
  return text;
}

function plain(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// A missing file means no key is saved. A file that is there but cannot be
// read or is not a JSON object is an error, for a change as well, so that it
// is never replaced unseen. Inside a readable file only an entry that is
// exactly { keyEnc: <encrypted text> } for one of the providers counts; the
// rest is ignored and gone after the next save.
function load(dir) {
  const target = path.join(dir, FILE_NAME);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw new Error(`${target} cannot be read (${error.code || 'unknown error'}).`);
  }
  let saved;
  try {
    saved = JSON.parse(text);
  } catch {
    throw new Error(`${target} is not valid JSON. Fix it, or move it away and enter the video keys again.`);
  }
  if (!plain(saved)) throw new Error(`${target} does not hold saved video keys. Fix it, or move it away and enter the video keys again.`);
  const entries = new Map();
  if (!plain(saved.providers)) return entries;
  for (const provider of PROVIDERS.keys()) {
    const entry = Object.hasOwn(saved.providers, provider) ? saved.providers[provider] : null;
    if (!plain(entry) || Object.keys(entry).length !== 1 || !Object.hasOwn(entry, 'keyEnc')) continue;
    const { keyEnc } = entry;
    if (typeof keyEnc === 'string' && keyEnc.length <= MAX_SAVED_LENGTH && /^[A-Za-z0-9+/]+={0,2}$/.test(keyEnc)) entries.set(provider, keyEnc);
  }
  return entries;
}

// One change to the file: read, change, write, read back. Several commands
// can do this at the same moment, so it runs under the file's lock; otherwise
// two of them start from the same content and the later write drops the
// earlier change. `apply(entries)` makes the change, or returns false when
// there is nothing to change; `shown(entries)` says whether what was read
// back has it: only then does the change count as made.
// `io` is for tests (see src/filelock.js).
function change(dir, apply, shown, io = {}) {
  const target = path.join(dir, FILE_NAME);
  return withLock(target, async () => {
    const entries = load(dir);
    if (apply(entries) === false) return;
    const providers = Object.fromEntries([...entries].map(([provider, keyEnc]) => [provider, { keyEnc }]));
    await replaceFile(target, `${JSON.stringify({ providers }, null, 2)}\n`, io);
    if (!shown(load(dir))) throw new Error(`The change to ${target} could not be confirmed: reading the file back did not show it. Run the command again.`);
  }, io);
}

function isMasterKey(key) {
  return Buffer.isBuffer(key) && key.length === MASTER_KEY_BYTES;
}

// For reading: a master key that is missing or that Windows will not unlock
// gives null, and the saved keys then count as unreadable. Never creates one.
async function unlock(dir, loadMasterKey) {
  try {
    const key = await loadMasterKey(masterKeyFile(dir));
    return isMasterKey(key) ? key : null;
  } catch {
    return null;
  }
}

function reveal(master, keyEnc) {
  const text = master ? secrets.decryptWithKey(master, keyEnc) : null;
  return usable(text) ? text : null;
}

// One row per provider, in a fixed order. `readable` is false when a saved key
// cannot be decrypted; `inEnvironment` when the variable is set and not blank.
// Nothing here is a key or part of one, and no key is checked with a provider.
async function list(home, { env = process.env, loadMasterKey = secrets.loadMasterKey } = {}) {
  const dir = folder(home);
  const entries = load(dir);
  const master = entries.size ? await unlock(dir, loadMasterKey) : null;
  return [...PROVIDERS].map(([provider, { label, variable, routes }]) => ({
    provider,
    label,
    variable,
    routes: [...routes],
    saved: entries.has(provider),
    readable: entries.has(provider) && reveal(master, entries.get(provider)) !== null,
    inEnvironment: present(env[variable])
  }));
}

// Saves or replaces the key of one provider. The key is trimmed; an empty one,
// one longer than 512 characters or one with anything but printable ASCII
// inside is refused before the master key is touched.
//
// The master key is unlocked first, because Windows takes its time over it,
// and the file's lock is held only for the change itself. `saved: true` is
// answered once the file, read back, holds the key.
async function set(home, provider, key, { loadMasterKey = secrets.loadMasterKey, io } = {}) {
  const dir = folder(home);
  known(provider);
  const text = accepted(key);
  load(dir);
  const master = await loadMasterKey(masterKeyFile(dir), { create: true });
  if (!isMasterKey(master)) throw new Error('The master key could not be loaded, so nothing was saved.');
  const keyEnc = secrets.encryptWithKey(master, text);
  await change(dir, (entries) => entries.set(provider, keyEnc), (entries) => entries.get(provider) === keyEnc, io);
  return { provider, saved: true };
}

// A provider with no saved key is answered without waiting for anyone:
// nothing is changed.
async function remove(home, provider, { io } = {}) {
  const dir = folder(home);
  known(provider);
  if (!load(dir).has(provider)) return { provider, saved: false, removed: false };
  let removed = false;
  // False when another command removed it in the meantime.
  await change(dir, (entries) => (removed = entries.delete(provider)), (entries) => !entries.has(provider), io);
  return { provider, saved: false, removed };
}

// The key to send on a billing route: the provider's environment variable when
// it is set and not blank, and then nothing saved is opened; otherwise the
// saved key. Every other outcome is a refusal that the caller must let stop
// the request.
async function resolve(home, route, { env = process.env, loadMasterKey = secrets.loadMasterKey } = {}) {
  const dir = folder(home);
  const provider = providerOf(route);
  const { variable } = PROVIDERS.get(provider);
  if (present(env[variable])) return env[variable];
  const entries = load(dir);
  if (!entries.has(provider)) throw new Error(`Set ${variable}, or save a key with \`dshproxy video key set ${provider}\`. No request sent.`);
  const key = reveal(await unlock(dir, loadMasterKey), entries.get(provider));
  if (key === null) throw new Error(`The saved ${provider} key cannot be read. Enter it again with \`dshproxy video key set ${provider}\`, or set ${variable}. No request sent.`);
  return key;
}

module.exports = { providers: Object.freeze([...PROVIDERS.keys()]), list, set, remove, resolve, file };
