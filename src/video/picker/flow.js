'use strict';
// The answer to one request for a video entry: a quote for a typed prompt, one
// purchase for a confirmation, and the stored state for anything that comes
// back about a quote that was already used.
//
// The order that keeps a quote from buying twice is in confirm(): the quote is
// claimed in the journal (appended, flushed, read back; see store.js) BEFORE
// ops.submit is called, and ops.submit is called in that one place only.
// Nothing is ever sent again because time passed, because a file is missing or
// because an earlier attempt's outcome is unknown.
//
// Every sentence here is fixed text plus validated fields: the quote id, the
// entry's label, numbers, a job id and status of a fixed form, the user's own
// prompt and a checked https link. Nothing from an error is shown or logged.
const { classify, normalise, promptProblem } = require('./classify');
const { newId, sha256, ENTRY, UNIT, QUOTE_LIFE_MS } = require('./store');

const OUTCOME_WAIT_MS = 180000;
const FOLLOW_MS = 720000;
const FIRST_CHECK_MS = 5000;
const NEXT_CHECK_MS = 15000;
const DOT_MS = 10000;
const FAILED = new Set(['failed', 'cancelled', 'canceled']);
const STATUS = /^[a-z][a-z0-9_-]{0,63}$/;
const ROUTE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const PROVIDERS = { krea: 'Krea', videorouter: 'VideoRouter', 'videorouter-replicate': 'VideoRouter', kovapi: 'KovAPI', callirra: 'Callirra' };
const UNITS = {
  krea_units: { long: 'Krea compute units', short: 'units' },
  usd: { long: 'US dollars', short: 'US dollars' },
  callirra_credits: { long: 'Callirra credits', short: 'credits' }
};

const TEXT = {
  malformed: 'This request could not be read as a chat message. Nothing was quoted or bought.',
  switchedOff: 'This video entry is switched off in DSHProxy. Nothing was quoted or bought. Switch it on with `dshproxy video entries`, then run `dshproxy dsh apply`.',
  attachment: 'This entry takes text only. Nothing was quoted or bought.',
  silent: 'I found no message from you. Type a prompt to get a quote.',
  stray: 'There is nothing to confirm: a `yes` buys only when it is the one reply directly after a quote. Nothing was bought. Send the prompt again to get a quote.',
  unmatched: 'I could not match your confirmation to a quote, so nothing was bought. Type `status Q-…` with the quote\'s id to see it, or type the prompt again for a new quote.',
  long: 'That prompt is too long: the limit is 16,000 bytes. Nothing was quoted or bought.',
  dashes: 'A prompt cannot start with `--`. Nothing was quoted or bought.',
  hidden: 'The prompt contains control, invisible or text-direction characters, so it could not be shown exactly as it would be sent. Remove them and send it again. Nothing was quoted or bought.',
  noQuote: 'No quote could be made just now. Nothing was bought. Send the prompt again later.',
  signIn: 'Sign in to Krea in the DSHProxy app, then send the prompt again.',
  quoteRefused: 'The provider refused to price this clip, so there is no quote. Nothing was bought.',
  quoteNotRecorded: 'The quote could not be recorded, so there is none. Nothing was bought. Send the prompt again.',
  otherEntry: 'This quote was made for another video entry, so nothing was bought. Send the prompt again to get a quote for this one.',
  expired: 'This quote is no longer valid: a quote stands for ten minutes. Nothing was bought. Send the prompt again for a new quote.',
  exposed: 'Nothing was bought: a DeepSeek Harness profile lets agents pick the paid video route. Run `dshproxy dsh verify`, fix what it reports, then send the prompt again for a new quote.',
  young: 'The purchase record was created just now; try again in a minute. Nothing was bought.',
  recordUnreadable: 'The purchase record could not be read, so nothing was sent.',
  notRecorded: 'The purchase could not be recorded, so nothing was sent.',
  notRecordedSpent: 'The purchase could not be recorded, so nothing was sent. This quote cannot be used again; send the prompt again for a new one.',
  beingSent: 'This quote is already being sent.',
  rehearsal: 'That quote was a rehearsal; nothing was bought.',
  declined: 'You dropped that quote.',
  broken: 'DSHProxy could not answer this message. Nothing was bought by it.'
};
const NOT_SENT = {
  'sign-in': 'the Krea sign-in is missing or has expired',
  refused: 'the provider did not accept the order before it was sent',
  'bad-request': 'the order was not accepted as written',
  'over-cap': 'the price is now above the quoted amount',
  'no-key': 'the provider key is missing or cannot be read',
  ceiling: 'the daily ceiling is reached'
};
const UNREADABLE = { 'sign-in': 'the Krea sign-in has expired', unreachable: 'the provider could not be reached' };

function plain(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

const provider = (route) => (Object.hasOwn(PROVIDERS, route) ? PROVIDERS[route] : 'the provider');
const unitWords = (unit, form) => (Object.hasOwn(UNITS, unit) ? UNITS[unit][form] : 'units');

// What goes to the provider as the spending limit: the quoted amount rounded
// up at the sixth decimal, never down (as integrations/dsh-video does).
function exactCap(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 999999999) return null;
  let micros = Math.ceil(amount * 1000000);
  if (micros / 1000000 < amount) micros += 1;
  if (!Number.isSafeInteger(micros)) return null;
  const cap = `${Math.floor(micros / 1000000)}.${String(micros % 1000000).padStart(6, '0')}`.replace(/\.?0+$/, '');
  return /^\d{1,9}(?:\.\d{1,6})?$/.test(cap) && Number(cap) >= amount ? cap : null;
}

// 97909.73 as "97,909.73", 856 as "856".
function grouped(number) {
  const [whole, cents] = number.toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents === '00' ? '' : `.${cents}`}`;
}

function clockTime(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function duration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function ago(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'less than a minute ago';
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
}

// Exactly one https link without user name or password, and nothing in it
// that could end the link it is shown in.
function link(links) {
  if (!Array.isArray(links) || links.length !== 1) return null;
  const [value] = links;
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\()<>[\]`"']/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !/[\s\\()<>[\]`"']/.test(url.href) ? url.href : null;
  } catch {
    return null;
  }
}

// ------------------------------- the texts -------------------------------

function quoteText(quote, offer) {
  const name = provider(quote.route);
  const fence = '`'.repeat(Math.max(3, 1 + Math.max(0, ...(quote.prompt.match(/`+/g) || []).map((run) => run.length))));
  const cost = [`- Cost: at most ${quote.cap} ${unitWords(quote.unit, 'long')}${quote.estimated ? ` (${name} marks this quote as an estimate)` : ''}.`];
  if (quote.route === 'krea') {
    if (offer.available !== null) cost.push(`Your workspace has ${grouped(offer.available)}.`);
    cost.push('Krea holds this amount when the job starts and sets the final charge itself.');
  }
  return [
    `**Quote: ${quote.label}**`,
    '',
    cost.join(' '),
    ...(quote.route === 'krea' ? [] : [`This is the published price of ${offer.published}. It is not checked with ${name} before the job, and ${name} decides the final charge.`]),
    `- Clip: one clip, 5 seconds, 16:9, ${quote.resolution === null ? '' : `${quote.resolution}, `}from text only.`,
    '- Prompt, exactly as it will be sent:',
    '',
    fence,
    quote.prompt,
    fence,
    '',
    'Nothing has been bought. To buy this clip, reply with only `yes` (or `da`). To drop it, reply `no`.',
    `The quote stands until ${clockTime(quote.expiresAt)}, ten minutes from now.${quote.route === 'krea' ? ' If Krea\'s price is higher by then, nothing is sent.' : ''}`,
    '',
    `Quote ${quote.id}`
  ].join('\n');
}

function unknownText(quote) {
  const where = quote.route === 'krea' ? 'Check your Krea history at krea.ai' : `Check your ${provider(quote.route)} account`;
  return [
    'I do not know whether this clip was bought.',
    '',
    `The order for quote ${quote.id} was handed over once and no answer came back. It may have been sent and charged, or not.`,
    `I will not send it again. ${where} before you order this prompt again.`,
    `Finished ${quote.id}`
  ].join('\n');
}

function notSentText(quote, reason) {
  return `Nothing was bought with quote ${quote.id}: ${NOT_SENT[reason]}. A quote is used once. Send the prompt again for a new one.`;
}

function chargeLine(quote) {
  const name = provider(quote.route);
  return quote.route === 'krea'
    ? `Krea held up to ${quote.cap} units and sets the final charge itself. Check it with \`dshproxy video balance krea\`.`
    : `${name} sets the final charge itself; the quoted amount was at most ${quote.cap} ${unitWords(quote.unit, 'short')}.`;
}

// How a job that reached a final state is reported; always ends the quote.
function finalText(quote, result) {
  const name = provider(quote.route);
  if (result.state !== 'completed') return `The job failed at ${name}. Whether anything was charged is ${name}'s decision; check your balance. I did not send it again.\nFinished ${quote.id}`;
  const shown = result.url === null ? null : link([result.url]);
  if (shown === null) return `The job is completed, but its link could not be verified. Open your ${name} history.\nFinished ${quote.id}`;
  return `[Open the clip](${shown})\n\n${chargeLine(quote)}\nFinished ${quote.id}`;
}

function statusWords(state) {
  return `${state.status}${state.progress === null ? '' : `, ${state.progress} %`}`;
}

// ------------------------------- the pieces -------------------------------

// Text goes out through `write`. Once writing fails the client is gone:
// nothing more is written, and waiting for a job stops.
function speaker(write) {
  // `about` is the quote this answer has started to use or report on.
  const out = { gone: false, about: null };
  out.say = (text) => {
    if (out.gone) return;
    try {
      const sent = write(text);
      if (sent && typeof sent.then === 'function') sent.then(undefined, () => { out.gone = true; });
    } catch {
      out.gone = true;
    }
  };
  return out;
}

function note(deps, line) {
  try {
    deps.log(`video picker: ${line}`);
  } catch {
    // a log that fails must not change an answer
  }
}

// The entry the request names, when it is switched on now and well formed.
function entryOf(deps, id) {
  if (typeof id !== 'string' || !ENTRY.test(id)) return null;
  let offered;
  try {
    offered = deps.entries();
  } catch {
    return null;
  }
  const entry = offered instanceof Map ? offered.get(id) : null;
  if (!plain(entry)) return null;
  const { model, resolution = null, route, label, unit } = entry;
  if (typeof model !== 'string' || !ROUTE.test(model) || typeof route !== 'string' || !ROUTE.test(route)) return null;
  if (typeof label !== 'string' || !/^[^\u0000-\u001F\u007F`*<>[\]]{1,120}$/.test(label)) return null;
  if (resolution !== null && (typeof resolution !== 'string' || !/^[A-Za-z0-9 .()_-]{1,40}$/.test(resolution))) return null;
  if (typeof unit !== 'string' || !UNIT.test(unit)) return null;
  return { id, model, resolution, route, label, unit };
}

// What ops.quote may answer, as a closed set; null for anything else.
function offerOf(value, entry) {
  if (!plain(value)) return null;
  if (value.ok === false) {
    if (value.reason === 'sign-in' || value.reason === 'refused') return { ok: false, reason: value.reason };
    if (value.reason === 'balance' && Number.isFinite(value.needs) && Number.isFinite(value.has)) return { ok: false, reason: 'balance', needs: value.needs, has: value.has };
    return null;
  }
  if (value.ok !== true || exactCap(value.amount) === null) return null;
  if (value.unit !== undefined && value.unit !== entry.unit) return null;
  const available = typeof value.available === 'number' && Number.isFinite(value.available) && value.available >= 0 ? value.available : null;
  const published = typeof value.published === 'string' && DATE.test(value.published) ? value.published : null;
  // An API route quotes a dated published price; without the date there is no quote.
  if (entry.route !== 'krea' && published === null) return null;
  if (available !== null && available < value.amount) return { ok: false, reason: 'balance', needs: value.amount, has: available };
  return { ok: true, amount: value.amount, estimated: value.estimated === true, available, published };
}

// What ops.status may answer, as a closed set.
function stateOf(value) {
  if (!plain(value) || value.ok !== true || typeof value.status !== 'string' || !STATUS.test(value.status)) {
    const reason = plain(value) && value.ok === false && Object.hasOwn(UNREADABLE, value.reason) ? value.reason : 'unverified';
    return { ok: false, reason };
  }
  const done = value.status === 'completed' || FAILED.has(value.status);
  // Progress is shown for a job that is still running only.
  const progress = !done && typeof value.progress === 'number' && value.progress >= 0 && value.progress <= 100 ? Math.round(value.progress) : null;
  return { ok: true, status: value.status, progress, url: value.status === 'completed' ? link(value.links) : null };
}

async function exposedNow(deps) {
  try {
    return (await deps.exposed()) !== false;
  } catch {
    return true;
  }
}

// ------------------------------- a prompt: the quote -------------------------------

async function quote(deps, entry, prompt, out) {
  const problem = promptProblem(prompt);
  if (problem !== null) return out.say(problem === 'empty' ? TEXT.silent : TEXT[problem]);

  let offer;
  try {
    offer = offerOf(await deps.ops.quote(Object.freeze({ entry: entry.id, model: entry.model, resolution: entry.resolution, route: entry.route, prompt })), entry);
  } catch {
    offer = null;
  }
  if (offer === null) return out.say(TEXT.noQuote);
  if (!offer.ok) {
    if (offer.reason === 'sign-in') return out.say(TEXT.signIn);
    if (offer.reason === 'refused') return out.say(TEXT.quoteRefused);
    return out.say(`The balance does not cover this clip: it needs ${grouped(offer.needs)} and has ${grouped(offer.has)}. There is no quote and nothing was bought.`);
  }

  const issuedAt = deps.clock.now();
  if (!Number.isSafeInteger(issuedAt)) return out.say(TEXT.noQuote);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let written = false;
    let record;
    let text;
    try {
      const id = newId(deps.random);
      // An id the journal already names belongs to an older quote.
      if (deps.store.claimOf(id) === null) {
        record = {
          v: 1, id, entry: entry.id, model: entry.model, resolution: entry.resolution, route: entry.route, label: entry.label,
          prompt, promptSha: sha256(prompt), amount: offer.amount, unit: entry.unit, cap: exactCap(offer.amount), estimated: offer.estimated,
          issuedAt, expiresAt: issuedAt + QUOTE_LIFE_MS
        };
        text = quoteText(record, offer);
        record.answerSha = sha256(normalise(text));
        // On disk before the first byte of the answer: a quote the user can
        // see always exists.
        written = deps.store.writeQuote(record);
      }
    } catch {
      return out.say(TEXT.quoteNotRecorded);
    }
    if (written) {
      note(deps, `quoted ${record.id} ${record.entry} ${record.cap} ${record.unit}, prompt of ${Buffer.byteLength(prompt, 'utf8')} bytes`);
      return out.say(text);
    }
  }
  return out.say(TEXT.quoteNotRecorded);
}

// ------------------------------- a job that was sent -------------------------------

async function check(deps, quote, job) {
  try {
    return stateOf(await deps.ops.status(Object.freeze({ entry: quote.entry, model: quote.model, resolution: quote.resolution, route: quote.route, jobId: job.jobId })));
  } catch {
    return { ok: false, reason: 'unverified' };
  }
}

function unreadableText(job, state) {
  const why = Object.hasOwn(UNREADABLE, state.reason) ? UNREADABLE[state.reason] : 'the answer could not be verified';
  return `The job's state could not be read: ${why}. The job itself is not affected. Job ${job.jobId}.`;
}

// Stores the final state (once) and gives it back as it is stored.
function finish(deps, quote, job, state) {
  const result = { v: 1, id: quote.id, jobId: job.jobId, state: state.status === 'completed' ? 'completed' : 'failed', url: state.url, at: deps.clock.now() };
  try {
    deps.store.writeResult(quote.id, result);
  } catch {
    // not stored: the next request asks the job again
  }
  note(deps, `job ${job.jobId} of ${quote.id} ended: ${result.state}`);
  return result;
}

const ended = (state) => state.status === 'completed' || FAILED.has(state.status);

// Follows a job with a dot every ten seconds and a word when its state
// changes, for at most twelve minutes. `known` is the state last shown.
async function follow(deps, quote, record, job, out, known, firstCheck) {
  const { clock } = deps;
  const started = clock.now();
  let shown = known;
  let nextDot = DOT_MS;
  let nextCheck = firstCheck;
  let dotted = false;
  out.say('Generating ');
  for (let turns = 0; turns < 1000 && !out.gone; turns += 1) {
    const elapsed = clock.now() - started;
    if (!(elapsed >= 0) || elapsed >= FOLLOW_MS) break;
    if (elapsed >= nextDot) {
      out.say('.');
      dotted = true;
      nextDot = elapsed + DOT_MS;
    }
    if (elapsed >= nextCheck) {
      const state = await check(deps, quote, job);
      nextCheck = clock.now() - started + NEXT_CHECK_MS;
      if (!state.ok) return out.say(`\n${unreadableText(job, state)}`);
      if (ended(state)) {
        const result = finish(deps, quote, job, state);
        const took = clock.now() - record.claimedAt;
        const done = result.state === 'completed' && took >= 0 ? `Done after ${duration(took)}.\n\n` : '';
        return out.say(`\n${done}${finalText(quote, result)}`);
      }
      if (statusWords(state) !== shown) {
        shown = statusWords(state);
        out.say(`${dotted ? ' ' : ''}${state.status}${state.progress === null ? '' : ` ${state.progress} %`} `);
        dotted = false;
      }
      continue;
    }
    await clock.sleep(Math.max(1000, Math.min(nextDot, nextCheck, FOLLOW_MS) - elapsed));
  }
  if (!out.gone) out.say(`\nStill running after 12 minutes. Job ${job.jobId}. Send \`status\` to check it.`);
}

// A job of a quote that some request, this one or an earlier one, sent.
async function track(deps, quote, record, job, out, first) {
  let stored = null;
  try {
    stored = deps.store.readResult(quote.id, job.jobId);
  } catch {
    stored = null;
  }
  const head = `Job ${job.jobId} (${quote.label}, quote ${quote.id})`;
  // The stored result is the answer; the provider is not asked again.
  if (stored !== null) return out.say(`${head}: ${stored.state}.\n\n${finalText(quote, stored)}`);
  if (first) {
    out.say(`Sent once. Job ${job.jobId} is ${job.status}.\n`);
    return follow(deps, quote, record, job, out, job.status, FIRST_CHECK_MS);
  }
  const state = await check(deps, quote, job);
  if (!state.ok) return out.say(unreadableText(job, state));
  const sent = deps.clock.now() - record.claimedAt;
  out.say(`${head}: ${statusWords(state)}.${sent >= 0 ? ` Sent ${ago(sent)}.` : ''}\n`);
  if (ended(state)) return out.say(`\n${finalText(quote, finish(deps, quote, job, state))}`);
  return follow(deps, quote, record, job, out, statusWords(state), NEXT_CHECK_MS);
}

// ------------------------------- a quote that is used -------------------------------

// The outcome for the claim with that nonce: null when there is no file. A
// file that is being written is read again for up to two seconds.
async function outcomeNow(deps, id, nonce) {
  for (let tries = 0; ; tries += 1) {
    let outcome;
    try {
      outcome = deps.store.readOutcome(id, nonce);
    } catch {
      return { state: 'unknown' };
    }
    if (outcome === null || outcome.state !== 'damaged') return outcome;
    if (tries >= 8) return { state: 'unknown' };
    await deps.clock.sleep(250);
  }
}

function report(deps, quote, record, outcome, out, first) {
  if (outcome.state === 'submitted') return track(deps, quote, record, outcome, out, first);
  if (outcome.state === 'not-sent') return out.say(notSentText(quote, outcome.reason));
  if (outcome.state === 'rehearsal') return out.say(TEXT.rehearsal);
  if (outcome.state === 'declined') return out.say(TEXT.declined);
  return out.say(unknownText(quote));
}

// A request about a quote that is already claimed. Nothing in here can start
// a purchase: it reads the store and, for a job that was sent, asks its state.
async function claimed(deps, quote, claim, out) {
  const { record } = claim;
  out.about = quote.id;
  // A damaged line names the quote: it is used, and nobody knows by whom.
  if (record === null) return out.say(unknownText(quote));
  let outcome = await outcomeNow(deps, quote.id, record.nonce);
  const young = () => {
    const age = deps.clock.now() - record.claimedAt;
    return age >= 0 && age < OUTCOME_WAIT_MS;
  };
  if (outcome === null && young()) {
    out.say(TEXT.beingSent);
    for (let waited = 0; outcome === null && waited < OUTCOME_WAIT_MS / 1000 && young() && !out.gone; waited += 1) {
      await deps.clock.sleep(1000);
      out.say('.');
      outcome = await outcomeNow(deps, quote.id, record.nonce);
    }
    out.say('\n');
  }
  if (out.gone) return undefined;
  // Still nothing: the unknown is derived, not written. An outcome that
  // arrives later takes its place from then on.
  if (outcome === null) return out.say(unknownText(quote));
  return report(deps, quote, record, outcome, out, false);
}

// ------------------------------- a confirmation: the one purchase -------------------------------

async function confirm(deps, entry, request, out) {
  const { store, clock } = deps;

  // C2: the turn before the reply is, word for word, a quote this gateway stored.
  let quote = null;
  try {
    quote = store.readQuote(request.quoteId);
  } catch {
    quote = null;
  }
  if (quote === null || sha256(request.answer) !== quote.answerSha) return out.say(TEXT.unmatched);

  // C4: a quote that is already used is answered from the store.
  let earlier;
  try {
    earlier = store.claimOf(quote.id);
  } catch {
    return out.say(TEXT.recordUnreadable);
  }
  if (earlier !== null) return claimed(deps, quote, earlier, out);

  // C3 and C5: this entry, switched on now, within the ten minutes, and no
  // profile that lets agents pick the route.
  if (quote.entry !== entry.id) return out.say(TEXT.otherEntry);
  if (await exposedNow(deps)) return out.say(TEXT.exposed);
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < quote.issuedAt || now > quote.expiresAt) return out.say(TEXT.expired);

  // Step 2, the claim: appended to the journal, flushed and read back. Only
  // the holder goes on. After an error this request sends nothing; if its
  // line may have reached the journal, no later request can send either.
  let mine;
  out.about = quote.id;
  try {
    mine = store.claim({ id: quote.id, entry: quote.entry, amount: quote.amount, unit: quote.unit, cap: quote.cap, claimedAt: now });
  } catch (error) {
    note(deps, `claim of ${quote.id} could not be recorded`);
    return out.say(error && error.appended === false ? TEXT.notRecorded : TEXT.notRecordedSpent);
  }
  if (mine.young === true) {
    out.about = null;
    return out.say(TEXT.young);
  }
  if (mine.held !== true) return claimed(deps, quote, mine.claim, out);
  note(deps, `claimed ${quote.id} ${quote.entry} ${quote.cap} ${quote.unit}`);

  // ---------------------------------------------------------------------
  // Step 3 (next slice) goes exactly here, between the claim and the
  // submit: the purchases switch with its rehearsal, and the ceiling counted
  // again with this claim in it. Each of them writes its own outcome
  // (store.writeOutcome with mine.nonce) and returns before ops.submit.
  // In this slice purchases are always on and there is no ceiling.
  // ---------------------------------------------------------------------

  // Steps 4 and 5: the one paid request. Whoever runs it writes the outcome
  // file itself, with the nonce; what it returns or throws is not looked at.
  out.say(`Buying one clip: ${quote.label}, at most ${quote.cap} ${unitWords(quote.unit, 'short')} (quote ${quote.id}).\n`);
  try {
    await deps.ops.submit(Object.freeze({
      id: quote.id, nonce: mine.nonce, entry: quote.entry, model: quote.model, resolution: quote.resolution, route: quote.route,
      prompt: quote.prompt, cap: quote.cap, amount: quote.amount, unit: quote.unit, outcomeFile: store.outcomeFile(quote.id)
    }));
  } catch {
    // says nothing about the order: only the outcome file does
  }

  // Step 6: it ended. No outcome on disk means nobody knows.
  let outcome = await outcomeNow(deps, quote.id, mine.nonce);
  if (outcome === null) {
    let written = false;
    try {
      written = store.writeOutcome(quote.id, { state: 'unknown', nonce: mine.nonce });
    } catch {
      written = true;
    }
    outcome = written ? { state: 'unknown' } : (await outcomeNow(deps, quote.id, mine.nonce)) || { state: 'unknown' };
  }
  note(deps, `outcome of ${quote.id}: ${outcome.state}${outcome.state === 'submitted' ? ` job ${outcome.jobId}` : ''}`);

  // Step 7.
  return report(deps, quote, mine.record, outcome, out, true);
}

// ------------------------------- one request -------------------------------

async function respond(deps, body, out) {
  const request = classify(body);
  if (request.kind === 'malformed') return out.say(TEXT.malformed);
  const entry = entryOf(deps, body.model);
  if (entry === null) return out.say(TEXT.switchedOff);
  if (request.kind === 'attachment') return out.say(TEXT.attachment);
  if (request.kind === 'silent') return out.say(TEXT.silent);
  if (request.kind === 'stray-confirm') return out.say(request.afterTurn ? TEXT.unmatched : TEXT.stray);
  if (request.kind === 'confirm') return confirm(deps, entry, request, out);
  return quote(deps, entry, request.prompt, out);
}

// Writes the answer through `write`; resolves when the answer is complete.
// It never rejects: whatever goes wrong inside becomes one fixed sentence.
async function answer(deps, body, write) {
  const out = speaker(write);
  try {
    await respond(deps, body, out);
  } catch {
    note(deps, 'an answer could not be completed');
    // Once a quote is in use, "nothing was bought" could be untrue.
    out.say(out.about === null ? `\n${TEXT.broken}` : `\nDSHProxy could not finish reporting on quote ${out.about}. It will not be sent again.`);
  }
}

module.exports = { answer };
