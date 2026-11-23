'use strict';
// What the video picker keeps on disk, in <home>/video-picker/:
//
//   claims.log            the journal: a header line, then one line for every
//                         quote that was used
//   quotes/<id>.json      written once, when a quote is issued
//   outcomes/<id>.json    written once: what the one attempt led to
//   results/<id>.json     written once: the job's final state and link
//   settings.json         see settings.js; nothing here touches it
//
// A quote can lead to at most one paid request because of the journal alone.
// To use a quote, a caller appends one line to the journal, flushes it, reads
// the whole journal again and looks for the FIRST line that names the quote.
// Only the caller whose line that is may send. The journal is only ever
// appended to: nothing here truncates, rewrites, renames or deletes it, and a
// claim never creates it. There is no lock and nothing to take over, so a
// claim has no time limit and no owner to steal it from.
//
// Every other file is created exclusively and never changed; clean-up deletes
// old ones. Losing one of them fails closed: no quote, no purchase; no
// outcome, "unknown".
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FOLDER = 'video-picker';
const JOURNAL = 'claims.log';
const KINDS = ['quotes', 'outcomes', 'results'];

// 30 characters, none of which is easily misread. An id is long and random
// enough that looking for it in a line cannot match by accident.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const ID_PATTERN = `Q-[${ALPHABET}]{16}`;
const ID = new RegExp(`^${ID_PATTERN}$`);
const NONCE = /^[0-9a-f]{32}$/;
const ENTRY = /^[a-z0-9][a-z0-9./-]{2,79}$/;
const CAP = /^\d{1,9}(?:\.\d{1,6})?$/;
const SHA = /^[0-9a-f]{64}$/;
const JOB = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATUS = /^[a-z][a-z0-9_-]{0,63}$/;
// The three units an amount can be in; the same names as the ceilings.
const UNITS = ['krea_units', 'usd_micros', 'callirra_credits'];
// Failures known to happen before the paid request is sent.
const NOT_SENT_REASONS = ['sign-in', 'refused', 'bad-request', 'over-cap', 'no-key', 'ceiling'];
// Outcomes after which a claim does not count against the ceiling.
const NOT_BOUGHT = ['not-sent', 'rehearsal', 'declined'];

const MIN_JOURNAL_AGE_MS = 60000;
const MAX_RECORD_BYTES = 4096;
const QUOTE_LIFE_MS = 600000;
const DAY_MS = 86400000;
const KEEP_CLAIMED_MS = 30 * DAY_MS;

function plain(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// `random(count)` gives that many random bytes. Bytes that would favour some
// characters are thrown away, so every id is equally likely.
function newId(random) {
  let id = 'Q-';
  for (let draws = 0; draws < 64 && id.length < 18; draws += 1) {
    const bytes = random(16);
    if (!(bytes instanceof Uint8Array) || bytes.length !== 16) break;
    for (const byte of bytes) {
      if (byte < 240 && id.length < 18) id += ALPHABET[byte % ALPHABET.length];
    }
  }
  if (!ID.test(id)) throw new Error('No quote id could be drawn.');
  return id;
}

// The spending limit that goes to the provider for a quoted amount, as text,
// or null when the amount is not one of that unit. Krea units may be
// fractional and are rounded up at the sixth decimal, never down. US dollars
// are kept as whole millionths and sent as dollars. Credits are whole.
function capOf(unit, amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
  if (unit === 'callirra_credits') return Number.isSafeInteger(amount) && amount <= 999999999 ? String(amount) : null;
  if (unit !== 'krea_units' && unit !== 'usd_micros') return null;
  if (unit === 'usd_micros' && !Number.isSafeInteger(amount)) return null;
  if (unit === 'krea_units' && amount > 999999999) return null;
  let micros = unit === 'usd_micros' ? amount : Math.ceil(amount * 1000000);
  if (unit === 'krea_units' && micros / 1000000 < amount) micros += 1;
  // At most nine digits before the point, in units or in dollars.
  if (!Number.isSafeInteger(micros) || micros > 999999999999999) return null;
  const cap = `${Math.floor(micros / 1000000)}.${String(micros % 1000000).padStart(6, '0')}`.replace(/\.?0+$/, '');
  if (!CAP.test(cap)) return null;
  return unit === 'usd_micros' || Number(cap) >= amount ? cap : null;
}

// What a claim or a quote counts against the ceiling of its unit. Krea units
// are counted in millionths of the cap, which is the amount rounded up, so
// that sums are whole numbers and exact; the other units are whole already.
function spent({ unit, amount, cap }) {
  return unit === 'krea_units' ? Math.round(Number(cap) * 1000000) : amount;
}

// The limits that `used` (as usage() counts it) goes over, of the two that a
// clip in `unit` counts against: the number of clips over all routes, and the
// amounts in that unit. A sum that is not an exact whole number is over.
function exceeded(used, limits, unit) {
  const over = [];
  for (const name of ['clips', unit]) {
    const limit = name === 'krea_units' ? limits[name] * 1000000 : limits[name];
    if (!Number.isSafeInteger(used[name]) || !(used[name] <= limit)) over.push(name);
  }
  return over;
}

// The first line of a journal: {"journal":1,"createdAt":<ms>}. null when the
// first line is anything else, or is not a whole line.
function headerOf(text) {
  const end = text.indexOf('\n');
  if (end < 0) return null;
  try {
    const value = JSON.parse(text.slice(0, end));
    if (plain(value) && Object.keys(value).length === 2 && value.journal === 1 && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0) return { createdAt: value.createdAt };
  } catch {
    // not a header
  }
  return null;
}

// One journal line as a claim record, or null when it is not one.
function recordOf(line) {
  if (line.length > MAX_RECORD_BYTES) return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!plain(value)) return null;
  const { id, nonce, entry, amount, unit, cap, claimedAt } = value;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return null;
  if (typeof entry !== 'string' || !ENTRY.test(entry)) return null;
  if (!UNITS.includes(unit) || typeof cap !== 'string' || cap !== capOf(unit, amount)) return null;
  if (!Number.isSafeInteger(claimedAt)) return null;
  return { id, nonce, entry, amount, unit, cap, claimedAt };
}

// The claim of a quote is the FIRST journal line that names it. A line that
// names the quote but is not a record of it (torn, damaged, or anything else)
// is a claim that nobody holds: `record` is null and the answer is "unknown".
function firstClaim(text, id) {
  for (const line of text.split('\n')) {
    if (!line.includes(id)) continue;
    const record = recordOf(line);
    return { id, record: record !== null && record.id === id ? record : null };
  }
  return null;
}

// Every quote the journal names, with its claim, in the order of the journal.
function allClaims(text) {
  const claims = new Map();
  const named = new RegExp(ID_PATTERN, 'g');
  for (const line of text.split('\n')) {
    const ids = line.match(named);
    if (ids === null) continue;
    // As in firstClaim: the first line that names a quote is its claim, and
    // it has a holder only when the line is a record of that very quote.
    const record = recordOf(line);
    for (const id of ids) if (!claims.has(id)) claims.set(id, { id, record: record !== null && record.id === id ? record : null });
  }
  return claims;
}

function quoteOf(value, id) {
  if (!plain(value) || value.v !== 1 || value.id !== id) return null;
  const { entry, model, resolution, route, label, prompt, promptSha, amount, unit, cap, estimated, rehearsal, issuedAt, expiresAt, answerSha } = value;
  for (const text of [model, route, label, prompt]) if (typeof text !== 'string' || text === '') return null;
  if (typeof entry !== 'string' || !ENTRY.test(entry)) return null;
  if (resolution !== null && typeof resolution !== 'string') return null;
  if (typeof promptSha !== 'string' || promptSha !== sha256(prompt)) return null;
  // The cap is what is sent as the spending limit; it is never below the quote.
  if (!UNITS.includes(unit) || typeof cap !== 'string' || cap !== capOf(unit, amount)) return null;
  if (typeof estimated !== 'boolean' || typeof rehearsal !== 'boolean') return null;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt - issuedAt !== QUOTE_LIFE_MS) return null;
  if (typeof answerSha !== 'string' || !SHA.test(answerSha)) return null;
  return Object.freeze({ v: 1, id, entry, model, resolution, route, label, prompt, promptSha, amount, unit, cap, estimated, rehearsal, issuedAt, expiresAt, answerSha });
}

// An outcome as one of a closed set. It must carry the nonce of the claim it
// belongs to; anything else, and anything not understood, is "unknown". When
// the journal has no record of the claim there is no nonce to compare with
// (`nonce` is null), and the outcome is taken as it is on disk.
function outcomeOf(value, nonce) {
  const unknown = { state: 'unknown' };
  if (!plain(value)) return unknown;
  if (nonce !== null && (typeof nonce !== 'string' || !NONCE.test(nonce) || value.nonce !== nonce)) return unknown;
  if (value.state === 'submitted') {
    if (typeof value.jobId !== 'string' || !JOB.test(value.jobId) || typeof value.status !== 'string' || !STATUS.test(value.status)) return unknown;
    return { state: 'submitted', jobId: value.jobId, status: value.status };
  }
  if (value.state === 'not-sent') return NOT_SENT_REASONS.includes(value.reason) ? { state: 'not-sent', reason: value.reason } : unknown;
  if (value.state === 'rehearsal' || value.state === 'declined') return { state: value.state };
  return unknown;
}

// A stored final state. `jobId` null takes the job the result names itself.
function resultOf(value, jobId) {
  if (!plain(value) || typeof value.jobId !== 'string' || !JOB.test(value.jobId) || (jobId !== null && value.jobId !== jobId)) return null;
  if (value.state === 'completed' && (value.url === null || typeof value.url === 'string')) return { state: 'completed', jobId: value.jobId, url: value.url };
  if (value.state === 'failed') return { state: 'failed', jobId: value.jobId, url: null };
  return null;
}

function writeAll(handle, data) {
  let done = 0;
  while (done < data.length) done += fs.writeSync(handle, data, done, data.length - done);
}

// Created once and never changed: of any number of callers in any number of
// processes one creates the file and the others are told it exists (false).
function writeOnce(file, object) {
  let handle;
  try {
    handle = fs.openSync(file, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeAll(handle, Buffer.from(`${JSON.stringify(object)}\n`, 'utf8'));
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return true;
}

// { found: false } when there is no file; `value` is undefined when the file
// is there but does not hold JSON (half written, or damaged).
function readOnce(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { found: false };
    throw error;
  }
  try {
    return { found: true, value: JSON.parse(text) };
  } catch {
    return { found: true, value: undefined };
  }
}

function open(home) {
  if (typeof home !== 'string' || !home.trim()) throw new Error('The video picker needs the data folder as a path.');
  const folder = path.join(home, FOLDER);
  const journal = path.join(folder, JOURNAL);
  // Only an id of the exact form ever becomes part of a path.
  const fileOf = (kind, id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Not a quote id.');
    return path.join(folder, kind, `${id}.json`);
  };
  const exists = (kind, id) => fs.existsSync(fileOf(kind, id));

  // Makes the folders, and the journal when there is none: created
  // exclusively with its header line and flushed, in one step. An existing
  // journal is left exactly as it is, whatever it holds.
  function init(now) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('The video picker needs a clock that tells the time in milliseconds.');
    for (const kind of KINDS) fs.mkdirSync(path.join(folder, kind), { recursive: true });
    try {
      const handle = fs.openSync(journal, 'wx');
      try {
        writeAll(handle, Buffer.from(`${JSON.stringify({ journal: 1, createdAt: now })}\n`, 'utf8'));
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (!fs.statSync(journal).isFile()) throw new Error('The purchase record of the video picker is not a file.');
  }

  // Whether the journal can take a claim at `now`. Its age is measured from
  // the later of its header's time and the file's creation time, so both must
  // be a minute old: Windows gives a file that is created soon after one of
  // the same name was deleted the old file's creation time. A journal whose
  // first line is not a header is damaged and takes no claim at all.
  function journalState(now) {
    const stat = fs.statSync(journal);
    const header = headerOf(fs.readFileSync(journal, 'utf8'));
    if (!stat.isFile() || header === null) return { damaged: true, age: NaN };
    const born = stat.birthtimeMs;
    if (!Number.isFinite(born) || born <= 0 || !Number.isFinite(now)) return { damaged: false, age: NaN };
    return { damaged: false, age: Math.min(now - header.createdAt, now - born) };
  }

  // null, or { id, record } for the first line that names the quote.
  function claimOf(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Not a quote id.');
    return firstClaim(fs.readFileSync(journal, 'utf8'), id);
  }

  // Every claim in the journal: Map(id -> { id, record }).
  function claims() {
    return allClaims(fs.readFileSync(journal, 'utf8'));
  }

  // Uses the quote. Returns
  //   { held: true, nonce, record }   this caller, and no other, may send;
  //   { held: false, claim }          the quote was already used;
  //   { held: false, used: true }     an outcome or a result of the quote is
  //                                   on disk, so it was used, though the
  //                                   journal does not name it;
  //   { held: false, young: true }    the journal is younger than a minute;
  //   { held: false, damaged: true }  the journal has no header.
  // In the last three cases nothing was written. Throws when the claim could
  // not be recorded and read back; `appended` on the error says whether the
  // line may be in the journal all the same, in which case the quote is
  // spent. After a throw nothing may be sent.
  function claim({ id, entry, amount, unit, cap, claimedAt }) {
    const failure = (appended) => Object.assign(new Error('The claim could not be recorded.'), { code: 'VIDEO_PICKER_CLAIM', appended });
    // 128 bits from the system, never from an injected source: two callers
    // must not be able to write the same nonce.
    const nonce = crypto.randomBytes(16).toString('hex');
    const record = { id, nonce, entry, amount, unit, cap, claimedAt };
    const line = JSON.stringify(record);
    let appended = false;
    let first;
    try {
      if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES || recordOf(line) === null) throw new Error('not a record');
      if (leftover(id)) return { held: false, used: true };
      const state = journalState(claimedAt);
      if (state.damaged) return { held: false, damaged: true };
      if (!(state.age >= MIN_JOURNAL_AGE_MS)) return { held: false, young: true };
      // The line starts with a line break of its own, so it can never be
      // joined to a torn line left at the end of the journal.
      const data = Buffer.from(`\n${line}\n`, 'utf8');
      // Append only, and never create: a journal that is gone is an error.
      const handle = fs.openSync(journal, fs.constants.O_WRONLY | fs.constants.O_APPEND);
      try {
        appended = true;
        if (fs.writeSync(handle, data, 0, data.length) !== data.length) throw new Error('short write');
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      first = firstClaim(fs.readFileSync(journal, 'utf8'), id);
    } catch {
      throw failure(appended);
    }
    if (first === null) throw failure(true);
    if (first.record !== null && first.record.nonce === nonce) return { held: true, nonce, record: first.record };
    return { held: false, claim: first };
  }

  function writeQuote(record) {
    const clean = quoteOf(record, record && record.id);
    if (clean === null) throw new Error('Not a quote record.');
    return writeOnce(fileOf('quotes', clean.id), clean);
  }

  // The quote, or null when it is missing or does not read cleanly.
  function readQuote(id) {
    const read = readOnce(fileOf('quotes', id));
    return read.found ? quoteOf(read.value, id) : null;
  }

  function writeOutcome(id, outcome) {
    return writeOnce(fileOf('outcomes', id), outcome);
  }

  // null when there is no outcome file; { state: 'damaged' } while it does
  // not hold JSON; otherwise the outcome for the claim with that nonce (null:
  // the journal has no record of the claim, and the file is taken as it is).
  function readOutcome(id, nonce) {
    const read = readOnce(fileOf('outcomes', id));
    if (!read.found) return null;
    return read.value === undefined ? { state: 'damaged' } : outcomeOf(read.value, nonce);
  }

  function writeResult(id, result) {
    return writeOnce(fileOf('results', id), result);
  }

  // The stored final state of that job (null: of whatever job the file
  // names), or null: an unreadable result is ignored.
  function readResult(id, jobId) {
    const read = readOnce(fileOf('results', id));
    return read.found ? resultOf(read.value, jobId) : null;
  }

  // An outcome or a result on disk, readable or not, means the quote was
  // used, whatever the journal says.
  function leftover(id) {
    return exists('outcomes', id) || exists('results', id);
  }

  // Whether the outcome of a claim says that nothing was bought with it.
  function notBought(id, record) {
    const outcome = record === null ? null : readOutcome(id, record.nonce);
    return outcome !== null && NOT_BOUGHT.includes(outcome.state);
  }

  // What the claims of the 24 hours before `now` add up to: the number of
  // clips and the quoted amounts per unit (see `spent`). A claim counts
  // unless its outcome says nothing was bought; an unknown or missing outcome
  // counts in full. A claim that nobody holds counts with the amount of its
  // quote, for a day after that quote ran out. With `upTo`, a quote id, only
  // the claims up to and including that quote's are counted, in the order of
  // the journal.
  function usage(now, upTo) {
    const used = { clips: 0, krea_units: 0, usd_micros: 0, callirra_credits: 0 };
    for (const { id, record } of claims().values()) {
      let amount;
      let at;
      if (record === null) {
        let quote = null;
        try {
          quote = readQuote(id);
        } catch {
          quote = null;
        }
        if (quote === null) {
          if (id === upTo) break;
          continue;
        }
        amount = quote;
        at = quote.expiresAt;
      } else {
        amount = record;
        at = record.claimedAt;
      }
      const counts = now - at < DAY_MS && (id === upTo || !notBought(id, record));
      if (counts) {
        used.clips += 1;
        used[amount.unit] += spent(amount);
      }
      if (id === upTo) break;
    }
    return used;
  }

  // The claim, and with it the ceiling counted again with this claim in it.
  // The journal puts all claims in one order, and everything before a line
  // is there when that line is read back. So each claim is counted together
  // with the claims before it: of two made at the same moment the later one
  // counts the earlier, both can never slip under a limit, and the earlier
  // one is not held up by the later. `over` names the limits that are
  // exceeded; when there are any, the outcome "not sent, ceiling" is written
  // here and the holder must not send.
  function admit(fields, limits) {
    const mine = claim(fields);
    if (mine.held !== true) return mine;
    let over;
    try {
      over = exceeded(usage(fields.claimedAt, fields.id), limits, fields.unit);
    } catch {
      over = ['clips'];
    }
    if (over.length > 0) {
      try {
        writeOutcome(fields.id, { state: 'not-sent', nonce: mine.nonce, reason: 'ceiling' });
      } catch {
        // without an outcome the claim counts as unknown, and still nothing is sent
      }
    }
    return { ...mine, over };
  }

  // How many quotes were issued in the ten minutes before `now`.
  function recentQuotes(now) {
    let count = 0;
    for (const name of fs.readdirSync(path.join(folder, 'quotes'))) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!ID.test(id)) continue;
      let quote = null;
      try {
        quote = readQuote(id);
      } catch {
        quote = null;
      }
      if (quote !== null && now - quote.issuedAt < QUOTE_LIFE_MS) count += 1;
    }
    return count;
  }

  // Deletes what is old, and never the journal: a quote that was never used,
  // a day after it was issued; the files of a used quote, 30 days after its
  // claim, the quote first, so that what a half-done clean-up leaves behind
  // can never buy. Where the journal has no readable record of the claim,
  // the 30 days run from the end of the quote. Returns how many files were
  // deleted; a file that cannot be deleted now is left for the next time.
  function cleanUp(now) {
    let removed = 0;
    const drop = (kind, id) => {
      try {
        fs.unlinkSync(fileOf(kind, id));
        removed += 1;
        return true;
      } catch (error) {
        return error.code === 'ENOENT';
      }
    };
    const claimed = claims();
    const ids = (kind) => fs.readdirSync(path.join(folder, kind)).map((name) => (name.endsWith('.json') ? name.slice(0, -5) : '')).filter((id) => ID.test(id));
    const old = (at) => Number.isFinite(now) && now - at > KEEP_CLAIMED_MS;
    for (const id of ids('quotes')) {
      const claimOfIt = claimed.get(id);
      let quote = null;
      try {
        quote = readQuote(id);
      } catch {
        quote = null;
      }
      if (claimOfIt === undefined && !leftover(id)) {
        if (quote !== null && now - quote.issuedAt > DAY_MS) drop('quotes', id);
        continue;
      }
      const record = claimOfIt === undefined ? null : claimOfIt.record;
      const at = record !== null ? record.claimedAt : quote !== null ? quote.expiresAt : NaN;
      if (old(at) && drop('quotes', id)) {
        drop('results', id);
        drop('outcomes', id);
      }
    }
    // What an interrupted clean-up left: files of an old claim without a quote.
    for (const kind of ['results', 'outcomes']) {
      for (const id of ids(kind)) {
        const claimOfIt = claimed.get(id);
        if (claimOfIt !== undefined && claimOfIt.record !== null && old(claimOfIt.record.claimedAt) && !exists('quotes', id)) drop(kind, id);
      }
    }
    return removed;
  }

  return {
    folder, journal, init, journalState, claimOf, claims, claim, admit, usage, leftover, recentQuotes, cleanUp,
    writeQuote, readQuote, writeOutcome, readOutcome, writeResult, readResult,
    outcomeFile: (id) => fileOf('outcomes', id)
  };
}

module.exports = { open, newId, sha256, capOf, spent, exceeded, ID_PATTERN, ENTRY, UNITS, QUOTE_LIFE_MS, MIN_JOURNAL_AGE_MS, DAY_MS, NOT_SENT_REASONS };
