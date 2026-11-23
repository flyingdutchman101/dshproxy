'use strict';
// The child process of the video picker, and the function that starts it.
//
// The gateway process never holds a provider key or the Krea sign-in. When a
// video entry needs a quote, a purchase or a job's state, the gateway starts
// this file as a process of its own (`spawnChild`), writes one line of JSON
// to its standard input and reads one line back. The child makes the real
// call through the video command, `run(args, out, { env })`, exactly once.
//
// For a purchase the child itself writes the outcome file, once and flushed,
// before it prints anything: if the gateway stops while the child is working,
// the job id is still on disk.
//
// What leaves the child, on its one line and in the outcome file, is a closed
// set of words and checked fields: a job id, a status word, numbers, a date,
// and one https link without a user name or password. The text of an error,
// and anything a process below this one wrote, never leaves it.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ARGS = 16;
const KINDS = ['quote', 'submit', 'status'];
const WORKSPACE_ROUTE = 'krea';

// The forms the video command itself accepts.
const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const ROUTE = /^[a-z][a-z0-9-]{0,63}$/;
const RESOLUTION = /^[A-Za-z0-9]{1,16}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATUS = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_PROMPT_BYTES = 16000;
const CAPS = {
  krea_units: { flag: '--max-units', form: /^\d{1,9}(?:\.\d{1,6})?$/ },
  usd_micros: { flag: '--max-usd', form: /^\d{1,6}(?:\.\d{1,6})?$/ },
  callirra_credits: { flag: '--max-credits', form: /^\d{1,6}$/ },
};

// Printable text without spaces: hexadecimal, base64 and a UUID all fit.
const NONCE = /^[\x21-\x7e]{1,256}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINK_LENGTH = 8192;
// Statuses under which a provider hands out the finished clip.
const FINISHED = ['completed', 'succeeded'];
const REASONS = ['sign-in', 'refused', 'bad-request', 'over-cap', 'no-key'];

// The environment of the child: these names and no others, each copied as it
// is when it is set. See environment().
const ENVIRONMENT = Object.freeze(['SystemRoot', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'USERPROFILE', 'DSHPROXY_HOME']);
// The same on macOS (docs/work/0014-macos-port, stage B):
//   HOME               the default data folder, and where the Krea helper keeps
//                      its sign-in (~/Library/Application Support/DSHProxy).
//   TMPDIR             the temporary folder.
//   DSHPROXY_HOME      the data folder: saved video keys and their master key.
//   DSHPROXY_KEYCHAIN  the keychain that wraps the master key, when not the
//                      login Keychain (src/keywrap-darwin.js).
const MAC_ENVIRONMENT = Object.freeze(['HOME', 'TMPDIR', 'DSHPROXY_HOME', 'DSHPROXY_KEYCHAIN']);
const KEY_VARIABLES = Object.freeze(['VIDEOROUTER_API_KEY', 'KOVAPI_API_KEY', 'CALLIRRA_API_KEY']);

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const amount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

// ------------------------- which failures are "not sent" -------------------------

// A failed purchase counts as "nothing was sent" only when the video command
// failed with one of these sentences. Each is produced before the paid
// request is dispatched:
//
//   sign-in      src/video/workspace.js, from the Krea helper's own word that
//                there is no usable sign-in; the helper has no token then.
//   refused      src/video/workspace.js, from the helper's refusal. The helper
//                (src/krea-helper/mcp.js) refuses only before the paid call:
//                price above the cap, balance, schema. Every failure of the
//                paid call itself is reported as unknown there.
//   bad-request  the command, the catalog and the transport turning down the
//                model, route, resolution, prompt or key before any request.
//   over-cap     src/video/command.js, the published price against the cap.
//   no-key       src/video/keys.js: no key, or a saved key that cannot be read.
//
// The list is closed. Any other failure, including one that happens to be
// harmless, is an unknown outcome: saying "not sent" wrongly could let a clip
// be bought twice, saying "unknown" wrongly only asks the user to look.
// test/video-picker-child.test.js produces each sentence with the real module
// that owns it, so a sentence reworded there fails that test.
const NOT_SENT = [
  { reason: 'sign-in', starts: ['Krea workspace sign-in required.'] },
  { reason: 'refused', starts: ['Krea refused the request'] },
  { reason: 'bad-request',
    starts: ['Krea workspace OAuth requires explicit workspace parameters.', 'Unsupported video route for ', 'Unsupported video resolution for '],
    exact: ['Unknown video model', 'Invalid video route or model', 'Invalid video prompt', 'Invalid video provider credential'],
    ends: [': it takes no resolution.'] },
  { reason: 'over-cap', exact: ['The quote exceeds --max-usd; no job submitted.', 'Insufficient credit budget; no job submitted.'] },
  { reason: 'no-key', ends: ['No request sent.'] },
];

// The reason code of a failure the video command threw, or null when it is
// not on the list. Only a real Error with a text message can be on it.
function reasonOf(error) {
  let message;
  try {
    message = error instanceof Error ? error.message : undefined;
  } catch {
    return null;
  }
  if (typeof message !== 'string' || !message) return null;
  for (const { reason, starts = [], exact = [], ends = [] } of NOT_SENT) {
    if (exact.includes(message) || starts.some((text) => message.startsWith(text)) || ends.some((text) => message.endsWith(text))) return reason;
  }
  return null;
}

// --------------------------------- checked fields ---------------------------------

// One https link without a user name, a password or a fragment, and without
// any character that could end a Markdown link or start markup. Returns the
// link, or undefined: an unusable link is left out, never passed on.
function linkOf(value) {
  if (typeof value !== 'string' || value.length > MAX_LINK_LENGTH || !value.startsWith('https://') || /[\s\x00-\x1f\x7f()[\]<>"'`\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined;
    return /[\s()[\]<>"'`\\]/.test(url.href) ? undefined : url.href;
  } catch {
    return undefined;
  }
}

// A job as it is passed on: { jobId, status } and, where they are valid,
// outputUrl (a finished job only), reservedCredits and chargedUsd. Null when
// the id or the status is not one.
function cleanJob(value) {
  if (!record(value) || typeof value.jobId !== 'string' || !JOB_ID.test(value.jobId) || typeof value.status !== 'string' || !STATUS.test(value.status)) return null;
  const job = { jobId: value.jobId, status: value.status };
  const link = FINISHED.includes(value.status) ? linkOf(value.outputUrl) : undefined;
  if (link) job.outputUrl = link;
  if (amount(value.chargedUsd)) job.chargedUsd = value.chargedUsd;
  if (amount(value.reservedCredits)) job.reservedCredits = value.reservedCredits;
  return job;
}

// A quote as it is passed on, in the unit of its route:
//   { unit: 'krea_units', amount, available, estimated, affordable }   a live preflight
//   { unit: 'usd_micros', amount, verifiedOn }                         a published price
//   { unit: 'callirra_credits', amount, usdMicros, verifiedOn }        a published price
function cleanQuote(value) {
  if (!record(value)) return null;
  if (value.unit === 'krea_units') {
    if (!amount(value.amount) || !amount(value.available) || typeof value.estimated !== 'boolean' || typeof value.affordable !== 'boolean') return null;
    return { unit: 'krea_units', amount: value.amount, available: value.available, estimated: value.estimated, affordable: value.affordable };
  }
  if (typeof value.verifiedOn !== 'string' || !DATE.test(value.verifiedOn) || !count(value.amount)) return null;
  if (value.unit === 'usd_micros') return { unit: 'usd_micros', amount: value.amount, verifiedOn: value.verifiedOn };
  if (value.unit === 'callirra_credits' && count(value.usdMicros)) return { unit: 'callirra_credits', amount: value.amount, usdMicros: value.usdMicros, verifiedOn: value.verifiedOn };
  return null;
}

// What the video command printed, as an object, or null.
function parsed(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return record(value) ? value : null;
}

function jobOf(result) {
  const value = parsed(result);
  return value ? cleanJob({ ...value, jobId: value.id }) : null;
}

function quoteOf(result, route) {
  const value = parsed(result);
  if (!value) return null;
  const workspace = value.currency === 'workspace_compute_units';
  if (workspace !== (route === WORKSPACE_ROUTE)) return null;
  if (workspace) return cleanQuote({ unit: 'krea_units', amount: value.compute_units, available: value.available_compute_units, estimated: value.is_estimated, affordable: value.affordable });
  if (value.currency === 'credits') return cleanQuote({ unit: 'callirra_credits', amount: value.credits, usdMicros: value.usdMicros, verifiedOn: value.verifiedOn });
  if (value.currency === 'USD') return cleanQuote({ unit: 'usd_micros', amount: value.usdMicros, verifiedOn: value.verifiedOn });
  return null;
}

// The outcome of the one purchase attempt, from what `run` threw (an Error) or
// from what it printed (the text, or the object it stands for):
//   { state: 'submitted', jobId, status, [outputUrl], [reservedCredits], [chargedUsd] }
//   { state: 'not-sent', reason }    only for the sentences listed above
//   { state: 'unknown' }             everything else, including a result
//                                    without a valid job id and status
function outcomeOf(resultOrError) {
  if (resultOrError instanceof Error) {
    const reason = reasonOf(resultOrError);
    return reason ? { state: 'not-sent', reason } : { state: 'unknown' };
  }
  const job = jobOf(resultOrError);
  return job ? { state: 'submitted', ...job } : { state: 'unknown' };
}

// ----------------------------------- the request -----------------------------------

// { kind, args, outcomeFile?, nonce? }. The first word of `args` must be the
// kind, so a request can only ever run a quote, a submit or a status. A
// submit must say where its outcome goes and carry the nonce of its claim.
function accepted(request) {
  if (!record(request) || !KINDS.includes(request.kind)) return false;
  if (!Object.keys(request).every((key) => ['kind', 'args', 'outcomeFile', 'nonce'].includes(key))) return false;
  const { kind, args, outcomeFile, nonce } = request;
  if (!Array.isArray(args) || args.length < 3 || args.length > MAX_ARGS || !args.every((word) => typeof word === 'string') || args[0] !== kind) return false;
  if (kind !== 'submit') return outcomeFile === undefined && nonce === undefined;
  return typeof outcomeFile === 'string' && outcomeFile.length <= 1024 && !outcomeFile.includes('\0') && path.isAbsolute(outcomeFile)
    && typeof nonce === 'string' && NONCE.test(nonce);
}

// One line of JSON of at most 64 KiB, as text or bytes, with or without its
// line end. Returns the request, or null for anything else.
function parseRequest(input) {
  let text;
  try {
    if (Buffer.isBuffer(input)) {
      if (input.length > MAX_REQUEST_BYTES) return null;
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } else if (typeof input === 'string') {
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) return null;
      text = input;
    } else return null;
    text = text.replace(/\r?\n$/, '');
    if (!text || text.includes('\n') || text.includes('\r')) return null;
    const request = JSON.parse(text);
    return accepted(request) ? request : null;
  } catch {
    return null;
  }
}

// --------------------------------- inside the child ---------------------------------

// Creates the file or fails: of any number of writers one succeeds. The bytes
// are flushed to the disk before this returns.
function writeOnceFile(file, value) {
  const handle = fs.openSync(file, 'wx');
  try {
    fs.writeSync(handle, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function printLine(line) {
  process.stdout.write(`${line}\n`);
}

// Runs one request. Returns the exit code: 0 when a line was printed, another
// number when the request was not run at all.
//
//   run(args, out, { env })   the video command; the real one unless given.
//                             Called once, never again.
//   writeOnce(file, object)   creates the outcome file or throws.
//   print(line)               one line of JSON.
//   exists(path)              whether a file or folder is there.
//
// A submit is not started when its outcome could not be recorded afterwards:
// when the outcome file is already there, or its folder is not.
//
// The line (always { v: 1, kind, ok, ... }):
//   quote    ok: true with the fields of cleanQuote(), or ok: false, reason
//   status   ok: true with the fields of cleanJob(), or ok: false, reason
//   submit   ok, state and the fields of outcomeOf(), and `recorded`: whether
//            the outcome file was written by this run
// `reason` is one of sign-in, refused, bad-request, over-cap, no-key or, for a
// quote or a status only, failed.
async function main(request, { run, writeOnce = writeOnceFile, print = printLine, exists = fs.existsSync } = {}) {
  if (!accepted(request)) return 2;
  const { kind, args } = request;
  const submit = kind === 'submit';
  if (submit) {
    let recordable = false;
    try {
      recordable = !exists(request.outcomeFile) && exists(path.dirname(request.outcomeFile)) === true;
    } catch {
      recordable = false;
    }
    if (!recordable) return 3;
  }

  const lines = [];
  let failed = false;
  let thrown;
  try {
    const command = typeof run === 'function' ? run : require('../command').run;
    // The one call. Nothing below repeats it, whatever it leads to.
    await command([...args], (text) => { lines.push(String(text)); }, { env: process.env });
  } catch (error) {
    failed = true;
    thrown = error;
  }
  const text = lines.join('\n');

  let line;
  if (submit) {
    // A thrown value that is not an Error is a failure nobody can read, never a result.
    const outcome = failed ? (thrown instanceof Error ? outcomeOf(thrown) : { state: 'unknown' }) : outcomeOf(text);
    let recorded = false;
    try {
      await writeOnce(request.outcomeFile, { nonce: request.nonce, ...outcome });
      recorded = true;
    } catch {
      // Already there, or the disk failed. The line below still says what happened.
    }
    line = { v: 1, kind, ok: outcome.state === 'submitted', ...outcome, recorded };
  } else if (failed) {
    line = { v: 1, kind, ok: false, reason: reasonOf(thrown) || 'failed' };
  } else {
    const job = kind === 'status' ? jobOf(text) : null;
    const fields = kind === 'quote' ? quoteOf(text, args[2]) : (job && job.jobId === args[3] ? job : null);
    line = fields ? { v: 1, kind, ok: true, ...fields } : { v: 1, kind, ok: false, reason: 'failed' };
  }
  try {
    print(JSON.stringify(line));
  } catch {
    // Nobody is reading any more. A purchase's outcome is already on disk.
  }
  return 0;
}

// The whole of standard input, or null when it is more than a request can be.
async function readAll(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

// The process entry: reads standard input to its end, runs the one request it
// holds and returns the exit code. Anything that is not one valid request
// runs nothing and gives a non-zero code.
async function start({ input = process.stdin, ...deps } = {}) {
  try {
    const raw = await readAll(input);
    const request = raw === null ? null : parseRequest(raw);
    return request ? await main(request, deps) : 2;
  } catch {
    return 1;
  }
}

if (require.main === module) {
  // A gateway that stopped reading must not turn the line into an uncaught error.
  process.stdout.on('error', () => {});
  start().then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}

// --------------------------------- on the gateway side ---------------------------------

// The argument list of the video command for one entry. The one place that
// builds them, for every route:
//
//   quote   Krea: a free preflight with the prompt. API routes: the published
//           price from the catalog; no prompt and no request.
//   submit  the cap under the route's own flag (--max-units, --max-usd in
//           dollars, --max-credits) and --confirm-charge.
//   status  the job id.
//
// --resolution is given except for a fixed tier, which has none, and always
// before the prompt, so no prompt can be read as the option. `entry` is a
// value of entries.offered(): it needs model, resolution, route and unit, and
// `fixedTier: true` for a fixed tier. `cap` is the text for the flag.
//
// Throws a TypeError for anything the command would not take. Nothing is
// started with a list that was not built.
function argsFor(kind, entry, { prompt, cap, jobId } = {}) {
  if (!KINDS.includes(kind)) throw new TypeError('A video request is a quote, a submit or a status.');
  if (!record(entry) || typeof entry.model !== 'string' || !MODEL.test(entry.model) || typeof entry.route !== 'string' || !ROUTE.test(entry.route)
      || typeof entry.resolution !== 'string' || !RESOLUTION.test(entry.resolution) || !Object.hasOwn(CAPS, entry.unit)
      || (entry.unit === 'krea_units') !== (entry.route === WORKSPACE_ROUTE)) {
    throw new TypeError('A video request needs an entry with its model, resolution, route and unit.');
  }
  const { model, route } = entry;
  const workspace = route === WORKSPACE_ROUTE;
  const resolution = entry.fixedTier === true ? [] : ['--resolution', entry.resolution];
  const needsPrompt = kind === 'submit' || (kind === 'quote' && workspace);
  if (needsPrompt && (typeof prompt !== 'string' || !prompt.trim() || prompt.startsWith('--') || prompt.includes('\0') || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES)) {
    throw new TypeError('A video prompt is text of at most 16,000 bytes that does not start with "--".');
  }
  if (kind === 'quote') return workspace ? ['quote', model, route, ...resolution, '--prompt', prompt] : ['quote', model, route, ...resolution];
  if (kind === 'status') {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new TypeError('A video job id is letters, digits, "_" and "-".');
    return ['status', model, route, jobId, ...resolution];
  }
  const { flag, form } = CAPS[entry.unit];
  if (typeof cap !== 'string' || !form.test(cap) || !(Number(cap) > 0)) throw new TypeError(`A cap is the text given to ${flag}: a positive decimal number.`);
  return ['submit', model, route, flag, cap, '--confirm-charge', ...resolution, prompt];
}

// The environment a child is started with, from `source` (the gateway's own):
// the fixed list, and for an API route the three provider key variables. A
// name that is not set is left out; a value is never looked at. `home`, when
// given, is the gateway's data folder and becomes DSHPROXY_HOME.
//
//   SystemRoot    where the key store finds PowerShell to unlock the master
//                 key (src/secrets.js); the Krea helper refuses without it.
//   LOCALAPPDATA  where the Krea helper keeps its sign-in (src/krea-helper/oauth.js).
//   TEMP, TMP     handed on to the Krea helper and to PowerShell.
//   USERPROFILE   the default data folder when DSHPROXY_HOME is not set.
//   APPDATA       nothing in DSHProxy reads it; it is part of the user's
//                 profile as Windows programs expect it, and is no secret.
//   DSHPROXY_HOME the data folder: saved video keys and their master key.
function environment(source, request, home, platform = process.platform) {
  const given = source !== null && typeof source === 'object' ? source : {};
  const listed = platform === 'darwin' ? MAC_ENVIRONMENT : ENVIRONMENT;
  const names = record(request) && Array.isArray(request.args) && request.args[2] !== WORKSPACE_ROUTE ? [...listed, ...KEY_VARIABLES] : listed;
  const env = {};
  for (const name of names) if (typeof given[name] === 'string' && given[name]) env[name] = given[name];
  if (typeof home === 'string' && home) env.DSHPROXY_HOME = home;
  return env;
}

// What a child printed, checked again on this side: the gateway trusts only
// the same closed set of fields. Returns the line or null.
function checkedLine(request, text) {
  const value = parsed(text.replace(/\r?\n$/, ''));
  if (!value || value.v !== 1 || value.kind !== request.kind || typeof value.ok !== 'boolean') return null;
  const { kind } = request;
  const head = { v: 1, kind, ok: value.ok };
  if (kind === 'submit') {
    if (typeof value.recorded !== 'boolean' || value.ok !== (value.state === 'submitted')) return null;
    if (value.state === 'submitted') {
      const job = cleanJob(value);
      return job ? { ...head, state: 'submitted', ...job, recorded: value.recorded } : null;
    }
    if (value.state === 'not-sent') return REASONS.includes(value.reason) ? { ...head, state: 'not-sent', reason: value.reason, recorded: value.recorded } : null;
    return value.state === 'unknown' ? { ...head, state: 'unknown', recorded: value.recorded } : null;
  }
  if (!value.ok) return [...REASONS, 'failed'].includes(value.reason) ? { ...head, reason: value.reason } : null;
  if (kind === 'quote') {
    const quote = cleanQuote(value);
    return quote ? { ...head, ...quote } : null;
  }
  const job = cleanJob(value);
  return job && job.jobId === request.args[3] ? { ...head, ...job } : null;
}

// Starts the child for one request and resolves when there is an answer.
// Never rejects:
//
//   { ok: true, started: true, result }   `result` is the child's line (see main)
//   { ok: false, started, why }           why: 'request' (not a valid request, nothing started),
//                                         'spawn' (the process could not be started),
//                                         'exit' (it ended with an error code), 'output' (it
//                                         ended without one valid line), 'timeout', 'abandoned'
//
// `started: false` means no process ran, so nothing was sent anywhere.
//
//   execPath   the Node program; this process's own unless given.
//   timeoutMs  for a quote or a status: stop the child after this long.
//   signal     the client's: when it aborts, the gateway stops waiting.
//   home       the gateway's data folder, passed on as DSHPROXY_HOME.
//   env        the environment to copy the fixed list from (see environment()).
//   script, spawn   for tests: the file to run and the function that starts it.
//
// A submit child is never killed and never timed out here: `timeoutMs` is
// ignored for it, and when `signal` aborts it is left to finish and to write
// its outcome file, which is where its result is then found. A request whose
// signal has already aborted starts nothing.
function spawnChild(request, { execPath = process.execPath, script = __filename, timeoutMs, signal, home, env = process.env, spawn = childProcess.spawn, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    let line;
    try {
      line = accepted(request) ? `${JSON.stringify(request)}\n` : null;
    } catch {
      line = null;
    }
    if (line === null || Buffer.byteLength(line) > MAX_REQUEST_BYTES) return resolve({ ok: false, started: false, why: 'request' });
    if (signal && signal.aborted) return resolve({ ok: false, started: false, why: 'abandoned' });
    const submit = request.kind === 'submit';

    let child;
    try {
      // The request, and the prompt inside it, travel on standard input only.
      // Standard error is not read: nothing a process below wrote is passed on.
      child = spawn(execPath, [script], { env: environment(env, request, home, platform), stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true });
    } catch {
      return resolve({ ok: false, started: false, why: 'spawn' });
    }

    let done = false;
    let timer = null;
    let size = 0;
    let chunks = [];
    const stop = () => { try { child.kill(); } catch { /* it has ended already */ } };
    const finish = (answer) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      chunks = null;
      resolve(answer);
    };
    function onAbort() {
      if (submit) {
        // Left to finish. It must not keep the gateway process from ending.
        for (const handle of [child, child.stdin, child.stdout]) {
          try { if (handle && typeof handle.unref === 'function') handle.unref(); } catch { /* nothing to release */ }
        }
      } else stop();
      finish({ ok: false, started: true, why: 'abandoned' });
    }

    child.on('error', () => {
      // Without a process id the process never started.
      if (child.pid === undefined) finish({ ok: false, started: false, why: 'spawn' });
    });
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      if (done || chunks === null) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size <= MAX_REQUEST_BYTES) return void chunks.push(bytes);
      // More than a line can be. For a submit the child is still left alone.
      chunks = null;
      if (!submit) {
        stop();
        finish({ ok: false, started: true, why: 'output' });
      }
    });
    child.on('close', (code) => {
      if (done) return;
      if (code !== 0) return finish({ ok: false, started: true, why: 'exit' });
      let result = null;
      try {
        result = chunks === null ? null : checkedLine(request, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        result = null;
      }
      finish(result ? { ok: true, started: true, result } : { ok: false, started: true, why: 'output' });
    });

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (!submit && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        stop();
        finish({ ok: false, started: true, why: 'timeout' });
      }, timeoutMs);
    }
    // Written once, then closed.
    try {
      child.stdin.end(line);
    } catch {
      // The process is already gone; its end is reported by 'close' or 'error'.
    }
  });
}

module.exports = { main, start, outcomeOf, reasonOf, argsFor, spawnChild, parseRequest, environment, ENVIRONMENT, MAC_ENVIRONMENT, KEY_VARIABLES, MAX_REQUEST_BYTES };
