'use strict';
// The answer to one request for a video entry: a quote for a typed prompt, one
// purchase for a confirmation, the stored state for anything that comes back
// about a quote that was already used, and a plain sentence for everything
// else. Only one kind of request can buy: the confirmation of an open quote.
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
//
// The ops, which are the only way out to a provider. Each gets one frozen
// object and may return a value or a promise; a throw is never shown.
//
//   ops.quote({ entry, model, resolution, route, prompt })
//     -> { ok: true, amount, unit?, estimated?, available?, published? }
//        amount: in the entry's unit. krea_units may be fractional;
//        usd_micros are whole millionths of a US dollar; callirra_credits
//        are whole. unit: if given, must be the entry's. available: the
//        Krea balance, in units. published: 'YYYY-MM-DD', the date of the
//        published price; required on every route but krea.
//     -> { ok: false, reason: 'sign-in' | 'refused' }
//     -> { ok: false, reason: 'balance', needs, has }
//     Anything else, or a throw: no quote.
//
//   ops.submit({ id, nonce, entry, model, resolution, route, prompt, cap,
//                amount, unit, outcomeFile })
//     Called at most once per quote, after the claim. cap is the spending
//     limit as text: units, dollars (not millionths) or credits. Whoever
//     runs it writes outcomeFile itself, created exclusively, as one JSON
//     object with the nonce it was given:
//       { state: 'submitted', nonce, jobId, status }
//       { state: 'not-sent', nonce, reason }   reason: sign-in, refused,
//                                              bad-request, over-cap, no-key
//       { state: 'unknown', nonce }
//     What it returns or throws is not looked at. When it has ended and
//     there is no outcome file, the outcome is unknown.
//
//   ops.status({ entry, model, resolution, route, jobId })
//     -> { ok: true, status, progress?, links? }   status: a lower-case word;
//        'completed', 'failed', 'cancelled' and 'canceled' end the job;
//        progress: 0 to 100; links: for a completed job, the list that must
//        hold exactly one https link.
//     -> { ok: false, reason: 'sign-in' | 'unreachable' }
//     Anything else, or a throw: the state could not be verified.
const { classify, normalise, promptProblem } = require('./classify');
const { newId, sha256, capOf, spent, exceeded, ENTRY, UNITS, QUOTE_LIFE_MS } = require('./store');

const OUTCOME_WAIT_MS = 180000;
const FOLLOW_MS = 720000;
const REHEARSAL_MS = 180000;
const FIRST_CHECK_MS = 5000;
const NEXT_CHECK_MS = 15000;
const DOT_MS = 10000;
const MAX_QUOTES_IN_TEN_MINUTES = 20;
const FAILED = new Set(['failed', 'cancelled', 'canceled']);
const NOT_BOUGHT = new Set(['not-sent', 'rehearsal', 'declined']);
const STATUS = /^[a-z][a-z0-9_-]{0,63}$/;
const ROUTE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const PROVIDERS = { krea: 'Krea', videorouter: 'VideoRouter', 'videorouter-replicate': 'VideoRouter', kovapi: 'KovAPI', callirra: 'Callirra' };

const TEXT = {
  malformed: 'This request could not be read as a chat message. Nothing was quoted or bought.',
  switchedOff: 'This video entry is switched off in DSHProxy. Nothing was quoted or bought. Switch it on with `dshproxy video entries`, then run `dshproxy dsh apply`.',
  automation: 'This entry makes a video from a prompt you type. Goals and scheduled tasks are not run here. Nothing was quoted or bought.',
  delegated: 'This entry makes a video from a prompt a person types. A subagent gets no quote and buys nothing here. Nothing was quoted or bought.',
  compaction: 'Video conversation.',
  attachment: 'This entry takes text only. Nothing was quoted or bought.',
  silent: 'I found no message from you. Type a prompt to get a quote.',
  stray: 'There is nothing to confirm: a `yes` buys only when it is the one reply directly after a quote. Nothing was bought. Send the prompt again to get a quote.',
  unmatched: 'I could not match your confirmation to a quote, so nothing was bought. Type `status Q-…` with the quote\'s id to see it, or type the prompt again for a new quote.',
  dropped: 'Dropped. Nothing was bought.',
  nothingToDrop: 'There is no open quote to drop. Nothing was bought.',
  expiredDrop: 'That quote is no longer valid, so there is nothing to drop. Nothing was bought.',
  dropNotRecorded: 'The quote could not be closed just now. Nothing was bought. The quote runs out by itself ten minutes after it was made.',
  near: 'Nothing was bought. To buy the quoted clip, reply with only `yes` (or `da`). To drop it, reply `no`.',
  noJob: 'There is no job in this conversation yet. Type a prompt to get a quote.',
  badStatusId: 'I could not read a quote id in that. Type `status` alone for the newest job of this conversation, or `status Q-…` with the whole id of a quote. Nothing was bought.',
  noSuchQuote: 'I know no quote with that id. Nothing was bought.',
  unfit: 'This entry makes video clips: type what the clip should show, in at most 16,000 bytes. Nothing was quoted or bought.',
  dashes: 'A prompt cannot start with `--`. Nothing was quoted or bought.',
  hidden: 'The prompt contains control, invisible or text-direction characters, so it could not be shown exactly as it would be sent. Remove them and send it again. Nothing was quoted or bought.',
  tooManyQuotes: 'More than 20 quotes were asked for in ten minutes, so there is no new one. Nothing was bought. Wait a few minutes and send the prompt again.',
  noQuote: 'No quote could be made just now. Nothing was bought. Send the prompt again later.',
  signIn: 'Sign in to Krea in the DSHProxy app, then send the prompt again.',
  quoteRefused: 'The provider refused to price this clip, so there is no quote. Nothing was bought.',
  quoteNotRecorded: 'The quote could not be recorded, so there is none. Nothing was bought. Send the prompt again.',
  rehearsalQuote: 'Purchases from chat are switched off: a `yes` runs a rehearsal and buys nothing.',
  buyQuote: 'Nothing has been bought. To buy this clip, reply with only `yes` (or `da`). To drop it, reply `no`.',
  otherEntry: 'This quote was made for another video entry, so nothing was bought. Send the prompt again to get a quote for this one.',
  expired: 'This quote is no longer valid: a quote stands for ten minutes. Nothing was bought. Send the prompt again for a new quote.',
  exposed: 'Nothing was bought: a DeepSeek Harness profile lets agents pick the paid video route. Run `dshproxy dsh verify`, fix what it reports, then send the prompt again for a new quote.',
  young: 'The purchase record was created just now; try again in a minute. Nothing was bought.',
  damaged: 'The purchase record is damaged; nothing was bought.',
  recordUnreadable: 'The purchase record could not be read, so nothing was sent.',
  notRecorded: 'The purchase could not be recorded, so nothing was sent.',
  notRecordedSpent: 'The purchase could not be recorded, so nothing was sent. This quote cannot be used again; send the prompt again for a new one.',
  beingSent: 'This quote is already being sent.',
  rehearsal: 'That quote was a rehearsal; nothing was bought.',
  rehearsalEnd: 'Rehearsal: nothing was bought. To buy from chat, run `dshproxy video picker purchases on`, then send the prompt again for a new quote.',
  declined: 'You dropped that quote.',
  broken: 'DSHProxy could not answer this message. Nothing was bought by it.'
};
const NOT_SENT = {
  'sign-in': 'the Krea sign-in is missing or has expired',
  refused: 'the provider did not accept the order before it was sent',
  'bad-request': 'the order was not accepted as written',
  'over-cap': 'the price is now above the quoted amount',
  'no-key': 'the provider key is missing or cannot be read',
  ceiling: 'the ceiling for 24 hours is reached'
};
const UNREADABLE = { 'sign-in': 'the Krea sign-in has expired', unreachable: 'the provider could not be reached' };

function plain(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

const provider = (route) => (Object.hasOwn(PROVIDERS, route) ? PROVIDERS[route] : 'the provider');

// 97909.73 as "97,909.73", 856 as "856".
function grouped(number) {
  const [whole, cents] = number.toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents === '00' ? '' : `.${cents}`}`;
}

// Millionths of a US dollar as dollars with two to four decimals. An amount
// with more is rounded up, so that "at most" is never said of less than the
// limit that is sent.
function dollars(micros) {
  const parts = Math.ceil(micros / 100);
  const cents = String(parts % 10000).padStart(4, '0').replace(/0{1,2}$/, '');
  return `$${String(Math.floor(parts / 10000)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

// A quoted amount in words: "856 Krea compute units" in a quote, "856 units"
// elsewhere; "$0.85"; "10 Callirra credits", "10 credits".
function amountWords({ unit, amount, cap }, long) {
  if (unit === 'usd_micros') return dollars(amount);
  if (unit === 'callirra_credits') return `${cap} ${long ? 'Callirra credits' : 'credits'}`;
  return `${cap} ${long ? 'Krea compute units' : 'units'}`;
}

function limitWords(name, limits) {
  if (name === 'clips') return `${limits.clips} ${limits.clips === 1 ? 'clip' : 'clips'}`;
  if (name === 'usd_micros') return dollars(limits.usd_micros);
  return `${grouped(limits[name])} ${name === 'krea_units' ? 'Krea compute units' : 'Callirra credits'}`;
}

function ceilingText(start, over, limits, end) {
  return `${start}: with this clip, more than ${over.map((name) => limitWords(name, limits)).join(' and ')} would be bought in 24 hours. ${end} \`dshproxy video picker\` shows the limits and what is used.`;
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
  const cost = [`- Cost: at most ${amountWords(quote, true)}${quote.estimated ? ` (${name} marks this quote as an estimate)` : ''}.`];
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
    quote.rehearsal ? TEXT.rehearsalQuote : TEXT.buyQuote,
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
    : `${name} sets the final charge itself; the quoted amount was at most ${amountWords(quote, false)}.`;
}

// How a job that reached a final state is reported; always ends the quote.
function finalText(quote, result) {
  const name = provider(quote.route);
  if (result.state !== 'completed') return `The job failed at ${name}. Whether anything was charged is ${name}'s decision; check your balance. I did not send it again.\nFinished ${quote.id}`;
  const shown = result.url === null ? null : link([result.url]);
  if (shown === null) return `The job is completed, but its link could not be verified. Open your ${name} history.\nFinished ${quote.id}`;
  return `[Open the clip](${shown})\n\n${chargeLine(quote)}\nFinished ${quote.id}`;
}

// The same in one line, for a job that is mentioned in passing.
function finalWords(quote, result) {
  const name = provider(quote.route);
  if (result.state !== 'completed') return `failed at ${name}.`;
  const shown = result.url === null ? null : link([result.url]);
  return shown === null ? `completed, but its link could not be verified. Open your ${name} history.` : `completed. [Open the clip](${shown})`;
}

function statusWords(state) {
  return `${state.status}${state.progress === null ? '' : `, ${state.progress} %`}`;
}

// ------------------------------- the pieces -------------------------------

// Text goes out through `write`. Once writing fails the client is gone:
// nothing more is written, and waiting for a job stops.
//
// `signal`, when the caller has one, aborts when the client goes away (the
// connection closed): from then on nothing is written and no job is followed.
// It never stops a purchase that has begun: the one order is still handed
// over and its outcome recorded.
function speaker(write, signal) {
  // `about` is the quote this answer has started to use or report on.
  const out = { gone: false, about: null };
  try {
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted === true) out.gone = true;
      else signal.addEventListener('abort', () => { out.gone = true; }, { once: true });
    }
  } catch {
    // a signal that cannot be listened to is no signal
  }
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
  // An amount in a unit this module cannot count is never quoted.
  if (!UNITS.includes(unit)) return null;
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
  if (value.ok !== true || capOf(entry.unit, value.amount) === null) return null;
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

// The stored quote that an assistant turn is, word for word; null when it is none.
function quoteOfTurn(deps, turn) {
  if (turn === null || turn === undefined) return null;
  let quote = null;
  try {
    quote = deps.store.readQuote(turn.quoteId);
  } catch {
    quote = null;
  }
  return quote !== null && sha256(turn.answer) === quote.answerSha ? quote : null;
}

// How a quote was used; null while it is open. A quote is used when the
// journal names it, and also when an outcome or a result of it is on disk
// though the journal does not name it (`lost`). Throws when the journal
// cannot be read.
function useOf(deps, id, claims) {
  const claim = claims === undefined ? deps.store.claimOf(id) : claims.get(id) || null;
  if (claim !== null) return claim;
  return deps.store.leftover(id) ? { id, record: null, lost: true } : null;
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

// Watches a job for at most `limit`: a dot every ten seconds, whether or not
// a check is under way, and a word when the state changes. `look` makes one
// check and never rejects; the first is made after `first`, each next one 15
// seconds after the one before it returned. `shown` is the state last shown.
// Returns { ended: state }, { unreadable: state }, { limit: true } or
// { gone: true } when the client went away.
async function watch(deps, out, { look, limit, first, shown }) {
  const { clock } = deps;
  const started = clock.now();
  let known = shown;
  let nextDot = DOT_MS;
  let nextCheck = first;
  let dotted = false;
  let flying = false;
  let landed = null;
  let wake = () => {};
  out.say('Generating ');
  for (let turns = 0; turns < 10000; turns += 1) {
    if (out.gone) return { gone: true };
    if (landed !== null) {
      const state = landed;
      landed = null;
      flying = false;
      if (!state.ok) return { unreadable: state };
      if (ended(state)) return { ended: state };
      if (statusWords(state) !== known) {
        known = statusWords(state);
        out.say(`${dotted ? ' ' : ''}${state.status}${state.progress === null ? '' : ` ${state.progress} %`} `);
        dotted = false;
      }
      nextCheck = clock.now() - started + NEXT_CHECK_MS;
      if (out.gone) return { gone: true };
    }
    const elapsed = clock.now() - started;
    if (!(elapsed >= 0) || elapsed >= limit) return { limit: true };
    if (elapsed >= nextDot) {
      out.say('.');
      dotted = true;
      nextDot = elapsed + DOT_MS;
    }
    if (!flying && elapsed >= nextCheck) {
      flying = true;
      look(elapsed).then((state) => {
        landed = state;
        wake();
      }, () => {
        landed = { ok: false, reason: 'unverified' };
        wake();
      });
    }
    // Until the next dot, the next check or the end, or until a check lands.
    const pause = Math.max(1000, Math.min(nextDot, flying ? limit : nextCheck, limit) - elapsed);
    let cancel = () => {};
    await new Promise((resolve) => {
      wake = resolve;
      cancel = clock.after(pause, resolve);
    });
    cancel();
  }
  return { limit: true };
}

// Follows a job that was sent, to its end or for twelve minutes.
async function follow(deps, quote, record, job, out, shown, first) {
  const seen = await watch(deps, out, { look: () => check(deps, quote, job), limit: FOLLOW_MS, first, shown });
  if (seen.gone) return undefined;
  if (seen.unreadable) return out.say(`\n${unreadableText(job, seen.unreadable)}`);
  if (seen.ended) {
    const result = finish(deps, quote, job, seen.ended);
    const took = record === null ? NaN : deps.clock.now() - record.claimedAt;
    // Without a record of the claim nobody knows how long it took.
    const done = result.state !== 'completed' ? '' : took >= 0 ? `Done after ${duration(took)}.\n\n` : 'Done.\n\n';
    return out.say(`\n${done}${finalText(quote, result)}`);
  }
  return out.say(`\nStill running after 12 minutes. Job ${job.jobId}. Send \`status\` to check it.`);
}

// A job of a quote that some request, this one or an earlier one, sent.
// `record` is the claim's record, or null when the journal has none.
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
  const sent = record === null ? NaN : deps.clock.now() - record.claimedAt;
  out.say(`${head}: ${statusWords(state)}.${sent >= 0 ? ` Sent ${ago(sent)}.` : ''}\n`);
  if (ended(state)) return out.say(`\n${finalText(quote, finish(deps, quote, job, state))}`);
  return follow(deps, quote, record, job, out, statusWords(state), NEXT_CHECK_MS);
}

// ------------------------------- a quote that is used -------------------------------

// The outcome for the claim with that nonce (null: the journal has no record
// of the claim): null when there is no file. A file that is being written is
// read again for up to two seconds.
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

// A request about a quote that is already used (`use` as useOf gives it).
// Nothing in here can start a purchase: it reads the store and, for a job
// that was sent, asks its state.
async function claimed(deps, quote, use, out) {
  const { record } = use;
  out.about = quote.id;
  // A damaged line names the quote: it is used, and nobody knows by whom.
  if (record === null && use.lost !== true) return out.say(unknownText(quote));
  let outcome = await outcomeNow(deps, quote.id, record === null ? null : record.nonce);
  if (record === null) {
    // The journal lost the quote's line: what is on disk is the answer.
    if (outcome !== null) return report(deps, quote, null, outcome, out, false);
    let stored = null;
    try {
      stored = deps.store.readResult(quote.id, null);
    } catch {
      stored = null;
    }
    if (stored === null) return out.say(unknownText(quote));
    return out.say(`Job ${stored.jobId} (${quote.label}, quote ${quote.id}): ${stored.state}.\n\n${finalText(quote, stored)}`);
  }
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

// The job of a quote, as far as the store knows it without waiting: null
// unless the one attempt of that quote was sent.
function jobOf(deps, id, claims) {
  let quote = null;
  try {
    quote = deps.store.readQuote(id);
  } catch {
    quote = null;
  }
  if (quote === null) return null;
  const use = useOf(deps, id, claims);
  if (use === null || (use.record === null && use.lost !== true)) return null;
  const outcome = deps.store.readOutcome(id, use.record === null ? null : use.record.nonce);
  if (outcome === null || outcome.state !== 'submitted') return null;
  return { quote, record: use.record, job: outcome };
}

// ------------------------------- what the Harness asks on its own account -------------------------------

// The answer to a request for a summary: one line for every job the
// conversation names, with its quote id, so that `status Q-…` still finds it
// afterwards. Reads the store only.
function summary(deps, request) {
  const lines = [TEXT.compaction];
  try {
    const claims = deps.store.claims();
    for (const id of request.ids) {
      const found = jobOf(deps, id, claims);
      if (found === null) continue;
      const { quote, job } = found;
      const stored = deps.store.readResult(id, job.jobId);
      lines.push(`Job ${job.jobId} (${quote.label}, quote ${id}): ${stored === null ? `sent, and no final state is stored. Type \`status ${id}\` to check it.` : finalWords(quote, stored)}`);
    }
  } catch {
    // what could not be read is left out
  }
  return lines.join('\n');
}

// ------------------------------- status -------------------------------

async function status(deps, request, out) {
  if (request.badId === true) return out.say(TEXT.badStatusId);
  const { store } = deps;
  let claims;
  try {
    claims = store.claims();
  } catch {
    return out.say(TEXT.recordUnreadable);
  }
  const lookUp = (id) => {
    let quote = null;
    try {
      quote = store.readQuote(id);
    } catch {
      quote = null;
    }
    return quote === null ? null : { quote, use: useOf(deps, id, claims) };
  };

  // `status Q-…` names a quote directly, whatever the conversation holds.
  if (request.quoteId !== null) {
    const found = lookUp(request.quoteId);
    if (found === null) {
      return out.say(claims.has(request.quoteId) || store.leftover(request.quoteId)
        ? `Quote ${request.quoteId} was used, but its record is no longer kept, so its state cannot be shown. It will not be sent again.`
        : TEXT.noSuchQuote);
    }
    if (found.use !== null) return claimed(deps, found.quote, found.use, out);
    const now = deps.clock.now();
    const open = now >= found.quote.issuedAt && now <= found.quote.expiresAt;
    return out.say(`Quote ${found.quote.id} (${found.quote.label}) was not used: nothing was bought with it. ${open ? `It stands until ${clockTime(found.quote.expiresAt)}.` : 'It is no longer valid.'}`);
  }

  // `status` alone: the newest quote of this conversation that was sent or
  // may have been; failing that, the newest that was used at all.
  let other = null;
  for (const id of request.ids) {
    const found = lookUp(id);
    if (found === null || found.use === null) continue;
    let quiet = false;
    if (found.use.record !== null) {
      try {
        const outcome = store.readOutcome(id, found.use.record.nonce);
        quiet = outcome !== null && NOT_BOUGHT.has(outcome.state);
      } catch {
        quiet = false;
      }
    }
    if (!quiet) return claimed(deps, found.quote, found.use, out);
    if (other === null) other = found;
  }
  if (other !== null) return claimed(deps, other.quote, other.use, out);
  return out.say(TEXT.noJob);
}

// ------------------------------- a refusal -------------------------------

// `no` after an open quote closes it for good: the quote is claimed like a
// purchase, with the outcome "declined", so that no later `yes` can use it.
async function refuse(deps, request, out) {
  const { store } = deps;
  const quote = quoteOfTurn(deps, request.turn);
  if (quote === null) return out.say(TEXT.nothingToDrop);
  let mine;
  try {
    const use = useOf(deps, quote.id);
    if (use !== null) return claimed(deps, quote, use, out);
    // A quote that ran out is closed already; nothing is written for it.
    const now = deps.clock.now();
    if (!(now >= quote.issuedAt && now <= quote.expiresAt)) return out.say(TEXT.expiredDrop);
    mine = store.claim({ id: quote.id, entry: quote.entry, amount: quote.amount, unit: quote.unit, cap: quote.cap, claimedAt: deps.clock.now() });
  } catch {
    return out.say(TEXT.dropNotRecorded);
  }
  if (mine.held !== true) {
    if (mine.claim !== undefined) return claimed(deps, quote, mine.claim, out);
    return mine.used === true ? claimed(deps, quote, { id: quote.id, record: null, lost: true }, out) : out.say(TEXT.dropNotRecorded);
  }
  try {
    store.writeOutcome(quote.id, { state: 'declined', nonce: mine.nonce });
  } catch {
    // without the outcome the quote is still closed; it then reads as unknown
  }
  note(deps, `dropped ${quote.id}`);
  return out.say(TEXT.dropped);
}

// ------------------------------- a prompt: the quote -------------------------------

// One line about the newest job of this conversation, when no assistant turn
// reports it as finished; '' when there is nothing to say.
async function earlierJob(deps, request) {
  try {
    const claims = deps.store.claims();
    for (const id of request.ids) {
      const found = jobOf(deps, id, claims);
      if (found === null) continue;
      if (request.finished.includes(id)) return '';
      const { quote, job } = found;
      const head = `Earlier job ${job.jobId}: `;
      const stored = deps.store.readResult(id, job.jobId);
      if (stored !== null) return `${head}${finalWords(quote, stored)}`;
      const state = await check(deps, quote, job);
      if (!state.ok) return `${head}its state could not be read. Send \`status\` to check it.`;
      if (ended(state)) return `${head}${finalWords(quote, finish(deps, quote, job, state))}`;
      return `${head}${statusWords(state)}. Send \`status\` to follow it.`;
    }
  } catch {
    // nothing can be said about an earlier job
  }
  return '';
}

async function quote(deps, entry, request, out) {
  const { store, clock } = deps;
  const { prompt } = request;
  // Text that is not a prompt is never sent to a provider.
  if (request.unfit) return out.say(TEXT.unfit);
  const problem = promptProblem(prompt);
  if (problem !== null) return out.say(problem === 'empty' ? TEXT.silent : problem === 'long' ? TEXT.unfit : TEXT[problem]);

  const settings = deps.settings();
  const issuedAt = clock.now();
  if (!Number.isSafeInteger(issuedAt)) return out.say(TEXT.noQuote);
  let used;
  try {
    if (store.recentQuotes(issuedAt) >= MAX_QUOTES_IN_TEN_MINUTES) return out.say(TEXT.tooManyQuotes);
    used = store.usage(issuedAt);
  } catch {
    return out.say(TEXT.noQuote);
  }
  // A clip that the ceiling cannot allow whatever its price is not even priced.
  const full = exceeded({ ...used, clips: used.clips + 1 }, settings.ceiling, entry.unit);
  if (full.length > 0) return out.say(ceilingText('There is no quote', full, settings.ceiling, 'Nothing was bought.'));

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
  const priced = { unit: entry.unit, amount: offer.amount, cap: capOf(entry.unit, offer.amount) };
  const over = exceeded({ ...used, clips: used.clips + 1, [entry.unit]: used[entry.unit] + spent(priced) }, settings.ceiling, entry.unit);
  if (over.length > 0) return out.say(ceilingText('There is no quote', over, settings.ceiling, 'Nothing was bought.'));

  const earlier = await earlierJob(deps, request);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let written = false;
    let record;
    let text;
    try {
      const id = newId(deps.random);
      // An id the journal already names belongs to an older quote.
      if (store.claimOf(id) === null && !store.leftover(id)) {
        record = {
          v: 1, id, entry: entry.id, model: entry.model, resolution: entry.resolution, route: entry.route, label: entry.label,
          prompt, promptSha: sha256(prompt), amount: priced.amount, unit: priced.unit, cap: priced.cap, estimated: offer.estimated,
          // What the quote says a `yes` will do is what it does, whatever the switch says later.
          rehearsal: settings.purchases !== true,
          issuedAt, expiresAt: issuedAt + QUOTE_LIFE_MS
        };
        text = `${earlier === '' ? '' : `${earlier}\n\n`}${quoteText(record, offer)}`;
        record.answerSha = sha256(normalise(text));
        // On disk before the first byte of the answer: a quote the user can
        // see always exists.
        written = store.writeQuote(record);
      }
    } catch {
      return out.say(TEXT.quoteNotRecorded);
    }
    if (written) {
      note(deps, `quoted ${record.id} ${record.entry} ${record.cap} ${record.unit}${record.rehearsal ? ' (rehearsal)' : ''}, prompt of ${Buffer.byteLength(prompt, 'utf8')} bytes`);
      return out.say(text);
    }
  }
  return out.say(TEXT.quoteNotRecorded);
}

// ------------------------------- a confirmation: the one purchase -------------------------------

// The whole path except the paid request: a pretend job is followed for three
// minutes with the same dots and words. Nothing is sent to anybody.
async function rehearse(deps, quote, out) {
  out.say(`Rehearsal of one clip: ${quote.label}, at most ${amountWords(quote, false)} (quote ${quote.id}). Nothing is sent.\nPretend job is scheduled.\n`);
  const pretend = async (elapsed) => {
    if (elapsed < 30000) return { ok: true, status: 'scheduled', progress: null, url: null };
    return { ok: true, status: 'processing', progress: elapsed < 90000 ? 35 : 75, url: null };
  };
  const seen = await watch(deps, out, { look: pretend, limit: REHEARSAL_MS, first: FIRST_CHECK_MS, shown: 'scheduled' });
  if (seen.gone) return undefined;
  return out.say(`\n${TEXT.rehearsalEnd}`);
}

// `quote` is the stored quote the turn before the reply is, word for word
// (C2), or null. The caller has already answered for a quote that is used.
async function confirm(deps, entry, quote, out) {
  const { store, clock } = deps;
  if (quote === null) return out.say(TEXT.unmatched);

  // C3 and C5: this entry, switched on now, within the ten minutes, and no
  // profile that lets agents pick the route.
  if (quote.entry !== entry.id) return out.say(TEXT.otherEntry);
  if (await exposedNow(deps)) return out.say(TEXT.exposed);
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < quote.issuedAt || now > quote.expiresAt) return out.say(TEXT.expired);

  // C4, again after the waiting above: a quote that is used is answered from
  // the store. An outcome or a result on disk means used, whatever the
  // journal says: nothing is sent again because a record is missing.
  const settings = deps.settings();
  let used;
  try {
    const use = useOf(deps, quote.id);
    if (use !== null) return claimed(deps, quote, use, out);
    used = store.usage(now);
  } catch {
    return out.say(TEXT.recordUnreadable);
  }
  // The ceiling, before the claim: a refusal here does not spend the quote.
  const over = exceeded({ ...used, clips: used.clips + 1, [quote.unit]: used[quote.unit] + spent(quote) }, settings.ceiling, quote.unit);
  if (over.length > 0) return out.say(ceilingText('Nothing was bought', over, settings.ceiling, 'The quote was not used.'));

  // A client that has gone away by now gets nothing bought: the quote stays
  // open, and the same reply sent again within its ten minutes can buy. From
  // the claim on, a client that leaves no longer stops the one order.
  if (out.gone) return undefined;

  // Step 2, the claim: appended to the journal, flushed and read back. Only
  // the holder goes on. After an error this request sends nothing; if its
  // line may have reached the journal, no later request can send either.
  // Step 3 is part of it: the ceiling is counted again with this claim in it.
  let mine;
  out.about = quote.id;
  try {
    mine = store.admit({ id: quote.id, entry: quote.entry, amount: quote.amount, unit: quote.unit, cap: quote.cap, claimedAt: now }, settings.ceiling);
  } catch (error) {
    note(deps, `claim of ${quote.id} could not be recorded`);
    return out.say(error && error.appended === false ? TEXT.notRecorded : TEXT.notRecordedSpent);
  }
  if (mine.held !== true) {
    if (mine.claim !== undefined) return claimed(deps, quote, mine.claim, out);
    if (mine.used === true) return claimed(deps, quote, { id: quote.id, record: null, lost: true }, out);
    out.about = null;
    return out.say(mine.damaged === true ? TEXT.damaged : TEXT.young);
  }
  note(deps, `claimed ${quote.id} ${quote.entry} ${quote.cap} ${quote.unit}`);
  if (mine.over.length > 0) {
    note(deps, `outcome of ${quote.id}: not-sent (ceiling)`);
    return out.say(notSentText(quote, 'ceiling'));
  }

  // The purchases switch. A quote that announced a rehearsal rehearses even
  // when purchases were switched on since; a quote that announced a purchase
  // rehearses when they were switched off since.
  if (settings.purchases !== true || quote.rehearsal !== false) {
    try {
      store.writeOutcome(quote.id, { state: 'rehearsal', nonce: mine.nonce });
    } catch {
      // without the outcome the quote reads as unknown; nothing was sent
    }
    note(deps, `outcome of ${quote.id}: rehearsal`);
    return rehearse(deps, quote, out);
  }

  // Steps 4 and 5: the one paid request. Whoever runs it writes the outcome
  // file itself, with the nonce; what it returns or throws is not looked at.
  out.say(`Buying one clip: ${quote.label}, at most ${amountWords(quote, false)} (quote ${quote.id}).\n`);
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

  // A job is reported whatever its entry's switch says: these three read the
  // store and never quote or buy.
  if (request.kind === 'status') return status(deps, request, out);
  if (request.kind === 'compaction') return out.say(summary(deps, request));
  // So does an answer to a quote that is already used: a confirming word, a
  // refusing word or a short answer after it gets what became of the quote.
  const quoted = ['confirm', 'near', 'refusal'].includes(request.kind) ? quoteOfTurn(deps, request.turn) : null;
  if (quoted !== null) {
    let use;
    try {
      use = useOf(deps, quoted.id);
    } catch {
      return out.say(TEXT.recordUnreadable);
    }
    if (use !== null) return claimed(deps, quoted, use, out);
  }

  // From here on, in the order of the design's table.
  const entry = entryOf(deps, body.model);
  if (entry === null) return out.say(TEXT.switchedOff);
  if (request.kind === 'title') return out.say(request.title);
  if (request.kind === 'automation') return out.say(TEXT.automation);
  if (request.kind === 'delegated') return out.say(TEXT.delegated);
  if (request.kind === 'attachment') return out.say(TEXT.attachment);
  if (request.kind === 'silent') return out.say(TEXT.silent);
  if (request.kind === 'confirm') return confirm(deps, entry, quoted, out);
  if (request.kind === 'stray-confirm') return out.say(request.afterTurn ? TEXT.unmatched : TEXT.stray);
  if (request.kind === 'refusal') return refuse(deps, request, out);
  if (request.kind === 'near' && quoted !== null) {
    // A short answer to an unused quote of ours that is not one of the words
    // that count: no purchase, and no new quote either.
    const now = deps.clock.now();
    return out.say(now >= quoted.issuedAt && now <= quoted.expiresAt ? TEXT.near : TEXT.expired);
  }
  return quote(deps, entry, request, out);
}

// Writes the answer through `write`; resolves when the answer is complete.
// It never rejects: whatever goes wrong inside becomes one fixed sentence.
async function answer(deps, body, write, signal) {
  const out = speaker(write, signal);
  try {
    await respond(deps, body, out);
  } catch {
    note(deps, 'an answer could not be completed');
    // Once a quote is in use, "nothing was bought" could be untrue.
    out.say(out.about === null ? `\n${TEXT.broken}` : `\nDSHProxy could not finish reporting on quote ${out.about}. It will not be sent again.`);
  }
}

module.exports = { answer };
