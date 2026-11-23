'use strict';
// The only process this bundle starts. It runs under a real Node with the
// DSHProxy folder as its one argument, reads one request from standard input
// and prints one answer. It builds four DSHProxy video commands and no other:
// `settings` (read), `quote`, `status` and, for the Krea workspace route only,
// one `submit`. It never changes a setting, signs in, reads a provider key or
// sends a job twice. It cannot tell whether a person approved a submit; the
// Harness plugin that starts it asks the user first.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 65536;
const MAX_PROMPT_BYTES = 16000;
const WORKSPACE_ROUTE = 'krea';
const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const ROUTE = /^[a-z][a-z0-9-]{0,63}$/;
// The forms DSHProxy's own command accepts for a compute-unit cap and a job id.
const CAP = /^\d{1,9}(?:\.\d{1,6})?$/;
const JOB = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

class Refusal extends Error {
  constructor(code) { super(code); this.code = code; }
}
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactly = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validPrompt = (prompt) => typeof prompt === 'string' && Boolean(prompt.trim()) && !prompt.startsWith('--')
  && !prompt.includes('\0') && Buffer.byteLength(prompt) <= MAX_PROMPT_BYTES;

// Each operation has one exact shape. A field that is not listed, such as a
// credential or a second cap, makes the whole request invalid.
function accepted(request) {
  if (!record(request) || request.v !== 1) return false;
  if (request.op === 'options') return exactly(request, ['v', 'op']);
  if (typeof request.model !== 'string' || !MODEL.test(request.model)
      || typeof request.route !== 'string' || !ROUTE.test(request.route)) return false;
  const workspace = request.route === WORKSPACE_ROUTE;
  if (request.op === 'quote') {
    // Only the workspace route takes a prompt; for every other route none may arrive.
    return workspace ? exactly(request, ['v', 'op', 'model', 'route', 'prompt']) && validPrompt(request.prompt)
      : exactly(request, ['v', 'op', 'model', 'route']);
  }
  if (request.op === 'submit') {
    return workspace && exactly(request, ['v', 'op', 'model', 'route', 'prompt', 'cap']) && validPrompt(request.prompt)
      && typeof request.cap === 'string' && CAP.test(request.cap) && Number(request.cap) > 0;
  }
  if (request.op === 'status') {
    return workspace && exactly(request, ['v', 'op', 'model', 'route', 'jobId'])
      && typeof request.jobId === 'string' && JOB.test(request.jobId);
  }
  return false;
}

async function readRequest(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Refusal('BAD_REQUEST');
    chunks.push(chunk);
  }
  let request;
  try {
    request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Refusal('BAD_REQUEST');
  }
  if (!accepted(request)) throw new Refusal('BAD_REQUEST');
  return request;
}

// Loads `run` from the one file this process may use, and only from a folder
// that is a DSHProxy checkout. A link that leads out of the folder is refused.
function loadCommand() {
  if (process.versions.electron || Number(process.versions.node.split('.')[0]) < 22) throw new Refusal('RUNTIME');
  try {
    if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw new Error();
    const root = fs.realpathSync(process.argv[2]);
    if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name !== 'dshproxy') throw new Error();
    const file = fs.realpathSync(path.join(root, 'src', 'video', 'command.js'));
    if (!file.startsWith(root + path.sep)) throw new Error();
    const { run } = require(file);
    if (typeof run !== 'function') throw new Error();
    return run;
  } catch {
    throw new Refusal('ROOT_INVALID');
  }
}

// This process itself never uses the network. The Krea route's requests are
// made by DSHProxy's own Krea helper, a separate process that holds the sign-in.
const noNetwork = () => { throw new Error('This process does not use the network.'); };

async function execute(run, args) {
  const lines = [];
  const env = process.env.DSHPROXY_HOME ? { DSHPROXY_HOME: process.env.DSHPROXY_HOME } : {};
  await run(args, (text) => lines.push(String(text)), { env, fetchImpl: noNetwork });
  return lines.join('\n');
}

function parsed(text) {
  const value = JSON.parse(text);
  if (!record(value)) throw new Error();
  return value;
}

async function command(run, args) {
  return parsed(await execute(run, args));
}

// What the user switched on: enabled, with a route chosen, and that route
// among the ones DSHProxy lists for the model.
async function offered(run) {
  try {
    const settings = await command(run, ['settings']);
    if (!Array.isArray(settings.models)) throw new Error();
    return settings.models
      .filter((row) => record(row) && row.enabled === true && typeof row.model === 'string' && MODEL.test(row.model)
        && typeof row.route === 'string' && ROUTE.test(row.route) && Array.isArray(row.routes) && row.routes.includes(row.route))
      .map((row) => ({ model: row.model, route: row.route }));
  } catch {
    throw new Refusal('SETTINGS_UNAVAILABLE');
  }
}

// DSHProxy's own fixed sentences are recognised; any other text is dropped.
const SIGN_IN = 'Krea workspace sign-in required.';
const REFUSED = 'Krea refused the request';
const SHAPE = 'Krea workspace OAuth requires explicit workspace parameters.';

function quoteFailure(error) {
  const message = String(error?.message ?? '');
  if (message === 'Unknown video model' || message.startsWith('Unsupported video route for ')) return 'NOT_OFFERED';
  if (message.startsWith(SIGN_IN)) return 'SIGN_IN_REQUIRED';
  if (message.startsWith(REFUSED)) return 'WORKSPACE_REFUSED';
  if (message.startsWith('Krea helper did not return a verified result') || message === 'Invalid Krea preflight quote') return 'WORKSPACE_UNVERIFIED';
  if (message.startsWith(SHAPE)) return 'BAD_REQUEST';
  return 'FAILED';
}

// A submit failure counts as "nothing was sent" only for the sentences
// DSHProxy produces before its Krea helper dispatches the paid call: the
// helper reports a missing sign-in or a refusal (price above the cap, balance,
// unsupported preset) only before that call, and reports every failure after
// it as an unknown outcome. Any other failure, including one this file does
// not recognise, is an unknown outcome.
function submitFailure(error) {
  const message = String(error?.message ?? '');
  if (message.startsWith(SIGN_IN)) return 'SIGN_IN_REQUIRED';
  if (message.startsWith(REFUSED)) return 'WORKSPACE_REFUSED';
  if (message.startsWith(SHAPE) || message === 'Unknown video model') return 'BAD_REQUEST';
  return 'SUBMIT_UNCERTAIN';
}

function statusFailure(error) {
  const message = String(error?.message ?? '');
  if (message.startsWith(SIGN_IN)) return 'SIGN_IN_REQUIRED';
  if (message.startsWith(SHAPE) || message === 'Unknown video model') return 'BAD_REQUEST';
  return 'STATUS_UNVERIFIED';
}

// How the approval question names a clip that has no resolution.
const FIXED_TIER = 'fixed tier (resolution unspecified)';
const RESOLUTION = /^\d{3,4}p$/;
// The provider's name of a fixed tier. It is checked and never shown.
const TIER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ]{0,31}$/;

// The clip the Krea route runs for a model, from DSHProxy's offline listing:
// `workspace` holds either a resolution or the name of a fixed tier, which has
// no resolution. Which of the two it is comes from that listing alone, never
// from the model's name or from the resolution of the model's API route.
function workspacePreset(listed, model) {
  if (Object.hasOwn(listed, 'workspace')) {
    const clip = listed.workspace;
    if (!record(clip) || clip.route !== WORKSPACE_ROUTE) throw new Error();
    const tier = Object.hasOwn(clip, 'fixedTier');
    if (tier === Object.hasOwn(clip, 'resolution')) throw new Error();
    if (typeof (tier ? clip.fixedTier : clip.resolution) !== 'string' || !(tier ? TIER_NAME.test(clip.fixedTier) : RESOLUTION.test(clip.resolution))) throw new Error();
    return { durationSeconds: clip.durationSeconds, aspectRatio: clip.aspectRatio, resolution: tier ? FIXED_TIER : clip.resolution };
  }
  // A DSHProxy from before its listing stated the workspace clip: the one
  // resolution it lists, and the one model it ran as a fixed tier.
  if (typeof listed.resolution !== 'string' || !RESOLUTION.test(listed.resolution)) throw new Error();
  return { durationSeconds: listed.durationSeconds, aspectRatio: listed.aspectRatio, resolution: model === 'minimax-h3' ? FIXED_TIER : listed.resolution };
}

async function main() {
  globalThis.fetch = noNetwork;
  const request = await readRequest(process.stdin);
  const run = loadCommand();

  // A status check is about the job's own origin, so the current settings are
  // not consulted: a model switched off later can still be looked up.
  if (request.op === 'status') {
    try {
      return await command(run, ['status', request.model, WORKSPACE_ROUTE, request.jobId]);
    } catch (error) {
      throw new Refusal(statusFailure(error));
    }
  }

  const models = await offered(run);
  if (request.op === 'options') return { models };
  if (!models.some((row) => row.model === request.model && row.route === request.route)) throw new Refusal('NOT_OFFERED');

  if (request.op === 'quote') {
    try {
      if (request.route !== WORKSPACE_ROUTE) return await command(run, ['quote', request.model, request.route]);
      // The clip preset DSHProxy lists for the model, read offline before the
      // prompt goes anywhere. A Krea preflight does not state it.
      const preset = workspacePreset(await command(run, ['quote', request.model]), request.model);
      return { ...(await command(run, ['quote', request.model, WORKSPACE_ROUTE, '--prompt', request.prompt])), preset };
    } catch (error) {
      throw new Refusal(quoteFailure(error));
    }
  }

  // The single send: one call, no loop, no second attempt on any outcome.
  let output;
  try {
    output = await execute(run, ['submit', request.model, WORKSPACE_ROUTE, '--max-units', request.cap, '--confirm-charge', request.prompt]);
  } catch (error) {
    throw new Refusal(submitFailure(error));
  }
  try {
    return parsed(output);
  } catch {
    throw new Refusal('SUBMIT_UNCERTAIN');
  }
}

main().then(
  (data) => ({ v: 1, ok: true, data }),
  (error) => ({ v: 1, ok: false, code: error instanceof Refusal ? error.code : 'FAILED' }),
).then((message) => { process.stdout.write(`${JSON.stringify(message)}\n`); });
