'use strict';
// The second line of defence of the video picker: purchases from chat are off
// until they are switched on (a confirmation then runs a rehearsal), and a
// ceiling limits what is bought in any 24 hours.
//
// Everything runs against fakes: no provider, no network, no credential.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  STORE, store, ENTRY, OTHER, PROMPT, HOUR, DEFAULT_CEILING, WIDE,
  generator, world, recordsOf, ask, request, quoted, confirming, submitsOf, unknownText, withFs
} = require('./video-picker-world');

const DAY = 24 * HOUR;
const REHEARSAL_LINE = 'Purchases from chat are switched off: a `yes` runs a rehearsal and buys nothing.';
const BUY_LINE = 'Nothing has been bought. To buy this clip, reply with only `yes` (or `da`). To drop it, reply `no`.';
const WAS_REHEARSAL = 'That quote was a rehearsal; nothing was bought.';
const rehearsalText = (id) => [
  `Rehearsal of one clip: Seedance 2.5 - 720p - Krea, at most 856 units (quote ${id}). Nothing is sent.`,
  'Pretend job is scheduled.',
  'Generating ... processing 35 % ...... processing 75 % ........',
  'Rehearsal: nothing was bought. To buy from chat, run `dshproxy video picker purchases on`, then send the prompt again for a new quote.'
].join('\n');
const noQuote = (limit) => `There is no quote: with this clip, more than ${limit} would be bought in 24 hours. Nothing was bought. \`dshproxy video picker\` shows the limits and what is used.`;
const notBought = (limit) => `Nothing was bought: with this clip, more than ${limit} would be bought in 24 hours. The quote was not used. \`dshproxy video picker\` shows the limits and what is used.`;
const overCeiling = (id) => `Nothing was bought with quote ${id}: the ceiling for 24 hours is reached. A quote is used once. Send the prompt again for a new one.`;
const NOTHING_USED = { clips: 0, krea_units: 0, usd_micros: 0, callirra_credits: 0 };

// Entries on API routes, in the other two units.
const DOLLARS = 'wan-3.0/720p/videorouter';
const CREDITS = 'wan-3.0/720p/callirra';
function withApiEntries(w) {
  w.more[DOLLARS] = { model: 'wan-3.0', resolution: '720p', route: 'videorouter', label: 'Wan 3.0 - 720p - VideoRouter', unit: 'usd_micros' };
  w.more[CREDITS] = { model: 'wan-3.0', resolution: '720p', route: 'callirra', label: 'Wan 3.0 - 720p - Callirra', unit: 'callirra_credits' };
  w.offer = (asked) => {
    if (asked.route === 'videorouter') return { ok: true, amount: 850000, published: '2026-11-20' };
    if (asked.route === 'callirra') return { ok: true, amount: 10, published: '2026-11-20' };
    return { ok: true, amount: 856, unit: 'krea_units', estimated: false, available: 97909.73 };
  };
}
const buys = async (w, quote) => {
  const text = await ask(w, confirming(quote));
  assert.match(text, /^Buying one clip: /);
  return text;
};

// ------------------------------- the switch and the rehearsal -------------------------------

test('purchases from chat are off until they are switched on: without a settings file a confirmation runs a rehearsal and buys nothing', { timeout: 60000 }, async (t) => {
  const w = world(t, { settings: false });
  const quote = await quoted(w);
  // The quote says what a `yes` will do, in the place of the line that offers the purchase.
  assert.ok(quote.text.includes(`\n\n${REHEARSAL_LINE}\nThe quote stands until `), quote.text);
  assert.ok(!quote.text.includes(BUY_LINE));
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.files.folder, 'quotes', `${quote.id}.json`), 'utf8')).rehearsal, true);

  const started = w.clock.time;
  assert.equal(await ask(w, confirming(quote)), rehearsalText(quote.id));
  // A pretend job is followed for three minutes; nothing went to anybody.
  assert.equal(w.clock.time - started, 180000);
  assert.deepEqual([w.calls.submit.length, w.calls.status.length, w.calls.quote.length], [0, 0, 1]);

  // The whole path ran but the paid request: the quote is claimed and spent.
  const claim = w.files.claimOf(quote.id);
  assert.deepEqual(claim.record, { id: quote.id, nonce: claim.record.nonce, entry: ENTRY, amount: 856, unit: 'krea_units', cap: '856', claimedAt: started });
  assert.deepEqual(JSON.parse(fs.readFileSync(w.files.outcomeFile(quote.id), 'utf8')), { state: 'rehearsal', nonce: claim.record.nonce });
  w.restart();
  for (const word of ['yes', 'da', 'status', 'ok']) assert.equal(await ask(w, request(ENTRY, [...quote.turns, ['user', word]])), WAS_REHEARSAL, word);
  assert.equal(recordsOf(w).length, 1);
  // It does not count against the ceiling, and the picker wrote no settings file.
  assert.deepEqual(w.files.usage(w.clock.time), NOTHING_USED);
  assert.equal(fs.existsSync(w.settingsFile), false);
  assert.equal(w.calls.submit.length, 0);
  assert.ok(w.logs.some((line) => line.includes(`outcome of ${quote.id}: rehearsal`)));
});

test('a rehearsal is cut short when the client goes away, and it stays a rehearsal', async (t) => {
  const w = world(t, { purchases: false });
  const quote = await quoted(w);
  let seen = '';
  await w.picker.answer(confirming(quote), (piece) => {
    seen += piece;
    if (seen.includes('35 %')) throw new Error('the client went away');
  });
  assert.ok(seen.endsWith('processing 35 % '), seen);
  assert.equal(await ask(w, confirming(quote)), WAS_REHEARSAL);
  assert.equal(w.calls.submit.length, 0);
});

test('the switch counts when the quote is made and when it is confirmed: a `yes` buys only if purchases were on both times', { timeout: 60000 }, async (t) => {
  const w = world(t, { purchases: true });
  // On, then switched off before the `yes`.
  const first = await quoted(w, 'Clip one');
  assert.ok(first.text.includes(BUY_LINE) && !first.text.includes(REHEARSAL_LINE));
  w.settings({ purchases: false });
  assert.equal(await ask(w, confirming(first)), rehearsalText(first.id));
  // Off, then switched on before the `yes`: the quote announced a rehearsal, and that is what it gets.
  const second = await quoted(w, 'Clip two');
  assert.ok(second.text.includes(REHEARSAL_LINE));
  w.settings({ purchases: true });
  assert.equal(await ask(w, confirming(second)), rehearsalText(second.id));
  assert.equal(w.calls.submit.length, 0);
  for (const quote of [first, second]) assert.equal(await ask(w, confirming(quote)), WAS_REHEARSAL);
  // On both times.
  const third = await quoted(w, 'Clip three');
  await buys(w, third);
  assert.deepEqual(w.calls.submit.map((order) => order.id), [third.id]);
  assert.deepEqual(w.files.usage(w.clock.time), { ...NOTHING_USED, clips: 1, krea_units: 856000000 });
});

test('a settings file that cannot be read as settings means purchases are off and the default ceiling; it is never rewritten', { timeout: 120000 }, async (t) => {
  const valid = { purchases: true, ceiling: { ...DEFAULT_CEILING } };
  const broken = {
    'not JSON': '{ "purchases": true, ',
    'empty': '',
    'a list': '[true]',
    'no ceiling': JSON.stringify({ purchases: true }),
    'purchases as a word': JSON.stringify({ ...valid, purchases: 'true' }),
    'purchases as a number': JSON.stringify({ ...valid, purchases: 1 }),
    'a key too many': JSON.stringify({ ...valid, note: 'mine' }),
    'a limit missing': JSON.stringify({ purchases: true, ceiling: { clips: 10, krea_units: 15000, usd_micros: 20000000 } }),
    'a limit too many': JSON.stringify({ purchases: true, ceiling: { ...DEFAULT_CEILING, usd: 20 } }),
    'a negative limit': JSON.stringify({ purchases: true, ceiling: { ...DEFAULT_CEILING, clips: -1 } }),
    'a fraction': JSON.stringify({ purchases: true, ceiling: { ...DEFAULT_CEILING, krea_units: 15000.5 } }),
    'too many clips': JSON.stringify({ purchases: true, ceiling: { ...DEFAULT_CEILING, clips: 1001 } }),
    'an amount out of bounds': JSON.stringify({ purchases: true, ceiling: { ...DEFAULT_CEILING, usd_micros: 1e12 + 1 } }),
    'a limit as text': JSON.stringify({ purchases: true, ceiling: { ...DEFAULT_CEILING, clips: '10' } }),
    'a folder in its place': null
  };
  for (const [name, content] of Object.entries(broken)) {
    const w = world(t, { settings: false });
    // Eleven clips were bought under a wide ceiling.
    w.setSettings({ purchases: true, ceiling: WIDE });
    const quotes = [];
    for (let index = 0; index < 11; index += 1) quotes.push(await quoted(w, `Clip ${index}`));
    for (const quote of quotes.slice(0, 10)) await buys(w, quote);
    fs.unlinkSync(w.settingsFile);
    if (content === null) fs.mkdirSync(w.settingsFile);
    else fs.writeFileSync(w.settingsFile, content);

    // The default ceiling of ten clips applies: no quote, and the open one does not buy.
    assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), noQuote('10 clips'), name);
    assert.equal(await ask(w, confirming(quotes[10])), notBought('10 clips'), name);
    // A day later the ceiling is free again; a confirmation still only rehearses.
    w.clock.time += DAY;
    const quote = await quoted(w);
    assert.ok(quote.text.includes(REHEARSAL_LINE), name);
    assert.equal(await ask(w, confirming(quote)), rehearsalText(quote.id), name);
    assert.equal(w.calls.submit.length, 10, name);
    if (content === null) assert.ok(fs.statSync(w.settingsFile).isDirectory());
    else assert.equal(fs.readFileSync(w.settingsFile, 'utf8'), content, `${name}: the settings file was rewritten`);
  }
});

test('the default ceiling is 10 clips, 15,000 Krea units, 20 dollars and 2,000 Callirra credits in 24 hours', async (t) => {
  const w = world(t, { settings: false });
  w.setSettings({ purchases: true, ceiling: DEFAULT_CEILING });
  withApiEntries(w);
  // 15,000 units: 7,000 + 7,000 fit, 1,001 more do not.
  w.offer = (asked) => (asked.route === 'krea' ? { ok: true, amount: w.units } : asked.route === 'callirra' ? { ok: true, amount: w.credits, published: '2026-11-20' } : { ok: true, amount: w.micros, published: '2026-11-20' });
  w.units = 7000;
  await buys(w, await quoted(w, 'Clip 1'));
  await buys(w, await quoted(w, 'Clip 2'));
  w.units = 1001;
  assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), noQuote('15,000 Krea compute units'));
  w.units = 1000;
  await buys(w, await quoted(w, 'Clip 3'));
  // 20 dollars.
  w.micros = 19990000;
  await buys(w, await quoted(w, 'Clip 4', DOLLARS));
  w.micros = 10001;
  assert.equal(await ask(w, request(DOLLARS, [['user', PROMPT]])), noQuote('$20.00'));
  // 2,000 credits.
  w.credits = 2000;
  await buys(w, await quoted(w, 'Clip 5', CREDITS));
  w.credits = 1;
  assert.equal(await ask(w, request(CREDITS, [['user', PROMPT]])), noQuote('2,000 Callirra credits'));
  // 10 clips over all routes.
  w.micros = 1;
  for (let index = 6; index <= 10; index += 1) await buys(w, await quoted(w, `Clip ${index}`, DOLLARS));
  const asked = w.calls.quote.length;
  for (const entry of [ENTRY, DOLLARS, CREDITS]) assert.equal(await ask(w, request(entry, [['user', PROMPT]])), noQuote('10 clips'));
  assert.equal(w.calls.quote.length, asked, 'a clip the ceiling cannot allow is not even priced');
  assert.equal(w.calls.submit.length, 10);
  assert.deepEqual(w.files.usage(w.clock.time), { clips: 10, krea_units: 15000000000, usd_micros: 19990005, callirra_credits: 2000 });
});

// ------------------------------- each limit alone -------------------------------

test('the limit on clips: over all routes, checked before the claim, and a refusal does not spend the quote', async (t) => {
  const w = world(t, { ceiling: { clips: 2 } });
  withApiEntries(w);
  const quotes = [await quoted(w, 'Clip 1'), await quoted(w, 'Clip 2', DOLLARS), await quoted(w, 'Clip 3', CREDITS), await quoted(w, 'Clip 4', OTHER)];
  await buys(w, quotes[0]);
  await buys(w, quotes[1]);
  const journal = fs.readFileSync(w.files.journal, 'utf8');
  for (const quote of quotes.slice(2)) {
    for (const word of ['yes', 'da']) assert.equal(await ask(w, confirming(quote, word)), notBought('2 clips'));
    assert.equal(w.files.claimOf(quote.id), null);
  }
  const asked = w.calls.quote.length;
  assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), noQuote('2 clips'));
  assert.equal(w.calls.quote.length, asked);
  assert.equal(fs.readFileSync(w.files.journal, 'utf8'), journal, 'a refusal by the ceiling writes nothing to the journal');
  assert.equal(w.calls.submit.length, 2);

  // The limit is raised with the quote still open: the same `yes` now buys, once.
  w.settings({ ceiling: { clips: 3 } });
  await buys(w, quotes[2]);
  assert.equal(await ask(w, confirming(quotes[3])), notBought('3 clips'));
  assert.equal(w.calls.submit.length, 3);
  // A limit of 1 is one clip; a limit of nothing is no clip.
  const one = world(t, { ceiling: { clips: 1 } });
  const single = [await quoted(one, 'Clip 1'), await quoted(one, 'Clip 2')];
  await buys(one, single[0]);
  assert.equal(await ask(one, confirming(single[1])), notBought('1 clip'));
  const none = world(t, { ceiling: { clips: 0 } });
  assert.equal(await ask(none, request(ENTRY, [['user', PROMPT]])), noQuote('0 clips'));
  assert.deepEqual([none.calls.quote.length, none.calls.submit.length], [0, 0]);
});

test('the limit on Krea units: the quoted amounts of 24 hours, counted as the caps that are sent', async (t) => {
  // Two clips of 856 are exactly 1,712.
  const w = world(t, { ceiling: { krea_units: 1712 } });
  withApiEntries(w);
  const quotes = [await quoted(w, 'Clip 1'), await quoted(w, 'Clip 2', OTHER), await quoted(w, 'Clip 3')];
  await buys(w, quotes[0]);
  await buys(w, quotes[1]);
  assert.equal(await ask(w, confirming(quotes[2])), notBought('1,712 Krea compute units'));
  assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), noQuote('1,712 Krea compute units'));
  assert.equal(w.files.claimOf(quotes[2].id), null);
  // Other units have limits of their own.
  await buys(w, await quoted(w, 'Clip 4', DOLLARS));
  await buys(w, await quoted(w, 'Clip 5', CREDITS));
  assert.equal(w.calls.submit.length, 4);

  // A fractional quote counts as its cap, which is rounded up: twice 380.333334 is over 760, not over 761.
  for (const [limit, fits] of [[760, false], [761, true]]) {
    const f = world(t, { ceiling: { krea_units: limit } });
    f.offer = () => ({ ok: true, amount: 380.33333333333326, available: 5000 });
    const pair = [await quoted(f, 'Clip 1'), await quoted(f, 'Clip 2')];
    assert.match(await ask(f, confirming(pair[0])), /^Buying one clip: Seedance 2\.5 - 720p - Krea, at most 380\.333334 units/);
    const second = await ask(f, confirming(pair[1]));
    if (fits) assert.match(second, /^Buying one clip: /);
    else assert.equal(second, notBought('760 Krea compute units'));
    assert.equal(f.calls.submit.length, fits ? 2 : 1);
    assert.equal(f.files.usage(f.clock.time).krea_units, fits ? 760666668 : 380333334);
  }
});

test('the limit on dollars and the limit on Callirra credits', async (t) => {
  const w = world(t, { ceiling: { usd_micros: 1700000, callirra_credits: 25 } });
  withApiEntries(w);
  // Two clips of $0.85 are exactly $1.70.
  const dollars = [await quoted(w, 'Clip 1', DOLLARS), await quoted(w, 'Clip 2', DOLLARS), await quoted(w, 'Clip 3', DOLLARS)];
  assert.ok(dollars[0].text.includes('- Cost: at most $0.85.\n'), dollars[0].text);
  await buys(w, dollars[0]);
  await buys(w, dollars[1]);
  assert.equal(await ask(w, confirming(dollars[2])), notBought('$1.70'));
  assert.equal(await ask(w, request(DOLLARS, [['user', PROMPT]])), noQuote('$1.70'));
  // Two clips of 10 credits fit in 25; a third does not.
  const credits = [await quoted(w, 'Clip 4', CREDITS), await quoted(w, 'Clip 5', CREDITS), await quoted(w, 'Clip 6', CREDITS)];
  assert.ok(credits[0].text.includes('- Cost: at most 10 Callirra credits.\n'), credits[0].text);
  assert.match(await ask(w, confirming(credits[0])), /^Buying one clip: Wan 3\.0 - 720p - Callirra, at most 10 credits \(quote /);
  await buys(w, credits[1]);
  assert.equal(await ask(w, confirming(credits[2])), notBought('25 Callirra credits'));
  assert.equal(await ask(w, request(CREDITS, [['user', PROMPT]])), noQuote('25 Callirra credits'));
  // Krea units are not touched by either.
  await buys(w, await quoted(w, 'Clip 7'));
  assert.equal(w.calls.submit.length, 5);
  assert.deepEqual(w.files.usage(w.clock.time), { clips: 5, krea_units: 856000000, usd_micros: 1700000, callirra_credits: 20 });
  assert.deepEqual(w.calls.submit.map((order) => [order.unit, order.amount, order.cap]), [
    ['usd_micros', 850000, '0.85'], ['usd_micros', 850000, '0.85'], ['callirra_credits', 10, '10'], ['callirra_credits', 10, '10'], ['krea_units', 856, '856']
  ]);

  // Dollars are shown with two to four decimals, never as less than the limit that is sent.
  const d = world(t);
  withApiEntries(d);
  for (const [micros, shown, cap] of [[702125, '$0.7022', '0.702125'], [702100, '$0.7021', '0.7021'], [1000000, '$1.00', '1'], [1234500000, '$1,234.50', '1234.5'], [1, '$0.0001', '0.000001'], [120000, '$0.12', '0.12'], [125000, '$0.125', '0.125']]) {
    d.offer = () => ({ ok: true, amount: micros, published: '2026-11-20' });
    const quote = await quoted(d, `Clip for ${micros}`, DOLLARS);
    assert.ok(quote.text.includes(`- Cost: at most ${shown}.\n`), quote.text);
    await buys(d, quote);
    assert.equal(d.calls.submit.at(-1).cap, cap);
  }
  // An amount that is not a whole number of millionths, or of credits, is no quote.
  for (const [entry, amount] of [[DOLLARS, 0.85], [DOLLARS, 850000.5], [CREDITS, 10.5], [CREDITS, 0], [ENTRY, -1], [ENTRY, 1e9]]) {
    d.offer = () => ({ ok: true, amount, published: '2026-11-20' });
    assert.equal(await ask(d, request(entry, [['user', PROMPT]])), 'No quote could be made just now. Nothing was bought. Send the prompt again later.');
  }
});

// ------------------------------- what counts, and for how long -------------------------------

test('an outcome that is not known counts in full; "not sent", a rehearsal and a dropped quote do not count', { timeout: 60000 }, async (t) => {
  const w = world(t, { ceiling: { clips: 3 } });
  // Nothing of this counts.
  for (let index = 0; index < 4; index += 1) {
    w.submitPlan.push('not-sent');
    const quote = await quoted(w, `Not sent ${index}`);
    assert.equal(await ask(w, confirming(quote)), `Buying one clip: Seedance 2.5 - 720p - Krea, at most 856 units (quote ${quote.id}).\nNothing was bought with quote ${quote.id}: the price is now above the quoted amount. A quote is used once. Send the prompt again for a new one.`);
  }
  for (let index = 0; index < 4; index += 1) assert.equal(await ask(w, request(ENTRY, [...(await quoted(w, `Dropped ${index}`)).turns, ['user', 'no']])), 'Dropped. Nothing was bought.');
  w.settings({ purchases: false });
  for (let index = 0; index < 4; index += 1) await ask(w, confirming(await quoted(w, `Rehearsed ${index}`)));
  w.settings({ purchases: true });
  assert.equal(recordsOf(w).length, 12);
  assert.deepEqual(w.files.usage(w.clock.time), NOTHING_USED);

  // Each of these counts as a clip of 856 units: the child wrote nothing, it failed, it never came back.
  const silent = await quoted(w, 'Silent');
  w.submitPlan.push('silent');
  assert.ok((await ask(w, confirming(silent))).endsWith(unknownText(silent.id)));
  const thrown = await quoted(w, 'Thrown');
  w.submitPlan.push('throw');
  assert.ok((await ask(w, confirming(thrown))).endsWith(unknownText(thrown.id)));
  const hanging = await quoted(w, 'Hanging');
  const last = await quoted(w, 'One too many');
  w.submitPlan.push('hang');
  const hung = w.hung();
  w.picker.answer(confirming(hanging), () => {});
  await hung;
  w.restart();
  assert.deepEqual(w.files.usage(w.clock.time), { ...NOTHING_USED, clips: 3, krea_units: 2568000000 });
  assert.equal(await ask(w, confirming(last)), notBought('3 clips'));
  assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), noQuote('3 clips'));
  assert.equal(w.calls.submit.length, 7);
  assert.equal(w.files.claimOf(last.id), null);

  // A claim whose line cannot be read counts with the amount of its quote.
  const d = world(t, { ceiling: { clips: 1 } });
  const torn = await quoted(d, 'Torn');
  fs.appendFileSync(d.files.journal, `\n{"id":"${torn.id}","nonce":"`);
  assert.deepEqual(d.files.usage(d.clock.time), { ...NOTHING_USED, clips: 1, krea_units: 856000000 });
  assert.equal(await ask(d, request(ENTRY, [['user', PROMPT]])), noQuote('1 clip'));
  // ... for a day after that quote ran out.
  d.clock.time += 600000 + DAY - 1;
  assert.equal(await ask(d, request(ENTRY, [['user', PROMPT]])), noQuote('1 clip'));
  d.clock.time += 1;
  await buys(d, await quoted(d, 'After the day'));
  assert.equal(d.calls.submit.length, 1);
});

test('the ceiling counts the 24 hours before now by the picker\'s clock', async (t) => {
  const w = world(t, { ceiling: { clips: 2, krea_units: 2000 } });
  const first = w.clock.time;
  await buys(w, await quoted(w, 'Clip 1'));
  w.clock.time = first + 6 * HOUR;
  await buys(w, await quoted(w, 'Clip 2'));
  assert.equal(recordsOf(w).map((line) => JSON.parse(line).claimedAt).join(), [first, first + 6 * HOUR].join());

  // One millisecond before the first purchase is a day old.
  w.clock.time = first + DAY - 1;
  w.restart();
  assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), noQuote('2 clips'));
  assert.equal(w.calls.quote.length, 2);
  // A day after it: one clip is free, and only one.
  w.clock.time = first + DAY;
  const third = await quoted(w, 'Clip 3');
  const fourth = await quoted(w, 'Clip 4');
  await buys(w, third);
  assert.equal(await ask(w, confirming(fourth)), notBought('2 clips and 2,000 Krea compute units'));
  // A clock that was set back: a purchase "from the future" still counts.
  w.clock.time = first - HOUR;
  assert.deepEqual(w.files.usage(w.clock.time), { ...NOTHING_USED, clips: 3, krea_units: 2568000000 });
  assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), noQuote('2 clips and 2,000 Krea compute units'));
  assert.equal(w.calls.submit.length, 3);
});

// ------------------------------- two purchases at the same moment -------------------------------

test('two confirmations of different quotes at the same moment, with room for one: never two purchases', { timeout: 60000 }, async (t) => {
  // Through two pickers on one folder.
  const w = world(t, { ceiling: { clips: 1 } });
  const pair = [await quoted(w, 'Clip A'), await quoted(w, 'Clip B', OTHER)];
  const answers = await Promise.all([ask(w, confirming(pair[0]), w.another()), ask(w, confirming(pair[1]), w.another())]);
  assert.equal(w.calls.submit.length, 1, `submit was called ${w.calls.submit.length} times with room for one clip`);
  assert.equal(answers.filter((text) => text.startsWith('Buying one clip: ')).length, 1);
  assert.equal(answers.filter((text) => text === notBought('1 clip')).length, 1);

  // Both have counted before either has claimed. Another process is played by
  // a second store on the folder, called at the moment the first one appends
  // its line: it claims quote B, counts, and finds room.
  const claimOfB = (quote, at) => ({ id: quote.id, entry: OTHER, amount: 856, unit: 'krea_units', cap: '856', claimedAt: at });
  {
    const x = world(t, { ceiling: { clips: 1 } });
    const [a, b] = [await quoted(x, 'Clip A'), await quoted(x, 'Clip B', OTHER)];
    const other = store.open(x.home);
    let theirs = null;
    let entered = false;
    const text = await withFs('openSync', (original, file, flags, ...rest) => {
      if (file === x.files.journal && typeof flags === 'number' && !entered) {
        entered = true;
        theirs = other.admit(claimOfB(b, x.clock.time), { ...WIDE, clips: 1 });
      }
      return original(file, flags, ...rest);
    }, () => ask(x, confirming(a)));
    assert.deepEqual([theirs.held, theirs.over], [true, []], 'the other process bought');
    const purchases = x.calls.submit.length + 1;
    assert.equal(purchases, 1, `${purchases} purchases with room for one clip`);
    // This one claimed second, counted again with its own claim, and did not send.
    assert.equal(text, overCeiling(a.id));
    const claim = x.files.claimOf(a.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(x.files.outcomeFile(a.id), 'utf8')), { state: 'not-sent', nonce: claim.record.nonce, reason: 'ceiling' });
    // The quote is spent, and its claim does not count.
    for (const word of ['yes', 'status']) assert.equal(await ask(x, request(ENTRY, [...a.turns, ['user', word]])), overCeiling(a.id));
    assert.equal(x.files.usage(x.clock.time).clips, 1);
    assert.equal(x.calls.submit.length, 0);
  }

  // The other process claims and counts after this one's line is in the
  // journal and before this one has counted: it sees this one's claim and
  // refuses, and this one, counting after that refusal was written, buys.
  {
    const x = world(t, { ceiling: { clips: 1 } });
    const [a, b] = [await quoted(x, 'Clip A'), await quoted(x, 'Clip B', OTHER)];
    const other = store.open(x.home);
    const size = fs.statSync(x.files.journal).size;
    let theirs = null;
    const text = await withFs('readFileSync', (original, file, ...rest) => {
      if (file === x.files.journal && theirs === null && fs.statSync(file).size > size) {
        theirs = false;
        theirs = other.admit(claimOfB(b, x.clock.time), { ...WIDE, clips: 1 });
      }
      return original(file, ...rest);
    }, () => ask(x, confirming(a)));
    assert.deepEqual([theirs.held, theirs.over], [true, ['clips']]);
    assert.match(text, /^Buying one clip: /);
    assert.equal(x.calls.submit.length, 1, `${x.calls.submit.length} purchases with room for one clip`);
    assert.equal(await ask(x, confirming(b)), overCeiling(b.id));
    assert.equal(x.calls.submit.length, 1);
  }

  // The other process has claimed and not yet counted when this one counts,
  // and counts before this one's refusal is written. Each claim is counted
  // with the claims before it in the journal, so the earlier one is not held
  // up by the later: the other buys, this one does not.
  {
    const x = world(t, { ceiling: { clips: 1 } });
    const [a, b] = [await quoted(x, 'Clip A'), await quoted(x, 'Clip B', OTHER)];
    const other = store.open(x.home);
    const limits = { ...WIDE, clips: 1 };
    let theirs = null;
    let theirOver = null;
    let everything = null;
    const text = await withFs('openSync', (original, file, flags, ...rest) => {
      if (file === x.files.journal && typeof flags === 'number' && theirs === null) {
        theirs = false;
        theirs = other.claim(claimOfB(b, x.clock.time));
      }
      if (file === x.files.outcomeFile(a.id) && flags === 'wx' && theirOver === null) {
        theirOver = store.exceeded(other.usage(x.clock.time, b.id), limits, 'krea_units');
        everything = other.usage(x.clock.time);
      }
      return original(file, flags, ...rest);
    }, () => ask(x, confirming(a)));
    assert.equal(theirs.held, true);
    assert.deepEqual(theirOver, [], 'the earlier claim in the journal has room');
    // At that moment both claims were in the journal without an outcome.
    assert.equal(everything.clips, 2);
    assert.equal(text, overCeiling(a.id));
    const purchases = x.calls.submit.length + 1;
    assert.equal(purchases, 1, `${purchases} purchases with room for one clip`);
    assert.equal(x.files.usage(x.clock.time).clips, 1);
    assert.equal(await ask(x, request(ENTRY, [['user', PROMPT]])), noQuote('1 clip'));
  }

  // The same for a limit on an amount: room for 856 units more, and two clips of 856.
  {
    const x = world(t, { ceiling: { krea_units: 1712 } });
    await buys(x, await quoted(x, 'Clip 0'));
    const [a, b] = [await quoted(x, 'Clip A'), await quoted(x, 'Clip B', OTHER)];
    const other = store.open(x.home);
    let theirs = null;
    const text = await withFs('openSync', (original, file, flags, ...rest) => {
      if (file === x.files.journal && typeof flags === 'number' && theirs === null) {
        theirs = false;
        theirs = other.admit(claimOfB(b, x.clock.time), { ...WIDE, krea_units: 1712 });
      }
      return original(file, flags, ...rest);
    }, () => ask(x, confirming(a)));
    assert.deepEqual([theirs.held, theirs.over], [true, []]);
    assert.equal(text, overCeiling(a.id));
    assert.equal(submitsOf(x, a.id), 0);
    assert.equal(x.calls.submit.length, 1);
  }
});

// Each child reports that it is ready and then waits for the file `go`, so
// that all of them claim within the same millisecond or so. None of them can
// call a submit: they load the store alone. Whoever is admitted with no limit
// exceeded would go on to buy.
const BUYER = `
  const fs = require('node:fs');
  const [go, storeFile, home, id, at] = process.argv.slice(1);
  const files = require(storeFile).open(home);
  fs.writeFileSync(go + '.ready.' + process.pid, '');
  const look = () => {
    if (!fs.existsSync(go)) return setImmediate(look);
    const mine = files.admit({ id, entry: 'seedance-2.5/720p/krea', amount: 856, unit: 'krea_units', cap: '856', claimedAt: Number(at) }, { clips: 1000, krea_units: 2000, usd_micros: 0, callirra_credits: 0 });
    process.stdout.write(JSON.stringify({ held: mine.held, over: mine.over }));
  };
  look();`;

test('six processes confirm six different quotes on one folder at the same moment, with room for two, ten times over: each time exactly two would buy', { timeout: 300000 }, async (t) => {
  const bytes = generator(20261124);
  const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const COUNT = 6;
  for (let round = 0; round < 10; round += 1) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-picker-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const files = store.open(home);
    files.init(Date.now());
    const at = Math.ceil(fs.statSync(files.journal).birthtimeMs) + HOUR;
    const go = path.join(home, 'go');
    const ids = Array.from({ length: COUNT }, () => store.newId((count) => Buffer.from(Array.from({ length: count }, () => bytes.int(256)))));
    const runs = ids.map((id) => new Promise((resolve) => {
      const proc = spawn(process.execPath, ['-e', BUYER, go, STORE, home, id, String(at)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk; });
      proc.stderr.on('data', (chunk) => { stderr += chunk; });
      proc.on('close', (status) => resolve({ status, stdout, stderr }));
    }));
    const deadline = Date.now() + 60000;
    while (fs.readdirSync(home).filter((name) => name.startsWith('go.ready.')).length < COUNT) {
      assert.ok(Date.now() < deadline, 'the child processes did not start');
      await pause(5);
    }
    fs.writeFileSync(go, '');
    const results = await Promise.all(runs);
    for (const result of results) assert.deepEqual([result.status, result.stderr], [0, ''], `round ${round}`);
    const admitted = results.map((result) => JSON.parse(result.stdout));
    // Every one of them holds the claim of its own quote.
    assert.equal(admitted.filter((mine) => mine.held).length, COUNT, `round ${round}`);
    const buyers = admitted.filter((mine) => mine.over.length === 0).length;
    // The first two in the journal: each claim is counted with those before it.
    assert.equal(buyers, 2, `round ${round}: ${buyers} processes would buy with room for two clips`);
    const order = fs.readFileSync(files.journal, 'utf8').split('\n').filter((line) => line.includes('Q-')).map((line) => JSON.parse(line).id);
    assert.deepEqual(ids.filter((id, index) => admitted[index].over.length === 0).sort(), order.slice(0, 2).sort(), `round ${round}`);
    // Those that were refused wrote their outcome, so they do not count afterwards.
    assert.equal(files.usage(at).clips, buyers, `round ${round}`);
    assert.equal(fs.readdirSync(path.join(files.folder, 'outcomes')).length, COUNT - buyers, `round ${round}`);
  }
});
