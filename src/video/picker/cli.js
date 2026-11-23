'use strict';
// The words after `dshproxy video picker`: the switch and the ceiling that
// limit what a confirmation in chat can buy, and what was bought.
//
//   run(args, out, { env, home, now })
//
// It reads the picker's files and writes one of them: settings.json. It
// never creates or changes the purchase record, a quote, an outcome or a
// result, and it sends nothing to anybody.
const store = require('./store');
const settings = require('./settings');
const { homeDir } = require('../../settings');

const USAGE = `dshproxy video picker                             Purchases from chat on or off, the ceiling, use in the last 24 hours, the last ten jobs
  video picker purchases on|off                   Let a confirmation in chat buy, or make it a rehearsal that buys nothing
  video picker ceiling clips N                    At most N clips in 24 hours, over all routes (0 to 1000)
  video picker ceiling units N                    At most N Krea compute units in 24 hours (a whole number)
  video picker ceiling usd AMOUNT                 At most AMOUNT US dollars in 24 hours on dollar routes (up to two decimals)
  video picker ceiling credits N                  At most N Callirra credits in 24 hours (a whole number)
  video picker jobs                               Every quote that was used: quote id, entry, amount, state, job id, time
The ceiling counts quoted amounts, not final charges, and only what is bought from chat: \`dshproxy video submit\` has no ceiling.
An outcome that is not known counts in full. Purchases from chat are off until they are switched on here.`;

const SENT_WAIT_MS = 180000;
const LIMIT_NAMES = { clips: 'clips', units: 'krea_units', usd: 'usd_micros', credits: 'callirra_credits' };

// Millionths of a US dollar as dollars, exactly: two to six decimals.
function dollars(micros) {
  const cents = String(micros % 1000000).padStart(6, '0').replace(/0{1,4}$/, '');
  return `${Math.floor(micros / 1000000)}.${cents}`;
}

function amountOf({ unit, amount, cap }) {
  if (unit === 'usd_micros') return `$${dollars(amount)}`;
  return `${cap} ${unit === 'krea_units' ? 'Krea compute units' : 'Callirra credits'}`;
}

function limitsOf(ceiling) {
  return { clips: ceiling.clips, krea_units: ceiling.krea_units, usd: dollars(ceiling.usd_micros), callirra_credits: ceiling.callirra_credits };
}

// A whole number from the command line, or a refusal.
function whole(text, most, what) {
  if (typeof text !== 'string' || !/^\d{1,13}$/.test(text) || Number(text) > most) throw new Error(`${what} must be a whole number from 0 to ${most}. Nothing was changed.`);
  return Number(text);
}

function limitOf(name, text) {
  if (name === 'clips') return whole(text, settings.BOUNDS.clips, 'The number of clips');
  if (name === 'units') return whole(text, settings.BOUNDS.krea_units, 'The number of Krea compute units');
  if (name === 'credits') return whole(text, settings.BOUNDS.callirra_credits, 'The number of Callirra credits');
  if (typeof text !== 'string' || !/^\d{1,7}(?:\.\d{1,2})?$/.test(text) || Number(text) > settings.BOUNDS.usd_micros / 1000000) {
    throw new Error(`The amount must be US dollars from 0 to ${settings.BOUNDS.usd_micros / 1000000}, with at most two decimals. Nothing was changed.`);
  }
  const [units, cents = ''] = text.split('.');
  return Number(units) * 1000000 + Number(cents.padEnd(2, '0')) * 10000;
}

// What the purchase record holds. Without a record there is nothing yet.
function record(files, now) {
  let claims;
  let used;
  try {
    claims = files.claims();
    used = files.usage(now);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { claims: new Map(), used: { clips: 0, krea_units: 0, usd_micros: 0, callirra_credits: 0 }, problem: null };
    return { claims: new Map(), used: null, problem: 'The purchase record cannot be read.' };
  }
  return { claims, used, problem: null };
}

// One used quote as a row: newest claims first in the list.
function jobOf(files, { id, record: claim }, now) {
  let quote = null;
  try {
    quote = files.readQuote(id);
  } catch {
    quote = null;
  }
  const row = { quote: id, entry: claim !== null ? claim.entry : quote !== null ? quote.entry : null, amount: claim !== null ? amountOf(claim) : quote !== null ? amountOf(quote) : null, state: 'unknown', job: null, time: claim !== null ? new Date(claim.claimedAt).toISOString() : null };
  if (claim === null) return row;
  let outcome = null;
  try {
    outcome = files.readOutcome(id, claim.nonce);
  } catch {
    return row;
  }
  if (outcome === null) {
    const age = now - claim.claimedAt;
    if (age >= 0 && age < SENT_WAIT_MS) row.state = 'being sent';
  } else if (outcome.state === 'submitted') {
    row.job = outcome.jobId;
    let result = null;
    try {
      result = files.readResult(id, outcome.jobId);
    } catch {
      result = null;
    }
    row.state = result === null ? 'submitted' : result.state;
  } else if (outcome.state === 'not-sent') row.state = `not sent (${outcome.reason})`;
  else if (outcome.state === 'rehearsal' || outcome.state === 'declined') row.state = outcome.state;
  return row;
}

function jobs(files, claims, now, most) {
  const rows = [...claims.values()].reverse();
  return (most === undefined ? rows : rows.slice(0, most)).map((claim) => jobOf(files, claim, now));
}

function overview(home, now) {
  const current = settings.read(home);
  const files = store.open(home);
  const kept = record(files, now);
  const view = {
    purchases: current.purchases ? 'on' : 'off',
    ceiling_per_24_hours: limitsOf(current.ceiling),
    used_last_24_hours: kept.used === null ? null : { clips: kept.used.clips, krea_units: kept.used.krea_units / 1000000, usd: dollars(kept.used.usd_micros), callirra_credits: kept.used.callirra_credits },
    last_jobs: jobs(files, kept.claims, now, 10)
  };
  const notes = [];
  if (current.problem !== null) notes.push(`${settings.file(home)} ${current.problem === 'invalid' ? 'does not hold valid settings' : 'cannot be read'}: purchases are off and the default ceiling applies. Fix the file or move it away.`);
  if (kept.problem !== null) notes.push(kept.problem);
  if (notes.length > 0) view.problems = notes;
  return view;
}

async function run(args, out, { env = process.env, home, now = Date.now } = {}) {
  const folder = home !== undefined ? home : env.DSHPROXY_HOME || homeDir();
  const emit = (data) => out(JSON.stringify(data, null, 2));
  const list = Array.isArray(args) ? args : [];
  const [action, name, value] = list;
  if (list.length === 0) return emit(overview(folder, now()));
  if (list.length === 1 && ['help', '--help', '-h'].includes(action)) return out(USAGE);
  if (list.length === 1 && action === 'jobs') {
    const files = store.open(folder);
    const kept = record(files, now());
    if (kept.problem !== null) throw new Error(kept.problem);
    return emit({ jobs: jobs(files, kept.claims, now()) });
  }
  if (list.length === 2 && action === 'purchases' && (name === 'on' || name === 'off')) {
    const saved = await settings.write(folder, { purchases: name === 'on' });
    return emit({
      purchases: saved.purchases ? 'on' : 'off',
      ceiling_per_24_hours: limitsOf(saved.ceiling),
      note: saved.purchases
        ? 'A confirmation in chat now buys. A quote that was made while purchases were off still rehearses: send the prompt again for a new quote.'
        : 'A confirmation in chat now runs a rehearsal and buys nothing.'
    });
  }
  if (list.length === 3 && action === 'ceiling' && typeof name === 'string' && Object.hasOwn(LIMIT_NAMES, name)) {
    const saved = await settings.write(folder, { ceiling: { [LIMIT_NAMES[name]]: limitOf(name, value) } });
    return emit({ purchases: saved.purchases ? 'on' : 'off', ceiling_per_24_hours: limitsOf(saved.ceiling) });
  }
  throw new Error(USAGE);
}

module.exports = { run };
