'use strict';
// One purchase per quote: a quote can lead to at most one paid request,
// whatever is repeated, restarted or run at the same moment.
//
// Everything runs against fakes: no provider, no network, no credential. The
// only seam is create(...).answer(body, write). "The gateway restarted" is a
// second create() on the same folder. The fake submit plays the child process:
// like the real one it writes the outcome file itself, with the claim's nonce.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PICKER = path.join(__dirname, '..', 'src', 'video', 'picker');
const STORE = path.join(PICKER, 'store.js');
const { create } = require(PICKER);
const store = require(STORE);
const { classify } = require(path.join(PICKER, 'classify.js'));

// ------------------------------- the fakes -------------------------------

const ENTRIES = {
  'seedance-2.5/720p/krea': { model: 'seedance-2.5', resolution: '720p', route: 'krea', label: 'Seedance 2.5 - 720p - Krea', unit: 'krea_units' },
  'wan-3.0/1080p/krea': { model: 'wan-3.0', resolution: '1080p', route: 'krea', label: 'Wan 3.0 - 1080p - Krea', unit: 'krea_units' }
};
const ENTRY = 'seedance-2.5/720p/krea';
const OTHER = 'wan-3.0/1080p/krea';
const PROMPT = 'A red ball rolls slowly across a wooden table';
const SECRET = 'synthetic-SECRET-41c7';
const HOUR = 3600000;

// A small fixed-seed generator: the same sequences on every run.
function generator(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return { next, chance: (p) => next() < p, int: (below) => Math.floor(next() * below), pick: (list) => list[Math.floor(next() * list.length)] };
}

// A throwaway data folder with a picker on it, a clock that moves only when
// something sleeps or the test moves it, and fakes that count their calls.
// The journal's age is set through the clock: `age` is how old the journal is
// when the test starts.
function makeWorld({ seed = 1, age = HOUR } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-picker-'));
  const bytes = generator(seed);
  const w = {
    home, files: store.open(home), logs: [], calls: { quote: [], submit: [], status: [] },
    submitPlan: [], statusPlan: [], off: new Set(), more: {}, exposed: false, onSleep: null, onHang: null,
    offer: () => ({ ok: true, amount: 856, unit: 'krea_units', estimated: false, available: 97909.73 })
  };
  w.clock = {
    time: 0,
    now: () => w.clock.time,
    sleep: async (ms) => {
      assert.ok(Number.isInteger(ms) && ms > 0, `a sleep of ${ms}`);
      w.clock.time += ms;
      if (w.onSleep) w.onSleep();
    }
  };
  const child = (order, how) => {
    if (how === 'hang') {
      if (w.onHang) w.onHang();
      return new Promise(() => {});
    }
    if (how === 'throw') throw new Error(`${SECRET} at ${home}\\secret.txt`);
    if (how === 'ok') w.files.writeOutcome(order.id, { state: 'submitted', nonce: order.nonce, jobId: `job-${w.calls.submit.length}`, status: 'scheduled' });
    if (how === 'not-sent') w.files.writeOutcome(order.id, { state: 'not-sent', nonce: order.nonce, reason: 'over-cap' });
    // 'silent': the child ended and wrote nothing
    return Promise.resolve({ note: SECRET });
  };
  w.ops = {
    quote: async (request) => { w.calls.quote.push(request); return w.offer(request); },
    submit: (order) => { w.calls.submit.push(order); return child(order, w.submitPlan.shift() || 'ok'); },
    status: async (request) => {
      w.calls.status.push(request);
      const planned = w.statusPlan.shift();
      return planned || { ok: true, status: 'completed', progress: 100, links: [`https://clips.example/${request.jobId}.mp4`] };
    }
  };
  w.options = () => ({
    home,
    ops: w.ops,
    clock: w.clock,
    random: (count) => Buffer.from(Array.from({ length: count }, () => bytes.int(256))),
    entries: () => new Map([...Object.entries(ENTRIES), ...Object.entries(w.more)].filter(([id]) => !w.off.has(id))),
    exposed: () => w.exposed,
    log: (line) => { w.logs.push(line); }
  });
  w.another = () => create(w.options());
  w.restart = () => { w.picker = w.another(); return w.picker; };
  w.hung = () => new Promise((resolve) => { w.onHang = resolve; });
  w.restart();
  w.born = fs.statSync(w.files.journal).birthtimeMs;
  w.clock.time = Math.ceil(w.born) + age;
  w.dispose = () => fs.rmSync(home, { recursive: true, force: true });
  return w;
}

function world(t, options) {
  const w = makeWorld(options);
  t.after(w.dispose);
  return w;
}

// No answer and no log line may carry anything from an error or from the
// machine; no log line may carry a prompt or a link.
function clean(w, text) {
  for (const [what, value] of [['an answer', text], ['a log line', w.logs.join('\n')]]) {
    assert.ok(!value.includes(SECRET), `${what} repeats text from an error`);
    assert.ok(!value.includes(w.home) && !value.includes(os.tmpdir()), `${what} holds a file path`);
    assert.doesNotMatch(value, /\n\s+at |node:|Error:|\.js\b/, `${what} holds a stack trace`);
  }
  assert.doesNotMatch(w.logs.join('\n'), /red ball|Clip \d|https:/, 'a log line holds a prompt or a link');
}

async function ask(w, body, picker = w.picker) {
  const pieces = [];
  await picker.answer(body, (piece) => {
    assert.equal(typeof piece, 'string');
    pieces.push(piece);
  });
  const text = pieces.join('');
  assert.notEqual(text, '', 'an empty answer');
  clean(w, text);
  return text;
}

// ------------------------------- requests as DeepSeek Harness sends them -------------------------------

const SYSTEM = [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.', cache_control: { type: 'ephemeral' } }];
const TOOLS = [{ name: 'read', description: 'Read a UTF-8 text file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }];
const REMINDER = '<system-reminder>\nThe following information describes your current session:\n\nCurrent working directory: "C:\\\\work\\\\project".\n</system-reminder>';
const sampled = (turn) => `Time sampled while preparing turn ${turn}, step 1: 2026-11-23T02:04:11+01:00[Europe/Zagreb]`;
const CACHE = { cache_control: { type: 'ephemeral' } };

// turns: [['user', text], ['assistant', text], ...]. The Harness adds its own
// user-role messages after the typed one; the last user message is a list.
//   separate  each a message of its own (what the facts file describes)
//   merged    one message with a text block each (in case the library merges)
//   bare      only the typed text
function request(model, turns, shape = 'separate') {
  const messages = [];
  let turn = 0;
  turns.forEach(([role, text], index) => {
    const last = index === turns.length - 1;
    if (role === 'assistant') {
      messages.push({ role, content: [{ type: 'text', text }] });
      return;
    }
    turn += 1;
    if (shape === 'bare') messages.push({ role, content: last ? [{ type: 'text', text, ...CACHE }] : text });
    else if (shape === 'merged') messages.push({ role, content: [{ type: 'text', text }, { type: 'text', text: REMINDER }, { type: 'text', text: sampled(turn), ...(last ? CACHE : {}) }] });
    else messages.push({ role, content: text }, { role, content: REMINDER }, { role, content: last ? [{ type: 'text', text: sampled(turn), ...CACHE }] : sampled(turn) });
  });
  return { model, max_tokens: 4096, stream: true, system: SYSTEM, tools: TOOLS, messages };
}

async function quoted(w, prompt = PROMPT, model = ENTRY) {
  const text = await ask(w, request(model, [['user', prompt]]));
  const found = /\nQuote (Q-[A-Z2-9]{16})$/.exec(text);
  assert.ok(found, `not a quote: ${text}`);
  return { id: found[1], text, prompt, model, turns: [['user', prompt], ['assistant', text]] };
}
const confirming = (quote, word = 'yes', shape = 'separate') => request(quote.model, [...quote.turns, ['user', word]], shape);
const submitsOf = (w, id) => w.calls.submit.filter((order) => order.id === id).length;
const unknownText = (id) => [
  'I do not know whether this clip was bought.',
  '',
  `The order for quote ${id} was handed over once and no answer came back. It may have been sent and charged, or not.`,
  'I will not send it again. Check your Krea history at krea.ai before you order this prompt again.',
  `Finished ${id}`
].join('\n');

// ------------------------------- the quote -------------------------------

test('a typed prompt gets the quote of the design, stored before it is shown, and nothing is bought', async (t) => {
  const w = world(t, { seed: 3 });
  const quote = await quoted(w);
  const until = new Date(w.clock.time + 600000);
  const time = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
  assert.equal(quote.text, [
    '**Quote: Seedance 2.5 - 720p - Krea**',
    '',
    '- Cost: at most 856 Krea compute units. Your workspace has 97,909.73. Krea holds this amount when the job starts and sets the final charge itself.',
    '- Clip: one clip, 5 seconds, 16:9, 720p, from text only.',
    '- Prompt, exactly as it will be sent:',
    '',
    '```',
    PROMPT,
    '```',
    '',
    'Nothing has been bought. To buy this clip, reply with only `yes` (or `da`). To drop it, reply `no`.',
    `The quote stands until ${time}, ten minutes from now. If Krea's price is higher by then, nothing is sent.`,
    '',
    `Quote ${quote.id}`
  ].join('\n'));
  assert.match(quote.id, /^Q-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{16}$/);
  assert.deepEqual(w.calls.quote, [{ entry: ENTRY, model: 'seedance-2.5', resolution: '720p', route: 'krea', prompt: PROMPT }]);
  assert.equal(w.calls.submit.length, 0);

  const record = w.files.readQuote(quote.id);
  assert.deepEqual({ ...record, promptSha: 'x', answerSha: 'x' }, {
    v: 1, id: quote.id, entry: ENTRY, model: 'seedance-2.5', resolution: '720p', route: 'krea', label: 'Seedance 2.5 - 720p - Krea',
    prompt: PROMPT, promptSha: 'x', amount: 856, unit: 'krea_units', cap: '856', estimated: false,
    issuedAt: w.clock.time, expiresAt: w.clock.time + 600000, answerSha: 'x'
  });
  assert.equal(record.answerSha, store.sha256(quote.text));
  assert.equal(fs.readFileSync(w.files.journal, 'utf8'), '', 'a quote writes nothing to the journal');

  // A quote that is not a whole number is capped upward, never below; the
  // prompt cannot end its own block.
  w.offer = () => ({ ok: true, amount: 380.33333333333326, estimated: true });
  const odd = await quoted(w, 'Clip with ```` four backticks');
  assert.match(odd.text, /- Cost: at most 380\.333334 Krea compute units \(Krea marks this quote as an estimate\)\. Krea holds/);
  assert.match(odd.text, /\n`````\nClip with ```` four backticks\n`````\n/);

  // No quote, and one sentence saying why.
  for (const [offer, sentence] of [
    [{ ok: false, reason: 'sign-in' }, 'Sign in to Krea in the DSHProxy app, then send the prompt again.'],
    [{ ok: false, reason: 'balance', needs: 856, has: 120 }, 'The balance does not cover this clip: it needs 856 and has 120. There is no quote and nothing was bought.'],
    [{ ok: true, amount: 856, available: 120 }, 'The balance does not cover this clip: it needs 856 and has 120. There is no quote and nothing was bought.'],
    [{ ok: true, amount: -1 }, 'No quote could be made just now. Nothing was bought. Send the prompt again later.'],
    [{ ok: true, amount: 856, unit: 'usd' }, 'No quote could be made just now. Nothing was bought. Send the prompt again later.'],
    [{ ok: false, reason: SECRET }, 'No quote could be made just now. Nothing was bought. Send the prompt again later.'],
    [null, 'No quote could be made just now. Nothing was bought. Send the prompt again later.']
  ]) {
    w.offer = () => offer;
    assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), sentence);
  }
  w.offer = () => { throw new Error(SECRET); };
  assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), 'No quote could be made just now. Nothing was bought. Send the prompt again later.');
  assert.equal(fs.readdirSync(path.join(w.files.folder, 'quotes')).length, 2);
  assert.equal(w.calls.submit.length, 0);
});

test('an entry on an API route quotes a dated published price, says that nobody checked it, and buys once like any other', async (t) => {
  const w = world(t);
  const api = 'wan-3.0/720p/videorouter';
  w.more[api] = { model: 'wan-3.0', resolution: '720p', route: 'videorouter', label: 'Wan 3.0 - 720p - VideoRouter', unit: 'usd' };
  // Without the date of the published price there is no quote.
  w.offer = () => ({ ok: true, amount: 0.85 });
  assert.equal(await ask(w, request(api, [['user', PROMPT]])), 'No quote could be made just now. Nothing was bought. Send the prompt again later.');

  w.offer = () => ({ ok: true, amount: 0.85, unit: 'usd', published: '2026-11-20' });
  const quote = await quoted(w, PROMPT, api);
  const lines = quote.text.split('\n');
  assert.deepEqual(lines.slice(0, 5), [
    '**Quote: Wan 3.0 - 720p - VideoRouter**',
    '',
    '- Cost: at most 0.85 US dollars.',
    'This is the published price of 2026-11-20. It is not checked with VideoRouter before the job, and VideoRouter decides the final charge.',
    '- Clip: one clip, 5 seconds, 16:9, 720p, from text only.'
  ]);
  assert.match(lines.at(-3), /^The quote stands until \d\d:\d\d, ten minutes from now\.$/);
  assert.doesNotMatch(quote.text, /Krea/);

  w.submitPlan.push('silent');
  const text = await ask(w, confirming(quote));
  assert.equal(text, [
    `Buying one clip: Wan 3.0 - 720p - VideoRouter, at most 0.85 US dollars (quote ${quote.id}).`,
    'I do not know whether this clip was bought.',
    '',
    `The order for quote ${quote.id} was handed over once and no answer came back. It may have been sent and charged, or not.`,
    'I will not send it again. Check your VideoRouter account before you order this prompt again.',
    `Finished ${quote.id}`
  ].join('\n'));
  assert.deepEqual(w.calls.submit.map((order) => [order.id, order.route, order.cap, order.unit]), [[quote.id, 'videorouter', '0.85', 'usd']]);

  const next = await quoted(w, 'A paper boat on a pond', api);
  const done = await ask(w, confirming(next));
  assert.ok(done.endsWith(`\n[Open the clip](https://clips.example/job-2.mp4)\n\nVideoRouter sets the final charge itself; the quoted amount was at most 0.85 US dollars.\nFinished ${next.id}`), done);
  w.restart();
  await ask(w, confirming(quote));
  await ask(w, confirming(next));
  assert.equal(w.calls.submit.length, 2);
});

// ------------------------------- tests 1 to 5 of the design -------------------------------

test('1. the confirming request arrives twice with a new picker in between: one submit, and the second answer names the first job', { timeout: 60000 }, async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const body = confirming(quote);
  w.statusPlan.push({ ok: true, status: 'processing', progress: 35 }, { ok: true, status: 'processing', progress: 75 });
  const first = await ask(w, body);

  assert.equal(w.calls.submit.length, 1);
  const [order] = w.calls.submit;
  assert.match(order.nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual(order, {
    id: quote.id, nonce: order.nonce, entry: ENTRY, model: 'seedance-2.5', resolution: '720p', route: 'krea',
    prompt: PROMPT, cap: '856', amount: 856, unit: 'krea_units', outcomeFile: w.files.outcomeFile(quote.id)
  });
  assert.equal(first, [
    `Buying one clip: Seedance 2.5 - 720p - Krea, at most 856 units (quote ${quote.id}).`,
    'Sent once. Job job-1 is scheduled.',
    'Generating processing 35 % .. processing 75 % .',
    'Done after 35 s.',
    '',
    '[Open the clip](https://clips.example/job-1.mp4)',
    '',
    'Krea held up to 856 units and sets the final charge itself. Check it with `dshproxy video balance krea`.',
    `Finished ${quote.id}`
  ].join('\n'));

  // The gateway restarts and the same request arrives again.
  w.restart();
  const checks = w.calls.status.length;
  const second = await ask(w, structuredClone(body));
  assert.equal(w.calls.submit.length, 1, `submit was called ${w.calls.submit.length} times for ${quote.id}`);
  assert.equal(second, [
    `Job job-1 (Seedance 2.5 - 720p - Krea, quote ${quote.id}): completed.`,
    '',
    '[Open the clip](https://clips.example/job-1.mp4)',
    '',
    'Krea held up to 856 units and sets the final charge itself. Check it with `dshproxy video balance krea`.',
    `Finished ${quote.id}`
  ].join('\n'));
  assert.equal(w.calls.status.length, checks, 'a stored result is given without asking the provider');

  // And again long after the quote has expired, in every wire shape.
  w.clock.time += 5 * HOUR;
  for (const shape of ['merged', 'bare', 'separate']) {
    w.restart();
    assert.equal(await ask(w, confirming(quote, 'Da!', shape)), second);
  }
  assert.equal(w.calls.submit.length, 1, `submit was called ${w.calls.submit.length} times for ${quote.id}`);
  assert.equal(w.calls.quote.length, 1);
});

test('2. the first submit never returns: the repeat waits, and says "unknown" once the claim is 180 seconds old; one submit', { timeout: 60000 }, async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const body = confirming(quote);
  w.submitPlan.push('hang');
  const hung = w.hung();
  w.picker.answer(body, () => {});
  await hung;
  const claimedAt = w.clock.time;

  // That gateway is gone. A new one gets the same request 20 seconds later.
  w.restart();
  w.clock.time += 20000;
  const second = await ask(w, structuredClone(body));
  assert.equal(w.calls.submit.length, 1, `submit was called ${w.calls.submit.length} times for ${quote.id}`);
  assert.equal(second, `This quote is already being sent.${'.'.repeat(160)}\n${unknownText(quote.id)}`);
  assert.equal(w.clock.time - claimedAt, 180000);

  // Later it does not wait. The unknown is not written down: a child that
  // finishes late can still say what happened.
  w.restart();
  const before = w.clock.time;
  assert.equal(await ask(w, structuredClone(body)), unknownText(quote.id));
  assert.equal(w.clock.time, before);
  assert.equal(fs.existsSync(w.files.outcomeFile(quote.id)), false);
  assert.equal(w.calls.submit.length, 1, `submit was called ${w.calls.submit.length} times for ${quote.id}`);
  assert.equal(w.calls.status.length, 0);
});

test('3. the outcome is written after the first picker is dropped: the repeat names the job; one submit', { timeout: 60000 }, async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const body = confirming(quote);
  w.submitPlan.push('hang');
  let hung = w.hung();
  w.picker.answer(body, () => {});
  await hung;
  const [order] = w.calls.submit;

  // The gateway died; the child finished afterwards and wrote its outcome.
  assert.equal(w.files.writeOutcome(order.id, { state: 'submitted', nonce: order.nonce, jobId: 'job-late-7', status: 'queued' }), true);
  w.restart();
  w.clock.time += 200000;
  w.statusPlan.push({ ok: true, status: 'processing', progress: 35 });
  const second = await ask(w, structuredClone(body));
  assert.equal(w.calls.submit.length, 1, `submit was called ${w.calls.submit.length} times for ${quote.id}`);
  assert.equal(second, [
    `Job job-late-7 (Seedance 2.5 - 720p - Krea, quote ${quote.id}): processing, 35 %. Sent 3 minutes ago.`,
    'Generating .',
    'Done after 3 min 35 s.',
    '',
    '[Open the clip](https://clips.example/job-late-7.mp4)',
    '',
    'Krea held up to 856 units and sets the final charge itself. Check it with `dshproxy video balance krea`.',
    `Finished ${quote.id}`
  ].join('\n'));
  assert.deepEqual(w.calls.status.map((call) => call.jobId), ['job-late-7', 'job-late-7']);

  // The same, where the outcome appears while the repeat is waiting for it.
  const next = await quoted(w, 'A paper boat on a pond');
  w.submitPlan.push('hang');
  hung = w.hung();
  w.picker.answer(confirming(next), () => {});
  await hung;
  const late = w.calls.submit[1];
  w.restart();
  let sleeps = 0;
  w.onSleep = () => {
    sleeps += 1;
    if (sleeps === 3) w.files.writeOutcome(late.id, { state: 'submitted', nonce: late.nonce, jobId: 'job-late-8', status: 'scheduled' });
  };
  const third = await ask(w, confirming(next));
  w.onSleep = null;
  assert.ok(third.startsWith(`This quote is already being sent....\nJob job-late-8 (Seedance 2.5 - 720p - Krea, quote ${next.id}): completed. Sent less than a minute ago.\n`), third);
  assert.equal(submitsOf(w, quote.id), 1, `submit was called ${submitsOf(w, quote.id)} times for ${quote.id}`);
  assert.equal(submitsOf(w, next.id), 1, `submit was called ${submitsOf(w, next.id)} times for ${next.id}`);
});

test('4. two confirmations at once: one submit', { timeout: 60000 }, async (t) => {
  const w = world(t);
  // On one picker.
  const quote = await quoted(w);
  const both = await Promise.all([ask(w, confirming(quote)), ask(w, confirming(quote))]);
  assert.equal(submitsOf(w, quote.id), 1, `submit was called ${submitsOf(w, quote.id)} times for ${quote.id}`);
  assert.equal(both.filter((text) => text.startsWith('Buying one clip: ')).length, 1);
  for (const text of both) assert.match(text, /Job job-1 /);

  // On two pickers on one folder, from a forked session: the two requests
  // share the quote and differ after it.
  const fork = await quoted(w, 'A paper boat on a pond');
  const forked = await Promise.all([
    ask(w, confirming(fork, 'yes', 'separate'), w.another()),
    ask(w, confirming(fork, 'da', 'merged'), w.another()),
    ask(w, confirming(fork, 'Potvrđujem.', 'bare'), w.another())
  ]);
  assert.equal(submitsOf(w, fork.id), 1, `submit was called ${submitsOf(w, fork.id)} times for ${fork.id}`);
  assert.equal(forked.filter((text) => text.startsWith('Buying one clip: ')).length, 1);
  for (const text of forked) assert.match(text, /Job job-2 /);

  // While the one submit is still out, the others wait for it and send nothing.
  const slow = await quoted(w, 'A kite over a field');
  w.submitPlan.push('hang');
  const hung = w.hung();
  w.picker.answer(confirming(slow), () => {});
  const waiting = [ask(w, confirming(slow), w.another()), ask(w, confirming(slow, 'da'), w.another())];
  await hung;
  for (const text of await Promise.all(waiting)) assert.ok(text.endsWith(unknownText(slow.id)), text);
  assert.equal(submitsOf(w, slow.id), 1, `submit was called ${submitsOf(w, slow.id)} times for ${slow.id}`);
  assert.equal(w.calls.submit.length, 3);
});

// Test 5. A reference model says, for every request, whether it is the first
// confirmation of its quote that passes all the checks C1 to C5 (and the
// journal's first minute). Exactly those requests buy, each once.
const WORDS = ['yes', 'Yes', 'YES', 'yes.', 'da', 'Da!', 'confirm', 'Confirm.', 'potvrdi', 'POTVRDI!', 'potvrđujem', 'Potvrđujem.', 'potvrdujem', '  yes  ', 'yes\n'];
const NOT_WORDS = ['yes please', 'ok', 'y', '"yes"', 'yes?', 'yes yes', 'YES!!', 'ｙｅｓ', 'može', 'yes .', 'уes'];
const SHAPES = ['separate', 'merged', 'bare'];

async function sequence(seed, stats) {
  const rnd = generator(seed * 7919 + 13);
  // Every tenth sequence starts on a journal that is 20 seconds old.
  const w = makeWorld({ seed, age: seed % 10 === 0 ? 20000 : HOUR });
  const quotes = [];
  const sent = [];
  let journal = fs.readFileSync(w.files.journal);
  let step = 0;
  let op = 'start';
  let conversations = 0;

  const buys = (send) => {
    const quote = send.quote;
    if (quote === null) return false;                                  // C1 or C2 fails by construction
    if (quote.used) return false;                                      // C4
    if (send.body.model !== quote.entry || w.off.has(quote.entry)) return false; // C3: this entry, switched on
    const now = w.clock.time;
    if (now < quote.issuedAt || now > quote.expiresAt) return false;   // C3: the ten minutes
    if (w.exposed) return false;                                       // C5
    return now - w.born >= 60000;                                      // the journal's first minute
  };

  const check = () => {
    const counts = new Map();
    for (const order of w.calls.submit) counts.set(order.id, (counts.get(order.id) || 0) + 1);
    for (const [id, count] of counts) {
      assert.ok(count <= 1, `submit was called ${count} times for ${id}`);
      assert.ok(quotes.some((quote) => quote.id === id && quote.expected === 1), `submit was called for ${id}, which failed the checks`);
    }
    for (const quote of quotes) assert.equal(counts.get(quote.id) || 0, quote.expected, `the first valid confirmation of ${quote.id} did not buy`);
    const now = fs.readFileSync(w.files.journal);
    assert.ok(now.subarray(0, journal.length).equals(journal), 'the journal was truncated or rewritten');
    journal = now;
  };

  // Sends requests at the same moment; the model takes them in order.
  const deliver = async (sends, pickers = [w.picker]) => {
    let hung = null;
    const running = sends.map((send, index) => {
      if (buys(send)) {
        send.quote.used = true;
        send.quote.expected = 1;
        stats.bought += 1;
        const how = sends.length === 1 ? rnd.pick(['ok', 'ok', 'ok', 'ok', 'silent', 'throw', 'not-sent', 'hang']) : rnd.pick(['ok', 'silent', 'throw', 'not-sent']);
        w.submitPlan.push(how);
        if (how === 'hang') hung = w.hung();
        else if (how === 'ok' && rnd.chance(0.5)) w.statusPlan.push(rnd.pick([{ ok: true, status: 'processing', progress: 40 }, { ok: false, reason: 'sign-in' }, { ok: true, status: 'failed' }, { ok: false, reason: SECRET }]));
      } else if (send.quote === null) stats.refused += 1;
      sent.push(send);
      return ask(w, send.body, pickers[index % pickers.length]);
    });
    // An answer whose submit never returns is dropped, like a gateway that died.
    await (hung === null ? Promise.all(running) : Promise.race([Promise.all(running), hung]));
    w.submitPlan.length = 0;
    w.statusPlan.length = 0;
  };

  const anyQuote = () => (quotes.length === 0 ? null : rnd.pick(rnd.chance(0.7) ? quotes.slice(-3) : quotes));
  const replayed = (quote) => (rnd.chance(0.2) ? `${quote.text.replace(/\n/g, '\r\n')}  \r\n` : quote.text);
  const valid = (quote) => ({ quote, body: request(quote.entry, [...quote.turns.slice(0, -1), ['assistant', replayed(quote)], ['user', rnd.pick(WORDS)]], rnd.pick(SHAPES)) });

  const invalid = (quote) => {
    const turns = quote.turns;
    const body = (() => {
      switch (rnd.int(10)) {
        case 0: return request(quote.entry, [turns[0], ['assistant', quote.text.replace('Nothing has been bought.', 'Nothing has been bought!')], ['user', 'yes']]);
        case 1: {
          const other = quotes.find((candidate) => candidate !== quote);
          return request(quote.entry, [turns[0], ['assistant', quote.text.replace(quote.id, other ? other.id : 'Q-AAAAAAAAAAAAAAAA')], ['user', 'yes']]);
        }
        case 2: return request(quote.entry, [...turns, ['user', 'really'], ['user', 'yes']], rnd.pick(SHAPES));
        case 3: return request(quote.entry, [...turns, ['user', 'yes'], ['user', 'really']], rnd.pick(SHAPES));
        case 4: return request(quote.entry, [...turns, ['user', rnd.pick(NOT_WORDS)]], rnd.pick(SHAPES));
        case 5: return request(quote.entry === ENTRY ? OTHER : ENTRY, [...turns, ['user', 'yes']]);
        case 6: {
          const made = request(quote.entry, [...turns, ['user', 'yes']]);
          made.messages[3].content.push({ type: 'tool_use', id: 'toolu_1', name: 'read', input: { file_path: 'a.txt' } });
          return made;
        }
        case 7: {
          const made = request(quote.entry, [...turns, ['user', 'yes']], 'bare');
          made.messages[2].content.unshift({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' });
          return made;
        }
        case 8: return request(quote.entry, [['user', 'yes']], rnd.pick(SHAPES));
        default: return request(quote.entry, [turns[0], ['assistant', quote.text.slice(0, quote.text.lastIndexOf('\n'))], ['user', 'yes']]);
      }
    })();
    return { quote: null, body };
  };

  const steps = {
    async quote() {
      const on = Object.keys(ENTRIES).filter((id) => !w.off.has(id));
      if (on.length === 0) return;
      conversations += 1;
      const quote = await quoted(w, `Clip ${conversations} of sequence ${seed}`, rnd.pick(on));
      quotes.push({ ...quote, entry: quote.model, issuedAt: w.clock.time, expiresAt: w.clock.time + 600000, used: false, expected: 0 });
      sent.push({ quote: null, body: request(quote.model, [quote.turns[0]]) });
    },
    async confirm() {
      const quote = anyQuote();
      if (quote !== null) await deliver([valid(quote)]);
    },
    async repeat() {
      if (sent.length === 0) return;
      const again = rnd.pick(rnd.chance(0.7) ? sent.slice(-4) : sent);
      if (rnd.chance(0.5)) w.restart();
      await deliver([{ quote: again.quote, body: structuredClone(again.body) }]);
    },
    async restart() {
      w.restart();
    },
    async jump() {
      w.clock.time += rnd.chance(0.2) ? -rnd.int(90000) : rnd.pick([1000, 30000, 61000, 200000, 540000]) + rnd.int(1000);
    },
    async fork() {
      const quote = anyQuote();
      if (quote !== null) await deliver([valid(quote), valid(quote), valid(quote)], rnd.chance(0.5) ? [w.picker] : [w.another(), w.another(), w.picker]);
    },
    async expire() {
      const quote = anyQuote();
      if (quote === null) return;
      w.clock.time = quote.expiresAt + 1 + rnd.int(60000);
      await deliver([valid(quote)]);
    },
    async bad() {
      const quote = anyQuote();
      if (quote !== null) await deliver([invalid(quote)]);
    },
    async toggle() {
      if (rnd.chance(0.5)) w.exposed = !w.exposed && rnd.chance(0.5);
      else {
        const id = rnd.pick(Object.keys(ENTRIES));
        if (w.off.has(id) || rnd.chance(0.5)) w.off.delete(id);
        else w.off.add(id);
      }
    }
  };
  const menu = ['quote', 'quote', 'quote', 'confirm', 'confirm', 'confirm', 'confirm', 'repeat', 'repeat', 'repeat', 'restart', 'jump', 'jump', 'fork', 'expire', 'bad', 'bad', 'bad', 'toggle'];

  try {
    await steps.quote();
    for (step = 1; step <= 30; step += 1) {
      op = rnd.pick(menu);
      await steps[op]();
      check();
    }
  } catch (error) {
    error.message = `seed ${seed}, step ${step} (${op}): ${error.message}`;
    throw error;
  } finally {
    w.dispose();
  }
}

test('5. over 500 seeded sequences of quote, confirm, repeat, restart, clock jump, fork and expiry, submit is called at most once per quote and never for a quote that fails the checks', { timeout: 600000 }, async (t) => {
  const stats = { bought: 0, refused: 0 };
  for (let seed = 1; seed <= 500; seed += 1) await sequence(seed, stats);
  t.diagnostic(`500 sequences: ${stats.bought} purchases, ${stats.refused} requests that are not the confirmation of a quote`);
  // The sequences really buy and really refuse: the invariant is not empty.
  assert.ok(stats.bought >= 1000, `only ${stats.bought} purchases in 500 sequences`);
  assert.ok(stats.refused >= 1000, `only ${stats.refused} refused requests in 500 sequences`);
});

// ------------------------------- the checks, one by one -------------------------------

test('a confirmation that fails one of the checks buys nothing, writes nothing to the journal and leaves the quote for the one that passes', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const other = await quoted(w, 'A paper boat on a pond', OTHER);
  const [typed, answer] = quote.turns;
  const stray = 'There is nothing to confirm: a `yes` buys only when it is the one reply directly after a quote. Nothing was bought. Send the prompt again to get a quote.';
  const unmatched = 'I could not match your confirmation to a quote, so nothing was bought. Type `status Q-…` with the quote\'s id to see it, or type the prompt again for a new quote.';
  const quotes = w.calls.quote.length;

  const refused = async (body, sentence, change = () => {}, restore = () => {}) => {
    change();
    assert.equal(await ask(w, body), sentence);
    restore();
    assert.equal(w.calls.submit.length, 0);
    assert.equal(fs.readFileSync(w.files.journal, 'utf8'), '');
  };
  // C1: exactly one typed reply after the quote.
  await refused(request(ENTRY, [typed, answer, ['user', 'really'], ['user', 'yes']]), stray);
  await refused(request(ENTRY, [['user', 'yes']]), stray);
  // C2: the turn before it is the stored quote, word for word.
  await refused(request(ENTRY, [typed, ['assistant', quote.text.replace('856', '85')], ['user', 'yes']]), unmatched);
  await refused(request(ENTRY, [typed, ['assistant', quote.text.replace(quote.id, other.id)], ['user', 'yes']]), unmatched);
  await refused(request(ENTRY, [typed, ['assistant', quote.text.replace(quote.id, 'Q-AAAAAAAAAAAAAAAA')], ['user', 'yes']]), unmatched);
  await refused(request(ENTRY, [typed, ['assistant', `${quote.text}\nAnything else?`], ['user', 'yes']]), unmatched);
  const withTool = confirming(quote);
  withTool.messages[3].content.push({ type: 'tool_use', id: 'toolu_1', name: 'read', input: {} });
  await refused(withTool, unmatched);
  // A tool round or an attachment never buys.
  const withResult = confirming(quote, 'yes', 'bare');
  withResult.messages[2].content.unshift({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'yes' });
  await refused(withResult, 'This entry takes text only. Nothing was quoted or bought.');
  // C3: this entry, switched on now, within the ten minutes.
  await refused(request(OTHER, [...quote.turns, ['user', 'yes']]), 'This quote was made for another video entry, so nothing was bought. Send the prompt again to get a quote for this one.');
  await refused(confirming(quote), 'This video entry is switched off in DSHProxy. Nothing was quoted or bought. Switch it on with `dshproxy video entries`, then run `dshproxy dsh apply`.', () => w.off.add(ENTRY), () => w.off.delete(ENTRY));
  const expired = 'This quote is no longer valid: a quote stands for ten minutes. Nothing was bought. Send the prompt again for a new quote.';
  await refused(confirming(quote), expired, () => { w.clock.time += 600001; }, () => { w.clock.time -= 600001; });
  await refused(confirming(quote), expired, () => { w.clock.time -= 1; }, () => { w.clock.time += 1; });
  // C5: no profile lets agents pick the route. Anything but a plain "no" counts as exposed.
  const exposed = 'Nothing was bought: a DeepSeek Harness profile lets agents pick the paid video route. Run `dshproxy dsh verify`, fix what it reports, then send the prompt again for a new quote.';
  for (const value of [true, undefined, null, 0, 'false']) await refused(confirming(quote), exposed, () => { w.exposed = value; }, () => { w.exposed = false; });
  const options = w.options();
  const guarded = [create({ ...options, exposed: () => { throw new Error(SECRET); } }), create({ ...options, exposed: undefined })];
  for (const picker of guarded) assert.equal(await ask(w, confirming(quote), picker), exposed);
  assert.equal(w.calls.submit.length, 0);

  // Words that are not one of the six are prompts: each gets a quote of its own and buys nothing.
  for (const word of NOT_WORDS) assert.match(await ask(w, request(ENTRY, [...quote.turns, ['user', word]])), /^\*\*Quote: /);
  assert.equal(w.calls.quote.length, quotes + NOT_WORDS.length);
  assert.equal(w.calls.submit.length, 0);

  // On the last millisecond of its ten minutes the quote still buys, once.
  w.clock.time += 600000;
  assert.match(await ask(w, confirming(quote)), /^Buying one clip: /);
  assert.equal(submitsOf(w, quote.id), 1);
  assert.equal(w.calls.submit.length, 1);
});

test('what the one submit led to is what every later answer says, and nothing is sent again', async (t) => {
  const w = world(t);
  const cases = [
    ['silent', (id) => `Buying one clip: Seedance 2.5 - 720p - Krea, at most 856 units (quote ${id}).\n${unknownText(id)}`, unknownText],
    ['throw', (id) => `Buying one clip: Seedance 2.5 - 720p - Krea, at most 856 units (quote ${id}).\n${unknownText(id)}`, unknownText],
    ['not-sent', (id) => `Buying one clip: Seedance 2.5 - 720p - Krea, at most 856 units (quote ${id}).\nNothing was bought with quote ${id}: the price is now above the quoted amount. A quote is used once. Send the prompt again for a new one.`,
      (id) => `Nothing was bought with quote ${id}: the price is now above the quoted amount. A quote is used once. Send the prompt again for a new one.`]
  ];
  for (const [how, first, later] of cases) {
    const quote = await quoted(w, `A ${how} clip`);
    w.submitPlan.push(how);
    assert.equal(await ask(w, confirming(quote)), first(quote.id));
    for (let again = 0; again < 3; again += 1) {
      w.restart();
      w.clock.time += again * HOUR;
      assert.equal(await ask(w, confirming(quote)), later(quote.id));
    }
    assert.equal(submitsOf(w, quote.id), 1);
  }
  assert.equal(w.calls.status.length, 0);

  // An outcome that does not carry the claim's nonce is not believed (A7).
  const quote = await quoted(w, 'A stale outcome');
  w.submitPlan.push('hang');
  const hung = w.hung();
  w.picker.answer(confirming(quote), () => {});
  await hung;
  w.files.writeOutcome(quote.id, { state: 'submitted', nonce: 'f'.repeat(32), jobId: 'job-forged', status: 'completed' });
  w.restart();
  assert.equal(await ask(w, confirming(quote)), unknownText(quote.id));
  assert.equal(submitsOf(w, quote.id), 1);

  // A job that fails, one whose link cannot be verified, and one that is still running after twelve minutes.
  const failing = await quoted(w, 'A failing clip');
  w.statusPlan.push({ ok: true, status: 'failed' });
  const failed = await ask(w, confirming(failing));
  assert.ok(failed.endsWith(`\nThe job failed at Krea. Whether anything was charged is Krea's decision; check your balance. I did not send it again.\nFinished ${failing.id}`), failed);
  w.restart();
  assert.ok((await ask(w, confirming(failing))).endsWith(`: failed.\n\nThe job failed at Krea. Whether anything was charged is Krea's decision; check your balance. I did not send it again.\nFinished ${failing.id}`));

  for (const links of [undefined, [], ['http://clips.example/a.mp4'], ['https://user:pw@clips.example/a.mp4'], ['https://clips.example/a.mp4', 'https://clips.example/b.mp4'], ['https://clips.example/a.mp4) [x](https://evil.example/'], [SECRET]]) {
    const unlinked = await quoted(w, 'A clip without a link');
    w.statusPlan.push({ ok: true, status: 'completed', links });
    const text = await ask(w, confirming(unlinked));
    assert.ok(text.endsWith(`\nThe job is completed, but its link could not be verified. Open your Krea history.\nFinished ${unlinked.id}`), text);
    assert.doesNotMatch(text, /clips\.example|evil/);
  }

  const slow = await quoted(w, 'A slow clip');
  const running = { ok: true, status: 'processing', progress: 10 };
  w.statusPlan.push(...Array.from({ length: 60 }, () => running));
  const started = w.clock.time;
  const text = await ask(w, confirming(slow));
  const jobId = `job-${w.calls.submit.length}`;
  assert.ok(text.endsWith(`\nStill running after 12 minutes. Job ${jobId}. Send \`status\` to check it.`), text);
  assert.equal(w.clock.time - started, 720000);
  assert.equal((text.match(/\./g) || []).length >= 60, true);
  w.statusPlan.length = 0;
  // The next request finds the job and follows it to its end.
  w.restart();
  assert.match(await ask(w, confirming(slow)), new RegExp(`^Job ${jobId} \\(Seedance 2\\.5 - 720p - Krea, quote ${slow.id}\\): completed\\. Sent 12 minutes ago\\.\\n\\n\\[Open the clip\\]`));
  assert.equal(submitsOf(w, slow.id), 1);
  assert.equal(w.calls.submit.length, new Set(w.calls.submit.map((order) => order.id)).size);
});

test('an outcome file that is still being written is read again for two seconds, and then counts as unknown', async (t) => {
  const w = world(t);
  const outcomes = [];
  for (const finishes of [true, false]) {
    const quote = await quoted(w, `A clip whose outcome ${finishes ? 'is finished in time' : 'stays half written'}`);
    w.submitPlan.push('hang');
    const hung = w.hung();
    w.picker.answer(confirming(quote), () => {});
    await hung;
    const order = w.calls.submit.at(-1);
    // The child has created its outcome file and not written it yet.
    fs.writeFileSync(order.outcomeFile, '');
    w.restart();
    let sleeps = 0;
    w.onSleep = () => {
      sleeps += 1;
      if (finishes && sleeps === 3) fs.writeFileSync(order.outcomeFile, JSON.stringify({ state: 'submitted', nonce: order.nonce, jobId: 'job-half', status: 'queued' }));
    };
    const before = w.clock.time;
    const text = await ask(w, confirming(quote));
    w.onSleep = null;
    outcomes.push(text);
    if (finishes) assert.match(text, /^Job job-half \(/);
    else {
      assert.equal(text, unknownText(quote.id));
      assert.equal(w.clock.time - before, 2000);
    }
    assert.equal(submitsOf(w, quote.id), 1);
  }
  assert.equal(w.calls.submit.length, 2);
});

test('a client that goes away stops the answer, not the purchase record: the next request reports the job and nothing is sent again', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  let pieces = 0;
  await w.picker.answer(confirming(quote), () => {
    pieces += 1;
    if (pieces === 2) throw new Error(SECRET);
  });
  assert.equal(pieces, 2);
  assert.equal(w.calls.submit.length, 1);
  w.restart();
  assert.match(await ask(w, confirming(quote)), /^Job job-1 \(Seedance 2\.5 - 720p - Krea, quote Q-[A-Z2-9]{16}\): completed\./);
  assert.equal(w.calls.submit.length, 1);
});

// ------------------------------- the journal -------------------------------

const claimOf = (id, at) => ({ id, entry: ENTRY, amount: 856, unit: 'krea_units', cap: '856', claimedAt: at });
const recordsOf = (w) => fs.readFileSync(w.files.journal, 'utf8').split('\n').filter((line) => line !== '');

// Replaces one function of `fs` for the length of `work`.
async function withFs(name, replacement, work) {
  const original = fs[name];
  fs[name] = (...args) => replacement(original, ...args);
  try {
    return await work();
  } finally {
    fs[name] = original;
  }
}

test('the journal is created once, empty and exclusively; a claim is one line of its own, appended and never rewritten', async (t) => {
  const w = world(t);
  assert.equal(w.files.journal, path.join(w.home, 'video-picker', 'claims.log'));
  assert.equal(fs.readFileSync(w.files.journal, 'utf8'), '');

  const seen = [fs.readFileSync(w.files.journal)];
  const prefixed = () => {
    const now = fs.readFileSync(w.files.journal);
    assert.ok(now.subarray(0, seen.at(-1).length).equals(seen.at(-1)), 'the bytes that were there before are no longer the start of the journal');
    seen.push(now);
    return now;
  };
  const quotes = [];
  for (let index = 0; index < 4; index += 1) {
    const quote = await quoted(w, `Clip ${index}`);
    quotes.push(quote);
    const before = prefixed();
    await ask(w, confirming(quote));
    const added = prefixed().subarray(before.length).toString('utf8');
    // "\n" + one line of JSON + "\n", at most 4 KiB.
    assert.match(added, /^\n\{[^\n]+\}\n$/);
    assert.ok(Buffer.byteLength(added) <= 4096 + 2);
    const record = JSON.parse(added);
    assert.deepEqual(record, { id: quote.id, nonce: w.calls.submit[index].nonce, entry: ENTRY, amount: 856, unit: 'krea_units', cap: '856', claimedAt: record.claimedAt });
    // Repeats, restarts and a second picker on the folder add and change nothing.
    w.restart();
    await ask(w, confirming(quote));
    await ask(w, confirming(quotes[0]), w.another());
    assert.ok(prefixed().equals(seen.at(-2)));
  }
  assert.equal(recordsOf(w).length, 4);
  assert.deepEqual(fs.readdirSync(w.files.folder).sort(), ['claims.log', 'outcomes', 'quotes', 'results']);
});

test('a purchase is refused while the journal is younger than 60 seconds, and writes nothing', async (t) => {
  const w = world(t, { age: 0 });
  w.clock.time = Math.floor(w.born);
  const quote = await quoted(w);
  const young = 'The purchase record was created just now; try again in a minute. Nothing was bought.';
  for (const age of [0, 1000, 59999]) {
    w.clock.time = Math.floor(w.born) + age;
    assert.equal(await ask(w, confirming(quote)), young);
    // Through the store as well: the rule is where the claim is made.
    assert.deepEqual(w.files.claim(claimOf(quote.id, w.clock.time)), { held: false, young: true });
  }
  // A clock that says the journal is not born yet does not help either, and
  // a time that is not a time is no claim at all.
  assert.deepEqual(w.files.claim(claimOf(quote.id, Math.floor(w.born) - HOUR)), { held: false, young: true });
  assert.throws(() => w.files.claim(claimOf(quote.id, NaN)), { code: 'VIDEO_PICKER_CLAIM', appended: false });
  assert.equal(w.calls.submit.length, 0);
  assert.equal(fs.readFileSync(w.files.journal, 'utf8'), '');

  // The quote was not used: once the journal is a minute old it buys, once.
  w.clock.time = Math.ceil(w.born) + 60000;
  assert.match(await ask(w, confirming(quote)), /^Buying one clip: /);
  assert.equal(w.calls.submit.length, 1);

  // A restart does not make a new journal, so there is no new first minute.
  w.restart();
  const next = await quoted(w, 'A paper boat on a pond');
  assert.match(await ask(w, confirming(next)), /^Buying one clip: /);
  assert.equal(w.calls.submit.length, 2);
});

test('two pickers on one folder claim the same quote at the same moment: exactly one holds it', async (t) => {
  const w = world(t);
  const at = w.clock.time;
  const [a, b, c] = [store.open(w.home), store.open(w.home), store.open(w.home)];

  // One after the other.
  const first = 'Q-AAAAAAAAAAAAAAAA';
  const one = a.claim(claimOf(first, at));
  const two = b.claim(claimOf(first, at));
  const three = a.claim(claimOf(first, at));
  assert.deepEqual([one.held, two.held, three.held], [true, false, false]);
  assert.equal(two.claim.record.nonce, one.nonce);
  assert.equal(three.claim.record.nonce, one.nonce);
  assert.equal(recordsOf(w).length, 3);

  // Each inside the other's claim: B and C append and read back while A is
  // between its own append and its own read-back.
  const second = 'Q-BBBBBBBBBBBBBBBB';
  const inner = [];
  let nested = false;
  const outer = await withFs('fsyncSync', (original, handle) => {
    original(handle);
    if (nested) return;
    nested = true;
    inner.push(b.claim(claimOf(second, at)), c.claim(claimOf(second, at)));
  }, () => a.claim(claimOf(second, at)));
  assert.deepEqual([outer.held, ...inner.map((claim) => claim.held)], [true, false, false]);
  for (const claim of inner) assert.equal(claim.claim.record.nonce, outer.nonce);

  // B gets its line in between A's look at the journal and A's append.
  const third = 'Q-CCCCCCCCCCCCCCCC';
  let early = null;
  const late = await withFs('openSync', (original, file, flags, ...rest) => {
    if (file === w.files.journal && early === null) {
      early = false;
      early = b.claim(claimOf(third, at));
    }
    return original(file, flags, ...rest);
  }, () => a.claim(claimOf(third, at)));
  assert.deepEqual([early.held, late.held], [true, false]);
  assert.equal(late.claim.record.nonce, early.nonce);

  // Through the pickers: another gateway's line lands after this one found
  // the quote unused and before its own line. It sends nothing.
  const quote = await quoted(w);
  const theirs = { ...claimOf(quote.id, w.clock.time), nonce: 'ab'.repeat(16) };
  let landed = false;
  const text = await withFs('openSync', (original, file, flags, ...rest) => {
    if (file === w.files.journal && typeof flags === 'number' && !landed) {
      landed = true;
      fs.appendFileSync(w.files.journal, `\n${JSON.stringify(theirs)}\n`);
    }
    return original(file, flags, ...rest);
  }, () => ask(w, confirming(quote)));
  assert.equal(landed, true);
  assert.equal(w.calls.submit.length, 0);
  assert.equal(text, `This quote is already being sent.${'.'.repeat(180)}\n${unknownText(quote.id)}`);
  assert.equal(recordsOf(w).filter((line) => line.includes(quote.id)).length, 2);

  // And two pickers asked at once through their own stores.
  const shared = await quoted(w, 'A paper boat on a pond');
  const answers = await Promise.all([ask(w, confirming(shared), w.another()), ask(w, confirming(shared), w.another())]);
  assert.equal(submitsOf(w, shared.id), 1);
  assert.equal(answers.filter((answer) => answer.startsWith('Buying one clip: ')).length, 1);
});

test('a journal whose last line is torn: that quote is claimed with an unknown outcome, and the next quote is claimed on a line of its own', async (t) => {
  const w = world(t);
  const torn = await quoted(w, 'Clip one');
  const next = await quoted(w, 'Clip two');
  const cut = await quoted(w, 'Clip three');
  // A record cut in the middle, with no final line break.
  const fragment = `{"id":"${torn.id}","nonce":"0123456789abcdef0123","ent`;
  fs.appendFileSync(w.files.journal, `\n${fragment}`);

  assert.deepEqual(w.files.claimOf(torn.id), { id: torn.id, record: null });
  assert.equal(await ask(w, confirming(torn)), unknownText(torn.id));
  assert.equal(w.calls.submit.length, 0);
  assert.equal(fs.readFileSync(w.files.journal, 'utf8'), `\n${fragment}`, 'a question about a claimed quote writes nothing');

  // The next quote can be claimed, and its record is not glued to the torn line.
  assert.match(await ask(w, confirming(next)), /^Buying one clip: /);
  assert.equal(submitsOf(w, next.id), 1);
  const lines = recordsOf(w);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], fragment);
  assert.equal(JSON.parse(lines[1]).id, next.id);
  assert.equal(w.files.claimOf(next.id).record.nonce, w.calls.submit[0].nonce);

  // The torn quote stays claimed, whatever is appended after it.
  w.restart();
  assert.equal(await ask(w, confirming(torn)), unknownText(torn.id));
  assert.deepEqual(w.files.claim(claimOf(torn.id, w.clock.time)).held, false);
  assert.equal(submitsOf(w, torn.id), 0);

  // A line torn before the end of the id names no quote: whoever wrote it
  // never read it back, so it sent nothing, and the quote is still unused.
  fs.appendFileSync(w.files.journal, `\n{"id":"${cut.id.slice(0, 10)}`);
  assert.equal(w.files.claimOf(cut.id), null);
  assert.match(await ask(w, confirming(cut)), /^Buying one clip: /);
  assert.equal(submitsOf(w, cut.id), 1);
  assert.equal(JSON.parse(recordsOf(w).at(-1)).id, cut.id);
});

test('a line that is not a record but names a quote counts as a claim of it; a line that names none is skipped', async (t) => {
  const w = world(t);
  const lines = (id) => [
    `garbage ${id} garbage`,
    `{"id":"${id}"}`,
    `["${id}"]`,
    `{"id":"${id}","nonce":"NOT-HEX","entry":"${ENTRY}","amount":856,"unit":"krea_units","cap":"856","claimedAt":${w.clock.time}}`,
    `{"id":"Q-ZZZZZZZZZZZZZZZZ","nonce":"${'cd'.repeat(16)}","entry":"${ENTRY}","amount":856,"unit":"krea_units","cap":"856","claimedAt":${w.clock.time},"note":"${id}"}`,
    `\u0000\u0000\u0000${id}\u0000`,
    `${'x'.repeat(5000)}${id}`
  ];
  const count = lines('Q-AAAAAAAAAAAAAAAA').length;
  for (let index = 0; index < count; index += 1) {
    const quote = await quoted(w, `Clip ${index}`);
    fs.appendFileSync(w.files.journal, `${lines(quote.id)[index]}\n`);
    assert.deepEqual(w.files.claimOf(quote.id), { id: quote.id, record: null }, `line ${index}`);
    const claim = w.files.claim(claimOf(quote.id, w.clock.time));
    assert.deepEqual([claim.held, claim.claim.record], [false, null], `line ${index}`);
    assert.equal(await ask(w, confirming(quote)), unknownText(quote.id), `line ${index}`);
  }
  assert.equal(w.calls.submit.length, 0);

  // Lines that are not records and name no quote of ours change nothing.
  const quote = await quoted(w, 'A paper boat on a pond');
  fs.appendFileSync(w.files.journal, 'not a record\n{"id":7}\n\u0000\u0000\u0000\n{"id":"Q-YYYYYYYYYYYYYYYY","nonce":\n\n[]\n');
  assert.equal(w.files.claimOf(quote.id), null);
  assert.match(await ask(w, confirming(quote)), /^Buying one clip: /);
  assert.equal(submitsOf(w, quote.id), 1);
  assert.equal(w.calls.submit.length, 1);
});

test('a failed append, flush or read-back sends nothing, and a quote whose line may be in the journal is spent', async (t) => {
  const w = world(t);
  const spent = 'The purchase could not be recorded, so nothing was sent. This quote cannot be used again; send the prompt again for a new one.';
  const broken = (code) => Object.assign(new Error(`${code}: ${SECRET}`), { code });
  let quote;
  let reads;
  const faults = [
    ['the flush fails', 'fsyncSync', () => { throw broken('EIO'); }],
    ['the read-back fails', 'readFileSync', (original, file, ...rest) => {
      // The first read of the journal is the look before the claim; the second is the read-back.
      if (file === w.files.journal) {
        reads += 1;
        if (reads === 2) throw broken('EIO');
      }
      return original(file, ...rest);
    }],
    ['the read-back does not show the line', 'readFileSync', (original, file, ...rest) => {
      if (file === w.files.journal) {
        reads += 1;
        if (reads === 2) return '';
      }
      return original(file, ...rest);
    }],
    ['the write is cut short', 'writeSync', (original, handle, data, offset, length) => original(handle, data, offset, Math.floor(length / 2))],
    ['closing fails', 'closeSync', (original, handle) => { original(handle); throw broken('EIO'); }]
  ];
  for (const [name, method, fault] of faults) {
    quote = await quoted(w, `Clip where ${name}`);
    reads = 0;
    assert.equal(await withFs(method, fault, () => ask(w, confirming(quote))), spent, name);
    assert.equal(w.calls.submit.length, 0, name);
    // The same request again, with nothing failing: still nothing is sent.
    for (let again = 0; again < 2; again += 1) {
      w.restart();
      const text = await ask(w, confirming(quote));
      assert.ok(text === unknownText(quote.id) || text === `This quote is already being sent.${'.'.repeat(180)}\n${unknownText(quote.id)}` || text === spent, `${name}: ${text}`);
    }
    assert.equal(w.calls.submit.length, 0, name);
  }

  // Nothing reached the journal (the write failed outright, or the journal
  // could not be opened for appending): nothing is sent by that request. The
  // quote was not used, so the same request can still make the one purchase.
  const refuse = (original, file, flags, ...rest) => {
    if (file === w.files.journal && typeof flags === 'number') throw broken('EACCES');
    return original(file, flags, ...rest);
  };
  for (const [name, method, fault, sentence] of [
    ['the write fails', 'writeSync', () => { throw broken('ENOSPC'); }, spent],
    ['the journal cannot be opened', 'openSync', refuse, 'The purchase could not be recorded, so nothing was sent.']
  ]) {
    quote = await quoted(w, `Clip where ${name}`);
    const before = fs.readFileSync(w.files.journal);
    assert.equal(await withFs(method, fault, () => ask(w, confirming(quote))), sentence, name);
    assert.equal(submitsOf(w, quote.id), 0, name);
    assert.ok(fs.readFileSync(w.files.journal).equals(before), name);
    for (let again = 0; again < 3; again += 1) {
      w.restart();
      await ask(w, confirming(quote));
      assert.equal(submitsOf(w, quote.id), 1, name);
    }
  }

  // The journal is gone: a claim never creates it, and nothing is sent.
  quote = await quoted(w, 'Clip where the journal is gone');
  fs.rmSync(w.files.journal);
  assert.equal(await ask(w, confirming(quote)), 'The purchase record could not be read, so nothing was sent.');
  assert.throws(() => w.files.claim(claimOf(quote.id, w.clock.time)), { code: 'VIDEO_PICKER_CLAIM', appended: false });
  assert.equal(fs.existsSync(w.files.journal), false);
  assert.equal(w.calls.submit.length, 2);
});

// ------------------------------- several processes -------------------------------

// Each child reports that it is ready and then waits for the file `go`, so
// that all of them claim within the same millisecond or so. This is the only
// test that starts processes, and none of them can call a submit: they load
// the store alone.
const CLAIMER = `
  const fs = require('node:fs');
  const [go, storeFile, home, id, at] = process.argv.slice(1);
  const files = require(storeFile).open(home);
  fs.writeFileSync(go + '.ready.' + process.pid, '');
  const look = () => {
    if (!fs.existsSync(go)) return setImmediate(look);
    const claim = files.claim({ id, entry: 'seedance-2.5/720p/krea', amount: 856, unit: 'krea_units', cap: '856', claimedAt: Number(at) });
    process.stdout.write(JSON.stringify({ held: claim.held, nonce: claim.held ? claim.nonce : claim.claim.record.nonce }));
  };
  look();`;

test('eight processes claim the same quote on the same folder at the same moment, twenty times over: each time exactly one holds the claim', { timeout: 300000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-picker-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const files = store.open(home);
  files.init();
  const at = Math.ceil(fs.statSync(files.journal).birthtimeMs) + HOUR;
  const bytes = generator(20261123);
  const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const COUNT = 8;

  for (let round = 0; round < 20; round += 1) {
    const id = store.newId((count) => Buffer.from(Array.from({ length: count }, () => bytes.int(256))));
    const go = path.join(home, `go-${round}`);
    const runs = Array.from({ length: COUNT }, () => new Promise((resolve) => {
      const proc = spawn(process.execPath, ['-e', CLAIMER, go, STORE, home, id, String(at)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk; });
      proc.stderr.on('data', (chunk) => { stderr += chunk; });
      proc.on('close', (status) => resolve({ status, stdout, stderr }));
    }));
    const deadline = Date.now() + 60000;
    while (fs.readdirSync(home).filter((name) => name.startsWith(`go-${round}.ready.`)).length < COUNT) {
      assert.ok(Date.now() < deadline, 'the child processes did not start');
      await pause(5);
    }
    fs.writeFileSync(go, '');
    const results = await Promise.all(runs);
    for (const result of results) assert.deepEqual([result.status, result.stderr], [0, ''], `round ${round}`);
    const claims = results.map((result) => JSON.parse(result.stdout));
    assert.equal(claims.filter((claim) => claim.held).length, 1, `round ${round}: ${claims.filter((claim) => claim.held).length} processes hold the claim of ${id}`);
    // All of them agree on who that is, and it is the first line for the quote.
    const lines = fs.readFileSync(files.journal, 'utf8').split('\n').filter((line) => line.includes(id));
    assert.equal(lines.length, COUNT, `round ${round}`);
    assert.deepEqual([...new Set(claims.map((claim) => claim.nonce))], [JSON.parse(lines[0]).nonce], `round ${round}`);
  }
  assert.equal(fs.readFileSync(files.journal, 'utf8').split('\n').filter((line) => line !== '').length, 20 * COUNT);
});

// ------------------------------- any body at all -------------------------------

test('whatever the body is, classify and answer do not throw, nothing is bought and no quote is asked for', { timeout: 120000 }, async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const big = 'x'.repeat(2 * 1024 * 1024);
  const history = request(ENTRY, quote.turns).messages;
  const user = (content) => ({ role: 'user', content });
  const withMessages = (messages, more = {}) => ({ model: ENTRY, system: SYSTEM, tools: TOOLS, stream: true, ...more, messages });
  const cyclic = { model: ENTRY };
  cyclic.messages = [cyclic];
  const throwing = { model: ENTRY, get messages() { throw new Error(SECRET); } };
  const proxied = new Proxy({}, { get() { throw new Error(SECRET); }, has() { throw new Error(SECRET); }, getPrototypeOf() { throw new Error(SECRET); } });

  const bodies = [
    // not a request at all
    undefined, null, 7, true, 'yes', big, [], [withMessages([user('yes')])], () => {}, Symbol('yes'), cyclic, throwing, proxied,
    // missing or empty messages, or messages that are not a list
    {}, { model: ENTRY }, withMessages(undefined), withMessages(null), withMessages([]), withMessages('yes'), withMessages(7), withMessages({ 0: user('yes'), length: 1 }),
    // system as a list, a string, a number, missing; content as a string
    withMessages([user('yes')]), withMessages([user('yes')], { system: 'You are an agent.' }), withMessages([user('yes')], { system: 7 }), withMessages([user('yes')], { system: undefined }),
    withMessages([user('')]), withMessages([user('   ')]), withMessages([user('--help')]), withMessages([user('A\u202Eclip')]), withMessages([user(REMINDER)]),
    // content as a number, null, missing, an object, a list of things that are not blocks
    withMessages([user(7)]), withMessages([user(null)]), withMessages([{ role: 'user' }]), withMessages([user({ type: 'text', text: 'yes' })]), withMessages([user(true)]),
    withMessages([user([null])]), withMessages([user(['yes'])]), withMessages([user([7])]), withMessages([user([{ type: 'text' }])]), withMessages([user([{ type: 'text', text: 7 }])]),
    withMessages([user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'yes' }])]),
    withMessages([user([])]),
    // a 2 MB string, wherever one can be
    withMessages([user(big)]), withMessages([user([{ type: 'text', text: big }])]), withMessages([...history, user(big)]),
    withMessages([history[0], { role: 'assistant', content: big }, user('yes')]), withMessages([user('yes')], { system: big }), withMessages([user('yes')], { model: big }),
    // messages that are not messages
    withMessages([null]), withMessages(['yes']), withMessages([7]), withMessages([[]]), withMessages([{ role: 'system', content: 'yes' }]), withMessages([{ role: 'tool', content: 'yes' }]), withMessages([{ content: 'yes' }]),
    // the real quote, followed or preceded by something malformed: a "yes" that must not buy
    withMessages([...history, user('yes'), user(null)]), withMessages([...history, user('yes'), null]), withMessages([null, ...history, user('yes')]),
    withMessages([...history, user(7), user('yes')]), withMessages([...history, user([{ type: 'text', text: 'yes' }, null])]), withMessages([...history, { role: 'function', content: 'yes' }, user('yes')]),
    withMessages([history[0], { role: 'assistant', content: 7 }, user('yes')]), withMessages([history[0], { role: 'assistant', content: null }, user('yes')]),
    withMessages([history[0], { role: 'assistant', content: [] }, user('yes')]), withMessages([history[0], { role: 'assistant', content: [quote.text] }, user('yes')]),
    withMessages([history[0], { role: 'assistant' }, user('yes')]),
    // the model as anything
    ...[undefined, null, 7, {}, [], '', 'constructor', '__proto__', 'toString', 'seedance-2.5', `${ENTRY} `, ENTRY.toUpperCase()].map((model) => withMessages([...history, user('yes')], { model }))
  ];

  for (const [index, body] of bodies.entries()) {
    let kind;
    assert.doesNotThrow(() => { kind = classify(body).kind; }, `classify threw on body ${index}`);
    assert.ok(['malformed', 'attachment', 'silent', 'confirm', 'stray-confirm', 'prompt'].includes(kind), `body ${index}: ${kind}`);
    const text = await ask(w, body);
    assert.ok(text.length < 400, `body ${index}: ${text.slice(0, 200)}`);
    assert.doesNotMatch(text, /Quote Q-|Buying/, `body ${index}`);
    assert.equal(w.calls.submit.length, 0, `body ${index} bought`);
    assert.equal(w.calls.quote.length, 1, `body ${index} asked for a quote`);
  }
  assert.equal(fs.readFileSync(w.files.journal, 'utf8'), '');
  assert.equal(w.calls.status.length, 0);

  // The quote is still there for the one request that is a confirmation.
  assert.match(await ask(w, withMessages([...history, user('yes')])), /^Buying one clip: /);
  assert.equal(w.calls.submit.length, 1);
});

test('the picker cannot be made without its seams, and its id alphabet has no look-alike characters', (t) => {
  const w = world(t);
  const options = w.options();
  for (const broken of [undefined, {}, { ...options, home: '' }, { ...options, home: 7 }, { ...options, ops: undefined }, { ...options, ops: { quote() {}, status() {} } }, { ...options, entries: new Map() }, { ...options, clock: { now: Date.now } }, { ...options, random: 7 }, { ...options, log: 'x' }]) {
    assert.throws(() => create(broken), /video picker/);
  }
  const ids = new Set();
  const bytes = generator(9);
  for (let index = 0; index < 2000; index += 1) ids.add(store.newId((count) => Buffer.from(Array.from({ length: count }, () => bytes.int(256)))));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^Q-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{16}$/);
  assert.equal([...ids].join('').replace(/Q-/g, '').split('').filter((letter) => 'ILOU01'.includes(letter)).length, 0);
  // A source of bytes that cannot give an id is an error, not a loop.
  assert.throws(() => store.newId(() => Buffer.alloc(16, 255)), /No quote id/);
  assert.throws(() => store.newId(() => 'not bytes'), /No quote id/);
  // Only an id of the exact form ever becomes part of a path.
  for (const id of ['..\\..\\x', '../x', 'Q-aaaaaaaaaaaaaaaa', 'Q-AAAAAAAAAAAAAAAA.json', '', undefined, 7]) {
    assert.throws(() => w.files.readQuote(id), /Not a quote id/);
    assert.throws(() => w.files.outcomeFile(id), /Not a quote id/);
    assert.throws(() => w.files.claimOf(id), /Not a quote id/);
  }
});
