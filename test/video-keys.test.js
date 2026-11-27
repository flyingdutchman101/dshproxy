'use strict';
require("./support/keychain"); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Nothing here may reach the real data folder, a provider or Windows DPAPI.
// The default data folder of this process is a throwaway one that must stay
// empty, the network throws, and the master key is a test key (see below).
const guard = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-keys-guard-'));
process.env.DSHPROXY_HOME = guard;
globalThis.fetch = () => { throw new Error('network is forbidden in this test'); };
after(() => {
  try {
    assert.deepEqual(fs.readdirSync(guard), []);
  } finally {
    fs.rmSync(guard, { recursive: true, force: true });
  }
});

const keys = require('../src/video/keys');
const secrets = require('../src/secrets');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-keys-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// Stands in for secrets.loadMasterKey, the one place that calls Windows. It
// keeps that function's contract: an existing master.key gives the key, a
// missing one gives null unless `create`, which writes the file first. What it
// writes is a marker, not the key.
function masterKey() {
  const key = crypto.randomBytes(32);
  const calls = [];
  const load = async (file, { create = false } = {}) => {
    calls.push({ file, create });
    if (fs.existsSync(file)) return key;
    if (!create) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'synthetic-wrapped-master-key\n');
    return key;
  };
  return { key, calls, load };
}
const cannotUnlock = async (file) => { throw new Error(`Windows could not unlock ${file}. Saved API keys cannot be read from this account.`); };

const KEY = 'synthetic-VKEY-7c1e9a_not.a-real+key/1=';
const OTHER = 'synthetic-VKEY-second-0042';

// Every form the key could take in a file if it were stored or merely encoded.
function assertNowhere(home, ...plain) {
  for (const name of fs.readdirSync(home, { recursive: true })) {
    const full = path.join(home, name);
    if (!fs.statSync(full).isFile()) continue;
    const bytes = fs.readFileSync(full);
    for (const value of plain) {
      for (const form of [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), Buffer.from(value).toString('hex'), Buffer.from(value, 'utf16le').toString('latin1')]) {
        assert.equal(bytes.includes(form), false, `${name} holds the key`);
      }
    }
  }
}
function snapshot(home) {
  return fs.existsSync(home) ? fs.readdirSync(home).sort().map((name) => [name, fs.readFileSync(path.join(home, name), 'utf8')]) : null;
}
// A refusal: rejects, says nothing of the key, and leaves the folder as it was.
async function refused(home, attempt, pattern, ...plain) {
  const before = snapshot(home);
  await assert.rejects(attempt, (error) => {
    assert.ok(error instanceof Error);
    if (typeof pattern === 'function') pattern(error.message);
    else assert.match(error.message, pattern);
    for (const value of plain) assert.equal(`${error.message}\n${error.stack}`.includes(value), false, 'the error repeats the key');
    return true;
  });
  assert.deepEqual(snapshot(home), before);
}

// Written out by hand from the spec, not computed.
const facts = {
  yotta: {provider:'yotta', label:'Yotta Labs', variable:'YOTTA_API_KEY', routes:['yotta']},
  elevenlabs: {provider:'elevenlabs', label:'ElevenLabs', variable:'ELEVENLABS_API_KEY', routes:['elevenlabs']},
  videorouter: { provider: 'videorouter', label: 'VideoRouter', variable: 'VIDEOROUTER_API_KEY', routes: ['videorouter', 'videorouter-replicate'] },
  kovapi: { provider: 'kovapi', label: 'KovAPI', variable: 'KOVAPI_API_KEY', routes: ['kovapi'] },
  callirra: { provider: 'callirra', label: 'Callirra', variable: 'CALLIRRA_API_KEY', routes: ['callirra'] }
};
const row = (provider, state = {}) => ({ ...facts[provider], saved: false, readable: false, inEnvironment: false, ...state });
const rows = (states = {}) => ['videorouter', 'kovapi', 'callirra', 'elevenlabs', 'yotta'].map((provider) => row(provider, states[provider]));

test('nothing saved: the three providers are listed as not saved, and listing creates nothing and unlocks nothing', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  assert.deepEqual(await keys.list(home, { env: {}, loadMasterKey: master.load }), rows());
  assert.deepEqual(fs.readdirSync(home), []);
  assert.deepEqual(master.calls, []);

  const missing = path.join(home, 'not-created-yet');
  assert.deepEqual(await keys.list(missing, { env: {}, loadMasterKey: master.load }), rows());
  assert.equal(fs.existsSync(missing), false);
  assert.equal(keys.file(home), path.join(home, 'video-keys.json'));
});

test('every API route of the catalog belongs to exactly one provider, and the workspace route to none', async (t) => {
  const { models, routesFor } = require('../src/video/catalog');
  const listed = (await keys.list(tempHome(t), { env: {} })).flatMap((entry) => entry.routes);
  assert.deepEqual([...listed].sort(), [...new Set(listed)].sort());
  const api = new Set(models.flatMap((model) => routesFor(model)).filter((route) => route !== 'krea'));
  assert.deepEqual([...api].sort(), [...listed].sort());
});

test('a saved key is listed as saved and readable, is used for each route of its provider, and is on disk only encrypted with the master key', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const options = { env: {}, loadMasterKey: master.load };
  assert.deepEqual(await keys.set(home, 'videorouter', KEY, options), { provider: 'videorouter', saved: true });
  assert.deepEqual(await keys.list(home, options), rows({ videorouter: { saved: true, readable: true } }));
  assert.equal(await keys.resolve(home, 'videorouter', options), KEY);
  assert.equal(await keys.resolve(home, 'videorouter-replicate', options), KEY);

  // The same protection as the Chat keys: the saved text opens with the master
  // key through src/secrets.js, and with no other key.
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'video-keys.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['providers']);
  assert.deepEqual(Object.keys(saved.providers), ['videorouter']);
  assert.deepEqual(Object.keys(saved.providers.videorouter), ['keyEnc']);
  assert.equal(secrets.decryptWithKey(master.key, saved.providers.videorouter.keyEnc), KEY);
  assert.equal(secrets.decryptWithKey(crypto.randomBytes(32), saved.providers.videorouter.keyEnc), null);
  assertNowhere(home, KEY);

  // The master key is the Chat keys' one: master.key in the data folder,
  // created only by a save.
  assert.deepEqual(master.calls[0], { file: path.join(home, 'master.key'), create: true });
  assert.ok(master.calls.slice(1).every((call) => call.file === path.join(home, 'master.key') && call.create === false));
  assert.deepEqual(fs.readdirSync(home).sort(), ['master.key', 'video-keys.json']);
});

test('the data folder is created on the first save', async (t) => {
  const home = path.join(tempHome(t), 'fresh', 'home');
  const master = masterKey();
  await keys.set(home, 'kovapi', KEY, { loadMasterKey: master.load });
  assert.equal(await keys.resolve(home, 'kovapi', { env: {}, loadMasterKey: master.load }), KEY);
});

test('saving again replaces the key of that provider and leaves the others', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const options = { env: {}, loadMasterKey: master.load };
  await keys.set(home, 'kovapi', KEY, options);
  await keys.set(home, 'callirra', 'synthetic-VKEY-callirra', options);
  const callirraBefore = JSON.parse(fs.readFileSync(keys.file(home), 'utf8')).providers.callirra.keyEnc;
  assert.deepEqual(await keys.set(home, 'kovapi', OTHER, options), { provider: 'kovapi', saved: true });

  assert.equal(await keys.resolve(home, 'kovapi', options), OTHER);
  assert.equal(await keys.resolve(home, 'callirra', options), 'synthetic-VKEY-callirra');
  const saved = JSON.parse(fs.readFileSync(keys.file(home), 'utf8'));
  assert.deepEqual(Object.keys(saved.providers).sort(), ['callirra', 'kovapi']);
  assert.equal(saved.providers.callirra.keyEnc, callirraBefore);
  assert.equal(secrets.decryptWithKey(master.key, saved.providers.kovapi.keyEnc), OTHER);
  assertNowhere(home, KEY, OTHER);
  assert.deepEqual(await keys.list(home, options), rows({ kovapi: { saved: true, readable: true }, callirra: { saved: true, readable: true } }));
});

test('the same key is stored differently each time', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  await keys.set(home, 'kovapi', KEY, { loadMasterKey: master.load });
  const first = fs.readFileSync(keys.file(home), 'utf8');
  await keys.set(home, 'kovapi', KEY, { loadMasterKey: master.load });
  assert.notEqual(fs.readFileSync(keys.file(home), 'utf8'), first);
});

test('a key is trimmed before it is saved', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  for (const given of [`  ${KEY}  `, `${KEY}\r\n`, `\uFEFF${KEY}\n`, `\t${KEY}`]) {
    await keys.set(home, 'callirra', given, { loadMasterKey: master.load });
    assert.equal(await keys.resolve(home, 'callirra', { env: {}, loadMasterKey: master.load }), KEY);
  }
});

test('a key of 512 characters is saved; a longer one is refused', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const longest = 'k'.repeat(512);
  await keys.set(home, 'kovapi', longest, { loadMasterKey: master.load });
  assert.equal(await keys.resolve(home, 'kovapi', { env: {}, loadMasterKey: master.load }), longest);
  const tooLong = `${'synthetic-LONG-'}${'k'.repeat(498)}`;
  assert.equal(tooLong.length, 513);
  await refused(home, keys.set(home, 'kovapi', tooLong, { loadMasterKey: master.load }), /512/, tooLong, 'synthetic-LONG-');
  assert.equal(await keys.resolve(home, 'kovapi', { env: {}, loadMasterKey: master.load }), longest);
});

test('an empty key, a key that is not text, and a key with whitespace, control or non-ASCII characters inside are refused before anything is unlocked or written', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const attempts = ['', '   ', '\r\n', '\uFEFF', 'synthetic BAD-key', 'synthetic\tBAD-key', 'synthetic\nBAD-key', 'synthetic\r\nBAD-key', 'synthetic\u0000BAD-key', 'synthetic\u001bBAD-key',
    'synthetic\u007fBAD-key', 'synthetic\u00a0BAD-key', 'synthetic-BAD-kl\u00fc\u010d', 'synthetic\u200bBAD-key', undefined, null, 7, true, ['synthetic-BAD-key'], { key: 'synthetic-BAD-key' }, Buffer.from('synthetic-BAD-key')];
  for (const given of attempts) {
    await refused(home, keys.set(home, 'videorouter', given, { loadMasterKey: master.load }), /key/i, 'BAD');
  }
  assert.deepEqual(fs.readdirSync(home), []);
  assert.deepEqual(master.calls, []);
});

test('a provider that is not one of the three is refused for every operation, without repeating what was given', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const options = { env: {}, loadMasterKey: master.load };
  await keys.set(home, 'kovapi', OTHER, options);
  for (const provider of ['krea', 'videorouter-replicate', 'VideoRouter', ' kovapi', 'kovapi ', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty', KEY, undefined, null, 0, ['kovapi'], { provider: 'kovapi' }]) {
    await refused(home, keys.set(home, provider, KEY, options), /Unknown video key provider/, KEY);
    await refused(home, keys.remove(home, provider), /Unknown video key provider/, KEY);
  }
  for (const route of ['krea', 'KovAPI', '', 'constructor', '__proto__', KEY, undefined, null]) {
    await refused(home, keys.resolve(home, route, options), /route/i, KEY);
  }
  assert.deepEqual(await keys.list(home, options), rows({ kovapi: { saved: true, readable: true } }));
});

test('removing a key says whether there was one, and leaves the others', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const options = { env: {}, loadMasterKey: master.load };
  assert.deepEqual(await keys.remove(home, 'kovapi'), { provider: 'kovapi', saved: false, removed: false });
  assert.deepEqual(fs.readdirSync(home), []);

  await keys.set(home, 'kovapi', KEY, options);
  await keys.set(home, 'videorouter', OTHER, options);
  assert.deepEqual(await keys.remove(home, 'kovapi'), { provider: 'kovapi', saved: false, removed: true });
  assert.deepEqual(await keys.list(home, options), rows({ videorouter: { saved: true, readable: true } }));
  assert.equal(await keys.resolve(home, 'videorouter', options), OTHER);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(keys.file(home), 'utf8')).providers), ['videorouter']);

  const before = fs.readFileSync(keys.file(home), 'utf8');
  assert.deepEqual(await keys.remove(home, 'kovapi'), { provider: 'kovapi', saved: false, removed: false });
  assert.equal(fs.readFileSync(keys.file(home), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(home).sort(), ['master.key', 'video-keys.json']);
});

// ------------------------------- which key is used -------------------------------

test('the environment variable wins over a saved key, and then nothing saved is opened', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  await keys.set(home, 'videorouter', KEY, { loadMasterKey: master.load });
  master.calls.length = 0;
  const env = { VIDEOROUTER_API_KEY: 'synthetic-ENV-videorouter' };
  assert.equal(await keys.resolve(home, 'videorouter', { env, loadMasterKey: master.load }), 'synthetic-ENV-videorouter');
  assert.equal(await keys.resolve(home, 'videorouter-replicate', { env, loadMasterKey: master.load }), 'synthetic-ENV-videorouter');
  assert.deepEqual(master.calls, []);

  // Not even a damaged file or a master key Windows will not unlock is in the way.
  fs.writeFileSync(keys.file(home), '{"providers": {"videorouter": {"keyEnc": "cut off');
  assert.equal(await keys.resolve(home, 'videorouter', { env, loadMasterKey: cannotUnlock }), 'synthetic-ENV-videorouter');
});

test('a variable that is unset or blank does not count, and a variable of another provider is never borrowed', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  await keys.set(home, 'kovapi', KEY, { loadMasterKey: master.load });
  for (const blank of [undefined, '', '   ', '\t\r\n']) {
    const env = { KOVAPI_API_KEY: blank, VIDEOROUTER_API_KEY: 'synthetic-ENV-videorouter', CALLIRRA_API_KEY: 'synthetic-ENV-callirra' };
    assert.equal(await keys.resolve(home, 'kovapi', { env, loadMasterKey: master.load }), KEY);
  }
  const env = { KOVAPI_API_KEY: 'synthetic-ENV-kovapi' };
  assert.deepEqual(await keys.list(home, { env, loadMasterKey: master.load }), rows({ kovapi: { saved: true, readable: true, inEnvironment: true } }));
  assert.deepEqual(await keys.list(home, { env: { KOVAPI_API_KEY: '  ', CALLIRRA_API_KEY: 'synthetic-ENV-callirra' }, loadMasterKey: master.load }),
    rows({ kovapi: { saved: true, readable: true }, callirra: { inEnvironment: true } }));
});

test('with no variable and no saved key the refusal names both ways to provide one', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  await keys.set(home, 'kovapi', KEY, { loadMasterKey: master.load });
  for (const [route, provider, variable] of [['videorouter', 'videorouter', 'VIDEOROUTER_API_KEY'], ['videorouter-replicate', 'videorouter', 'VIDEOROUTER_API_KEY'], ['callirra', 'callirra', 'CALLIRRA_API_KEY']]) {
    await refused(home, keys.resolve(home, route, { env: { KOVAPI_API_KEY: 'synthetic-ENV-kovapi' }, loadMasterKey: master.load }), (message) => {
      assert.ok(message.includes(`Set ${variable}`));
      assert.ok(message.includes(`video key set ${provider}`));
      assert.ok(message.includes('No request sent.'));
      return true;
    }, KEY, 'synthetic-ENV-kovapi');
  }
});

test('a saved key that cannot be read is listed as such and refused with "enter it again", whatever the reason', async (t) => {
  const again = (message) => {
    assert.match(message, /cannot be read/);
    assert.match(message, /Enter it again/);
    assert.ok(message.includes('video key set callirra'));
    assert.ok(message.includes('No request sent.'));
    return true;
  };
  const unreadable = rows({ callirra: { saved: true, readable: false } });

  // Saved under another master key.
  const home = tempHome(t);
  await keys.set(home, 'callirra', KEY, { loadMasterKey: masterKey().load });
  const stranger = masterKey();
  assert.deepEqual(await keys.list(home, { env: {}, loadMasterKey: stranger.load }), unreadable);
  await refused(home, keys.resolve(home, 'callirra', { env: {}, loadMasterKey: stranger.load }), again, KEY);

  // Windows will not unlock the master key.
  assert.deepEqual(await keys.list(home, { env: {}, loadMasterKey: cannotUnlock }), unreadable);
  await refused(home, keys.resolve(home, 'callirra', { env: {}, loadMasterKey: cannotUnlock }), again, KEY);

  // The master key file is gone: nothing is created to replace it.
  fs.rmSync(path.join(home, 'master.key'));
  const fresh = masterKey();
  assert.deepEqual(await keys.list(home, { env: {}, loadMasterKey: fresh.load }), unreadable);
  await refused(home, keys.resolve(home, 'callirra', { env: {}, loadMasterKey: fresh.load }), again, KEY);
  assert.equal(fs.existsSync(path.join(home, 'master.key')), false);
  assert.ok(fresh.calls.every((call) => call.create === false));

  // The saved text is not something this program wrote.
  const master = masterKey();
  await keys.set(home, 'kovapi', OTHER, { loadMasterKey: master.load });
  const saved = JSON.parse(fs.readFileSync(keys.file(home), 'utf8'));
  saved.providers.callirra = { keyEnc: 'bm90IGEgc2F2ZWQga2V5' };
  fs.writeFileSync(keys.file(home), JSON.stringify(saved));
  assert.deepEqual(await keys.list(home, { env: {}, loadMasterKey: master.load }), rows({ kovapi: { saved: true, readable: true }, callirra: { saved: true, readable: false } }));
  await refused(home, keys.resolve(home, 'callirra', { env: {}, loadMasterKey: master.load }), again, OTHER);

  // What opens to something that is not a usable key counts as unreadable too.
  saved.providers.callirra = { keyEnc: secrets.encryptWithKey(master.key, 'synthetic BAD key') };
  fs.writeFileSync(keys.file(home), JSON.stringify(saved));
  assert.deepEqual((await keys.list(home, { env: {}, loadMasterKey: master.load }))[2], row('callirra', { saved: true, readable: false }));
  await refused(home, keys.resolve(home, 'callirra', { env: {}, loadMasterKey: master.load }), again, 'synthetic BAD key', 'BAD');

  // The variable still works while the saved key does not.
  assert.equal(await keys.resolve(home, 'callirra', { env: { CALLIRRA_API_KEY: 'synthetic-ENV-callirra' }, loadMasterKey: cannotUnlock }), 'synthetic-ENV-callirra');
  // And entering it again makes it readable.
  await keys.set(home, 'callirra', KEY, { loadMasterKey: master.load });
  assert.equal(await keys.resolve(home, 'callirra', { env: {}, loadMasterKey: master.load }), KEY);
});

test('when the master key cannot be unlocked a save is an error and changes nothing', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  await keys.set(home, 'kovapi', OTHER, { loadMasterKey: master.load });
  await refused(home, keys.set(home, 'kovapi', KEY, { loadMasterKey: cannotUnlock }), /could not unlock/, KEY);
  await refused(home, keys.set(home, 'callirra', KEY, { loadMasterKey: async () => null }), /master key/i, KEY);
  await refused(home, keys.set(home, 'callirra', KEY, { loadMasterKey: async () => Buffer.alloc(8) }), /master key/i, KEY);
  assert.equal(await keys.resolve(home, 'kovapi', { env: {}, loadMasterKey: master.load }), OTHER);
});

// ------------------------------- the saved file -------------------------------

for (const [name, text] of [['cut off', '{"providers": {"kovapi": {"keyEnc": "synthetic-LEAK-0'], ['a list', '[1, 2]'], ['empty', ''], ['null', 'null'], ['text', '"synthetic-LEAK-0"']]) {
  test(`a saved file that is ${name} is an error for listing, saving, removing and using, repeats nothing from inside it, and is left in place`, async (t) => {
    const home = tempHome(t);
    const master = masterKey();
    const options = { env: {}, loadMasterKey: master.load };
    fs.writeFileSync(keys.file(home), text);
    for (const attempt of [() => keys.list(home, options), () => keys.set(home, 'kovapi', KEY, options), () => keys.remove(home, 'kovapi'), () => keys.resolve(home, 'kovapi', options)]) {
      await refused(home, attempt(), /video-keys\.json/, KEY, 'LEAK', 'keyEnc');
    }
    assert.equal(fs.readFileSync(keys.file(home), 'utf8'), text);
    // Found out before a master key is created or unlocked for nothing.
    assert.deepEqual(master.calls, []);
    assert.deepEqual(fs.readdirSync(home), ['video-keys.json']);
  });
}

test('a saved file that cannot be read is an error and is not replaced', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  fs.mkdirSync(keys.file(home));
  await assert.rejects(keys.list(home, { env: {}, loadMasterKey: master.load }), /video-keys\.json/);
  await assert.rejects(keys.set(home, 'kovapi', KEY, { loadMasterKey: master.load }), /video-keys\.json/);
  await assert.rejects(keys.remove(home, 'kovapi'), /video-keys\.json/);
  await assert.rejects(keys.resolve(home, 'kovapi', { env: {}, loadMasterKey: master.load }), /video-keys\.json/);
  assert.ok(fs.statSync(keys.file(home)).isDirectory());
  assert.deepEqual(fs.readdirSync(home).filter((name) => name !== 'master.key'), ['video-keys.json']);
});

test('an entry that is not exactly a saved key counts as not saved, and the next save drops it from the file', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const options = { env: {}, loadMasterKey: master.load };
  await keys.set(home, 'kovapi', OTHER, options);
  const good = JSON.parse(fs.readFileSync(keys.file(home), 'utf8')).providers.kovapi;
  fs.writeFileSync(keys.file(home), `{
    "apiKey": "synthetic-LEAK-1",
    "providers": {
      "__proto__": { "keyEnc": "${good.keyEnc}" },
      "kovapi": { "keyEnc": "${good.keyEnc}" },
      "videorouter": { "keyEnc": "${good.keyEnc}", "key": "synthetic-LEAK-2" },
      "callirra": "synthetic-LEAK-3",
      "retired": { "keyEnc": "${good.keyEnc}" }
    }
  }`);
  assert.deepEqual(await keys.list(home, options), rows({ kovapi: { saved: true, readable: true } }));
  await refused(home, keys.resolve(home, 'videorouter', options), /Set VIDEOROUTER_API_KEY/, 'LEAK');
  await refused(home, keys.resolve(home, 'callirra', options), /Set CALLIRRA_API_KEY/, 'LEAK');
  assert.equal({}.keyEnc, undefined);

  await keys.set(home, 'callirra', KEY, options);
  const text = fs.readFileSync(keys.file(home), 'utf8');
  assert.doesNotMatch(text, /LEAK|retired|apiKey|"key"|__proto__|videorouter/);
  assert.deepEqual(Object.keys(JSON.parse(text).providers).sort(), ['callirra', 'kovapi']);
  assert.equal(await keys.resolve(home, 'kovapi', options), OTHER);
  assert.equal(await keys.resolve(home, 'callirra', options), KEY);

  for (const entry of [null, [], {}, { keyEnc: '' }, { keyEnc: 7 }, { keyEnc: null }, { keyEnc: ['a'] }, { keyEnc: 'not base64 !' }, { keyEnc: 'A'.repeat(4097) }]) {
    fs.writeFileSync(keys.file(home), JSON.stringify({ providers: { kovapi: entry } }));
    assert.deepEqual(await keys.list(home, options), rows(), JSON.stringify(entry));
  }
  for (const saved of [{}, { providers: null }, { providers: [] }, { providers: 'kovapi' }, { kovapi: good }]) {
    fs.writeFileSync(keys.file(home), JSON.stringify(saved));
    assert.deepEqual(await keys.list(home, options), rows(), JSON.stringify(saved));
  }
});

test('saves started together are all kept, and saving leaves no other file behind', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const options = { env: {}, loadMasterKey: master.load };
  await Promise.all([
    keys.set(home, 'videorouter', 'synthetic-VKEY-a', options),
    keys.set(home, 'kovapi', 'synthetic-VKEY-b', options),
    keys.set(home, 'callirra', 'synthetic-VKEY-c', options)
  ]);
  assert.equal(await keys.resolve(home, 'videorouter', options), 'synthetic-VKEY-a');
  assert.equal(await keys.resolve(home, 'kovapi', options), 'synthetic-VKEY-b');
  assert.equal(await keys.resolve(home, 'callirra', options), 'synthetic-VKEY-c');
  await Promise.all([keys.remove(home, 'kovapi'), keys.set(home, 'callirra', 'synthetic-VKEY-d', options), keys.remove(home, 'videorouter')]);
  assert.deepEqual(await keys.list(home, options), rows({ callirra: { saved: true, readable: true } }));
  assert.equal(await keys.resolve(home, 'callirra', options), 'synthetic-VKEY-d');
  assert.deepEqual(fs.readdirSync(home).sort(), ['master.key', 'video-keys.json']);
});

test('chat settings, video settings and every other file in the data folder are left exactly as they were', async (t) => {
  const home = tempHome(t);
  const master = masterKey();
  const others = {
    'settings.json': `${JSON.stringify({ port: 9100, providers: { deepseek: { region: 'international', keyEnc: 'ZW5j' } }, somethingNewer: { kept: true } }, null, 2)}\n`,
    'video-settings.json': '{"models":{"wan-3.0":{"enabled":true,"route":"kovapi"}}}',
    'master.key': 'synthetic-wrapped-master-key\n',
    'control.token': 'synthetic-not-a-token'
  };
  for (const [name, text] of Object.entries(others)) fs.writeFileSync(path.join(home, name), text);
  await keys.set(home, 'kovapi', KEY, { loadMasterKey: master.load });
  await keys.list(home, { env: {}, loadMasterKey: master.load });
  await keys.resolve(home, 'kovapi', { env: {}, loadMasterKey: master.load });
  await keys.remove(home, 'kovapi');
  for (const [name, text] of Object.entries(others)) assert.equal(fs.readFileSync(path.join(home, name), 'utf8'), text, name);
  assert.deepEqual(fs.readdirSync(home).sort(), ['control.token', 'master.key', 'settings.json', 'video-keys.json', 'video-settings.json']);

  // And the other way: saving the chat settings does not lose a video key.
  const chat = require('../src/settings');
  await keys.set(home, 'kovapi', KEY, { loadMasterKey: master.load });
  chat.save({ ...chat.load(home), cooldownMinutes: 20 }, home);
  assert.equal(await keys.resolve(home, 'kovapi', { env: {}, loadMasterKey: master.load }), KEY);
});

test('the data folder must be named as text', async () => {
  for (const home of ['', null, 7, {}, []]) {
    await assert.rejects(keys.list(home, { env: {} }), /data folder/);
    await assert.rejects(keys.set(home, 'kovapi', KEY, { loadMasterKey: masterKey().load }), /data folder/);
    await assert.rejects(keys.remove(home, 'kovapi'), /data folder/);
    await assert.rejects(keys.resolve(home, 'kovapi', { env: {} }), /data folder/);
    assert.throws(() => keys.file(home), /data folder/);
  }
});

// ------------------------------- defaults -------------------------------

// A child process whose data folder and profile are throwaway ones. The real
// master key loader runs here, but only down the branch that never calls
// Windows: there is no master.key, and nothing asks to create one.
test('with nothing passed in, the data folder is DSHPROXY_HOME, the variables are the process environment and the master key is master.key beside the file', (t) => {
  const home = tempHome(t);
  const profile = tempHome(t);
  fs.writeFileSync(path.join(home, 'video-keys.json'), JSON.stringify({ providers: { kovapi: { keyEnc: secrets.encryptWithKey(crypto.randomBytes(32), KEY) } } }));
  const env = { USERPROFILE: profile, HOME: profile, DSHPROXY_HOME: home, CALLIRRA_API_KEY: 'synthetic-ENV-callirra' };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const script = `
    const keys = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'video', 'keys.js'))});
    (async () => {
      const result = { file: keys.file(), list: await keys.list(), callirra: await keys.resolve(undefined, 'callirra'), removed: await keys.remove(undefined, 'videorouter') };
      try { await keys.resolve(undefined, 'kovapi'); } catch (error) { result.kovapi = error.message; }
      process.stdout.write(JSON.stringify(result));
    })().catch((error) => { process.stderr.write(String(error)); process.exit(1); });`;
  const run = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.file, path.join(home, 'video-keys.json'));
  assert.deepEqual(result.list, rows({ kovapi: { saved: true, readable: false }, callirra: { inEnvironment: true } }));
  assert.equal(result.callirra, 'synthetic-ENV-callirra');
  assert.deepEqual(result.removed, { provider: 'videorouter', saved: false, removed: false });
  assert.match(result.kovapi, /Enter it again/);
  assert.equal(run.stdout.includes(KEY), false);
  assert.deepEqual(fs.readdirSync(home), ['video-keys.json']);
  assert.deepEqual(fs.readdirSync(profile), []);
});
