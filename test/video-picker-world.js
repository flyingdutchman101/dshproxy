'use strict';
// Shared by the video picker tests (it holds no test of its own): a throwaway
// data folder with a picker on it, a clock that only moves when the picker
// waits or the test moves it, fakes that count their calls, and requests as
// DeepSeek Harness sends them. No provider, no network, no credential.
//
// The only seam is create(...).answer(body, write). "The gateway restarted"
// is a second create() on the same folder. The fake submit plays the child
// process: like the real one it writes the outcome file itself, with the
// claim's nonce.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PICKER = path.join(__dirname, '..', 'src', 'video', 'picker');
const STORE = path.join(PICKER, 'store.js');
const { create } = require(PICKER);
const store = require(STORE);

const ENTRIES = {
  'seedance-2.5/720p/krea': { model: 'seedance-2.5', resolution: '720p', route: 'krea', label: 'Seedance 2.5 - 720p - Krea', unit: 'krea_units' },
  'wan-3.0/1080p/krea': { model: 'wan-3.0', resolution: '1080p', route: 'krea', label: 'Wan 3.0 - 1080p - Krea', unit: 'krea_units' }
};
const ENTRY = 'seedance-2.5/720p/krea';
const OTHER = 'wan-3.0/1080p/krea';
const PROMPT = 'A red ball rolls slowly across a wooden table';
const SECRET = 'synthetic-SECRET-41c7';
const HOUR = 3600000;
// A ceiling that never gets in the way of a test that is not about it.
const WIDE = { clips: 1000, krea_units: 1e12, usd_micros: 1e12, callirra_credits: 1e12 };
const DEFAULT_CEILING = { clips: 10, krea_units: 15000, usd_micros: 20000000, callirra_credits: 2000 };

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

// Time that passes only when something waits for it. `sleep` and `after` put
// a timer on one list; whenever nothing else can run, the earliest timer is
// taken off, the time is set to its moment and it fires. So two things that
// wait at the same moment share the time, as with a real clock, and no test
// waits for real. `onTimer` is called before each timer fires.
function virtualClock() {
  const clock = { time: 0, onTimer: null };
  let timers = [];
  let order = 0;
  let running = false;
  const step = () => {
    timers = timers.filter((timer) => timer.live);
    if (timers.length === 0) {
      running = false;
      return;
    }
    let next = timers[0];
    for (const timer of timers) if (timer.due < next.due || (timer.due === next.due && timer.order < next.order)) next = timer;
    next.live = false;
    if (next.due > clock.time) clock.time = next.due;
    if (clock.onTimer) clock.onTimer();
    next.fn();
    setImmediate(step);
  };
  clock.now = () => clock.time;
  clock.after = (ms, fn) => {
    assert.ok(Number.isInteger(ms) && ms > 0, `a wait of ${ms}`);
    const timer = { due: clock.time + ms, order: order += 1, fn, live: true };
    timers.push(timer);
    if (!running) {
      running = true;
      setImmediate(step);
    }
    return () => { timer.live = false; };
  };
  clock.sleep = (ms) => new Promise((resolve) => { clock.after(ms, resolve); });
  clock.waiting = () => timers.filter((timer) => timer.live).length;
  return clock;
}

// `age` is how old the journal is when the test starts. `purchases` and
// `ceiling` are what the settings file holds (`settings: false`: no file).
function makeWorld({ seed = 1, age = HOUR, purchases = true, ceiling = {}, settings = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-picker-'));
  const bytes = generator(seed);
  const w = {
    home, files: store.open(home), logs: [], calls: { quote: [], submit: [], status: [] },
    submitPlan: [], statusPlan: [], off: new Set(), more: {}, exposed: false, onHang: null,
    settingsFile: path.join(home, 'video-picker', 'settings.json'),
    offer: () => ({ ok: true, amount: 856, unit: 'krea_units', estimated: false, available: 97909.73 })
  };
  w.clock = virtualClock();
  Object.defineProperty(w, 'onSleep', { get: () => w.clock.onTimer, set: (hook) => { w.clock.onTimer = hook; } });
  // The settings as a file on disk, written the way a person or the command would leave it.
  w.setSettings = (value) => {
    fs.mkdirSync(path.dirname(w.settingsFile), { recursive: true });
    fs.writeFileSync(w.settingsFile, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  w.settings = (change = {}) => {
    const now = fs.existsSync(w.settingsFile) ? JSON.parse(fs.readFileSync(w.settingsFile, 'utf8')) : { purchases: false, ceiling: { ...DEFAULT_CEILING } };
    w.setSettings({ purchases: change.purchases === undefined ? now.purchases : change.purchases, ceiling: { ...now.ceiling, ...(change.ceiling || {}) } });
  };
  if (settings) w.setSettings({ purchases, ceiling: { ...WIDE, ...ceiling } });

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
      // A function plays a check that takes its time.
      if (typeof planned === 'function') return planned(request);
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
  // The journal's header takes its time from the injected clock and the file
  // has its creation time from the system, so the clock starts at the real
  // time. `born` is the later of the two: the moment the journal's age counts from.
  w.clock.time = Date.now();
  w.restart();
  w.header = JSON.parse(fs.readFileSync(w.files.journal, 'utf8').split('\n')[0]);
  w.born = Math.max(Math.ceil(fs.statSync(w.files.journal).birthtimeMs), w.header.createdAt);
  w.clock.time = w.born + age;
  w.dispose = () => fs.rmSync(home, { recursive: true, force: true });
  return w;
}

function world(t, options) {
  const w = makeWorld(options);
  t.after(w.dispose);
  return w;
}

// The journal without its header line: the claims, as text and as lines.
const claimsText = (w) => {
  const text = fs.readFileSync(w.files.journal, 'utf8');
  return text.slice(text.indexOf('\n') + 1);
};
const recordsOf = (w) => claimsText(w).split('\n').filter((line) => line !== '');

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

// What the Harness asks the picked model on its own account, in the frames
// the facts file records (research/dsh-model-facts.md, section 4).
// Title: no tools, a system prompt and one user text of its own.
const TITLE_SYSTEM = 'Create a concise title for an AI coding-assistant session. Answer with the title only.';
const TITLE_FRAME = 'Generate the session title from this JSON array of human messages:';
function titleRequest(model, typed, { system = TITLE_SYSTEM, frame = TITLE_FRAME } = {}) {
  return { model, max_tokens: 256, stream: true, system, messages: [{ role: 'user', content: [{ type: 'text', text: `${frame}\n${JSON.stringify(typed)}` }] }] };
}
// Compaction: the conversation so far, and a last user message with the instruction.
const COMPACTION_FRAME = 'You are now acting as a compaction engine';
function compactionRequest(model, turns, { frame = COMPACTION_FRAME } = {}) {
  const body = request(model, turns, 'bare');
  body.messages.push({ role: 'user', content: [{ type: 'text', text: `${frame}. Summarize the conversation above so that the work can continue from the summary alone.` }] });
  return body;
}
const GOAL_ROUND = '<goal_round>\nRound 2 of the goal "Make three clips". Continue working toward the objective.\n</goal_round>';
const SCHEDULE_REMINDER = '[SCHEDULE REMINDER] The scheduled task "Morning clip" is due now.\nA red ball rolls slowly across a wooden table';

async function quoted(w, prompt = PROMPT, model = ENTRY, before = []) {
  const text = await ask(w, request(model, [...before, ['user', prompt]]));
  const found = /\nQuote (Q-[A-Z2-9]{16})$/.exec(text);
  assert.ok(found, `not a quote: ${text}`);
  return { id: found[1], text, prompt, model, turns: [...before, ['user', prompt], ['assistant', text]] };
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

module.exports = {
  PICKER, STORE, create, store, ENTRIES, ENTRY, OTHER, PROMPT, SECRET, HOUR, WIDE, DEFAULT_CEILING, SYSTEM, TOOLS, REMINDER, sampled,
  TITLE_SYSTEM, TITLE_FRAME, COMPACTION_FRAME, GOAL_ROUND, SCHEDULE_REMINDER, titleRequest, compactionRequest,
  generator, virtualClock, makeWorld, world, claimsText, recordsOf, clean, ask, request, quoted, confirming, submitsOf, unknownText, withFs
};
