'use strict';
// `dshproxy video picker ...`: the switch and the ceiling of the video picker,
// and what was bought. Through run(args, out, options) with a throwaway data
// folder: no provider, no network, no credential.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PICKER, ENTRY, PROMPT, HOUR, DEFAULT_CEILING, world, ask, request, quoted, confirming } = require('./video-picker-world');
const { run } = require(path.join(PICKER, 'cli.js'));
const settings = require(path.join(PICKER, 'settings.js'));

function emptyHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-picker-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// Every file under a folder with its bytes: what a command may not change.
function snapshot(folder) {
  const found = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found[`${path.relative(folder, full)}${path.sep}`] = null;
        walk(full);
      } else found[path.relative(folder, full)] = fs.readFileSync(full, 'hex');
    }
  };
  walk(folder);
  return found;
}

async function command(home, args, now) {
  const lines = [];
  await run(args, (line) => { lines.push(line); }, { home, env: {}, ...(now === undefined ? {} : { now: () => now }) });
  return lines.join('\n');
}
const json = async (home, args, now) => JSON.parse(await command(home, args, now));
const saved = (home) => JSON.parse(fs.readFileSync(path.join(home, 'video-picker', 'settings.json'), 'utf8'));
const DEFAULT_SHOWN = { clips: 10, krea_units: 15000, usd: '20.00', callirra_credits: 2000 };

test('without arguments it shows the switch, the ceiling, the use of the last 24 hours and the last jobs, and writes nothing', async (t) => {
  const home = emptyHome(t);
  assert.deepEqual(await json(home, []), {
    purchases: 'off',
    ceiling_per_24_hours: DEFAULT_SHOWN,
    used_last_24_hours: { clips: 0, krea_units: 0, usd: '0.00', callirra_credits: 0 },
    last_jobs: []
  });
  assert.deepEqual(await json(home, ['jobs']), { jobs: [] });
  assert.match(await command(home, ['help']), /^dshproxy video picker /);
  assert.deepEqual(fs.readdirSync(home), [], 'looking made a file or a folder');
});

test('purchases on and off, and each of the four limits, change settings.json and nothing else', async (t) => {
  const home = emptyHome(t);
  assert.deepEqual(await json(home, ['purchases', 'on']), {
    purchases: 'on',
    ceiling_per_24_hours: DEFAULT_SHOWN,
    note: 'A confirmation in chat now buys. A quote that was made while purchases were off still rehearses: send the prompt again for a new quote.'
  });
  assert.deepEqual(saved(home), { purchases: true, ceiling: DEFAULT_CEILING });
  assert.equal(fs.readFileSync(path.join(home, 'video-picker', 'settings.json'), 'utf8'), `${JSON.stringify({ purchases: true, ceiling: DEFAULT_CEILING }, null, 2)}\n`);

  assert.deepEqual((await json(home, ['ceiling', 'clips', '3'])).ceiling_per_24_hours, { ...DEFAULT_SHOWN, clips: 3 });
  assert.deepEqual((await json(home, ['ceiling', 'units', '5000'])).ceiling_per_24_hours, { ...DEFAULT_SHOWN, clips: 3, krea_units: 5000 });
  assert.deepEqual((await json(home, ['ceiling', 'usd', '12.5'])).ceiling_per_24_hours, { clips: 3, krea_units: 5000, usd: '12.50', callirra_credits: 2000 });
  assert.deepEqual((await json(home, ['ceiling', 'credits', '0'])).ceiling_per_24_hours, { clips: 3, krea_units: 5000, usd: '12.50', callirra_credits: 0 });
  assert.deepEqual(saved(home), { purchases: true, ceiling: { clips: 3, krea_units: 5000, usd_micros: 12500000, callirra_credits: 0 } });
  // Dollars are kept as whole millionths.
  for (const [given, micros, shown] of [['0', 0, '0.00'], ['7', 7000000, '7.00'], ['0.01', 10000, '0.01'], ['19.99', 19990000, '19.99'], ['1000000', 1e12, '1000000.00']]) {
    assert.equal((await json(home, ['ceiling', 'usd', given])).ceiling_per_24_hours.usd, shown);
    assert.equal(saved(home).ceiling.usd_micros, micros);
  }
  // The largest values, and the smallest.
  await command(home, ['ceiling', 'clips', '1000']);
  await command(home, ['ceiling', 'units', '1000000000000']);
  await command(home, ['ceiling', 'credits', '1000000000000']);
  assert.deepEqual(saved(home).ceiling, { clips: 1000, krea_units: 1e12, usd_micros: 1e12, callirra_credits: 1e12 });
  await command(home, ['ceiling', 'clips', '0']);

  assert.deepEqual(await json(home, ['purchases', 'off']), {
    purchases: 'off',
    ceiling_per_24_hours: { clips: 0, krea_units: 1e12, usd: '1000000.00', callirra_credits: 1e12 },
    note: 'A confirmation in chat now runs a rehearsal and buys nothing.'
  });
  assert.equal(saved(home).purchases, false);
  assert.equal((await json(home, [])).purchases, 'off');
  // The file is all there is: no lock and no temporary file is left behind.
  assert.deepEqual(Object.keys(snapshot(home)), [`video-picker${path.sep}`, path.join('video-picker', 'settings.json')]);
});

test('anything that is not one of the commands, and any value out of bounds, is refused and changes nothing', async (t) => {
  const home = emptyHome(t);
  await command(home, ['ceiling', 'clips', '4']);
  const before = snapshot(home);
  const usage = /^dshproxy video picker +Purchases from chat on or off/;
  const refused = [
    [['purchases'], usage],
    [['purchases', 'maybe'], usage],
    [['purchases', 'ON'], usage],
    [['purchases', 'on', 'now'], usage],
    [['ceiling'], usage],
    [['ceiling', 'clips'], usage],
    [['ceiling', 'dollars', '5'], usage],
    [['ceiling', 'usd_micros', '5'], usage],
    [['ceiling', 'constructor', '5'], usage],
    [['ceiling', 'clips', '5', '6'], usage],
    [['jobs', 'all'], usage],
    [['status'], usage],
    [['--json'], usage],
    [['submit', 'seedance-2.5', 'krea', PROMPT], usage],
    [[''], usage],
    [['ceiling', 'clips', '1001'], /^The number of clips must be a whole number from 0 to 1000\. Nothing was changed\.$/],
    [['ceiling', 'clips', '-1'], /^The number of clips must be a whole number/],
    [['ceiling', 'clips', '2.5'], /^The number of clips must be a whole number/],
    [['ceiling', 'clips', 'ten'], /^The number of clips must be a whole number/],
    [['ceiling', 'clips', ''], /^The number of clips must be a whole number/],
    [['ceiling', 'clips', '1e2'], /^The number of clips must be a whole number/],
    [['ceiling', 'clips', ' 5'], /^The number of clips must be a whole number/],
    [['ceiling', 'units', '1000000000001'], /^The number of Krea compute units must be a whole number from 0 to 1000000000000\. Nothing was changed\.$/],
    [['ceiling', 'units', '380.5'], /^The number of Krea compute units must be a whole number/],
    [['ceiling', 'credits', '99999999999999'], /^The number of Callirra credits must be a whole number/],
    [['ceiling', 'credits', '0x10'], /^The number of Callirra credits must be a whole number/],
    [['ceiling', 'usd', '1.234'], /^The amount must be US dollars from 0 to 1000000, with at most two decimals\. Nothing was changed\.$/],
    [['ceiling', 'usd', '1000000.01'], /^The amount must be US dollars/],
    [['ceiling', 'usd', '$5'], /^The amount must be US dollars/],
    [['ceiling', 'usd', '5,50'], /^The amount must be US dollars/],
    [['ceiling', 'usd', '-5'], /^The amount must be US dollars/],
    [['ceiling', 'usd', '.5'], /^The amount must be US dollars/]
  ];
  for (const [args, message] of refused) {
    const lines = [];
    await assert.rejects(run(args, (line) => { lines.push(line); }, { home, env: {} }), (error) => message.test(error.message), args.join(' '));
    assert.deepEqual(lines, [], args.join(' '));
    assert.deepEqual(snapshot(home), before, `${args.join(' ')} changed a file`);
  }
  assert.deepEqual(saved(home), { purchases: false, ceiling: { ...DEFAULT_CEILING, clips: 4 } });
});

test('a settings file that is not valid is shown as a problem, counts as off, and is not replaced until it is fixed', async (t) => {
  const home = emptyHome(t);
  fs.mkdirSync(path.join(home, 'video-picker'));
  const file = path.join(home, 'video-picker', 'settings.json');
  for (const content of ['{ "purchases": true', JSON.stringify({ purchases: true, ceiling: { ...DEFAULT_CEILING, clips: 5000 } }), JSON.stringify({ purchases: true })]) {
    fs.writeFileSync(file, content);
    const view = await json(home, []);
    assert.equal(view.purchases, 'off');
    assert.deepEqual(view.ceiling_per_24_hours, DEFAULT_SHOWN);
    assert.deepEqual(view.problems, [`${file} does not hold valid settings: purchases are off and the default ceiling applies. Fix the file or move it away.`]);
    for (const args of [['purchases', 'on'], ['purchases', 'off'], ['ceiling', 'clips', '3'], ['ceiling', 'usd', '5']]) {
      await assert.rejects(command(home, args), (error) => error.message === `${file} does not hold valid video picker settings. Fix it, or move it away to start again with purchases off and the default ceiling. Nothing was changed.`);
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    }
    assert.deepEqual(fs.readdirSync(path.join(home, 'video-picker')), ['settings.json']);
  }
  // Moved away, the commands work again.
  fs.unlinkSync(file);
  assert.equal((await json(home, ['purchases', 'on'])).purchases, 'on');
  // The module refuses what the command would never send.
  for (const change of [{}, { purchases: 'on' }, { ceiling: { clips: 1.5 } }, { ceiling: { clips: 1001 } }, { ceiling: { tokens: 1 } }, { ceiling: [] }, { purchases: true, extra: 1 }, null, { ceiling: { usd_micros: -1 } }]) {
    await assert.rejects(settings.write(home, change));
  }
  assert.deepEqual(saved(home), { purchases: true, ceiling: DEFAULT_CEILING });
});

test('the picker goes by what the command wrote, and the command shows what the picker did; it never writes a picker file', { timeout: 60000 }, async (t) => {
  const w = world(t, { settings: false });
  const home = w.home;
  // Off by default: a rehearsal.
  const rehearsed = await quoted(w, 'Clip one');
  await ask(w, confirming(rehearsed));
  await command(home, ['purchases', 'on']);
  await command(home, ['ceiling', 'clips', '2']);

  const first = await quoted(w, 'Clip two');
  assert.match(await ask(w, confirming(first)), /^Buying one clip: /);
  const dropped = await quoted(w, 'Clip three');
  await ask(w, request(ENTRY, [...dropped.turns, ['user', 'no']]));
  w.submitPlan.push('not-sent');
  const refusedQuote = await quoted(w, 'Clip four');
  await ask(w, confirming(refusedQuote));
  const unknown = await quoted(w, 'Clip five');
  const open = await quoted(w, 'Clip six');
  w.submitPlan.push('silent');
  await ask(w, confirming(unknown));
  // The ceiling of two clips that the command set is reached.
  assert.match(await ask(w, confirming(open)), /^Nothing was bought: with this clip, more than 2 clips would be bought in 24 hours\./);
  assert.equal(w.calls.submit.length, 3);
  await command(home, ['ceiling', 'clips', '3']);
  w.submitPlan.push('hang');
  const hung = w.hung();
  w.picker.answer(confirming(open), () => {});
  await hung;
  assert.match(await ask(w, request(ENTRY, [['user', 'Clip seven']])), /^There is no quote: with this clip, more than 3 clips would be bought in 24 hours\./);

  const before = snapshot(home);
  const now = w.clock.time;
  const view = await json(home, [], now);
  assert.equal(view.purchases, 'on');
  assert.deepEqual(view.ceiling_per_24_hours, { ...DEFAULT_SHOWN, clips: 3 });
  assert.deepEqual(view.used_last_24_hours, { clips: 3, krea_units: 2568, usd: '0.00', callirra_credits: 0 });
  const time = (id) => new Date(w.files.claimOf(id).record.claimedAt).toISOString();
  const row = (quote, state, job) => ({ quote: quote.id, entry: ENTRY, amount: '856 Krea compute units', state, job, time: time(quote.id) });
  // Newest first.
  const rows = [
    row(open, 'being sent', null),
    row(unknown, 'unknown', null),
    row(refusedQuote, 'not sent (over-cap)', null),
    row(dropped, 'declined', null),
    row(first, 'completed', 'job-1'),
    row(rehearsed, 'rehearsal', null)
  ];
  assert.deepEqual(view.last_jobs, rows);
  assert.deepEqual(await json(home, ['jobs'], now), { jobs: rows });
  // Three minutes later a claim without an outcome is no longer "being sent".
  assert.equal((await json(home, ['jobs'], now + 180000)).jobs[0].state, 'unknown');
  // A day later nothing of it is in use; the jobs are still listed.
  const later = await json(home, [], now + 24 * HOUR);
  assert.deepEqual(later.used_last_24_hours, { clips: 0, krea_units: 0, usd: '0.00', callirra_credits: 0 });
  assert.equal(later.last_jobs.length, 6);
  // Neither the overview nor the list wrote anything.
  assert.deepEqual(snapshot(home), before);

  // A change writes settings.json and no other file: the purchase record, the
  // quotes, the outcomes and the results are byte for byte what they were.
  for (const args of [['purchases', 'off'], ['ceiling', 'units', '100'], ['ceiling', 'usd', '1.5'], ['ceiling', 'credits', '7'], ['ceiling', 'clips', '9'], ['purchases', 'on']]) await command(home, args);
  const after = snapshot(home);
  const changed = Object.keys({ ...before, ...after }).filter((name) => before[name] !== after[name]);
  assert.deepEqual(changed, [path.join('video-picker', 'settings.json')]);
  assert.deepEqual(saved(home), { purchases: true, ceiling: { clips: 9, krea_units: 100, usd_micros: 1500000, callirra_credits: 7 } });
  // And the picker goes by it at its next request.
  assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), 'There is no quote: with this clip, more than 100 Krea compute units would be bought in 24 hours. Nothing was bought. `dshproxy video picker` shows the limits and what is used.');
});

test('the overview lists the last ten jobs; `jobs` lists them all, with amounts in each unit', async (t) => {
  const w = world(t);
  w.more['wan-3.0/720p/videorouter'] = { model: 'wan-3.0', resolution: '720p', route: 'videorouter', label: 'Wan 3.0 - 720p - VideoRouter', unit: 'usd_micros' };
  w.more['wan-3.0/720p/callirra'] = { model: 'wan-3.0', resolution: '720p', route: 'callirra', label: 'Wan 3.0 - 720p - Callirra', unit: 'callirra_credits' };
  w.offer = (asked) => (asked.route === 'krea' ? { ok: true, amount: 380.33333333333326 } : asked.route === 'callirra' ? { ok: true, amount: 10, published: '2026-11-20' } : { ok: true, amount: 702125, published: '2026-11-20' });
  const entries = [ENTRY, 'wan-3.0/720p/videorouter', 'wan-3.0/720p/callirra'];
  const quotes = [];
  for (let index = 0; index < 12; index += 1) {
    const quote = await quoted(w, `Clip ${index}`, entries[index % 3]);
    await ask(w, confirming(quote));
    quotes.push(quote);
    w.clock.time += 60000;
  }
  const view = await json(w.home, [], w.clock.time);
  assert.deepEqual(view.last_jobs.map((job) => job.quote), quotes.slice(2).reverse().map((quote) => quote.id));
  assert.deepEqual(view.used_last_24_hours, { clips: 12, krea_units: 1521.333336, usd: '2.8085', callirra_credits: 40 });
  const all = (await json(w.home, ['jobs'], w.clock.time)).jobs;
  assert.deepEqual(all.map((job) => job.quote), quotes.slice().reverse().map((quote) => quote.id));
  assert.deepEqual(all.slice(-3).reverse().map((job) => [job.entry, job.amount, job.state, job.job]), [
    [ENTRY, '380.333334 Krea compute units', 'completed', 'job-1'],
    ['wan-3.0/720p/videorouter', '$0.702125', 'completed', 'job-2'],
    ['wan-3.0/720p/callirra', '10 Callirra credits', 'completed', 'job-3']
  ]);
  for (const job of all) assert.match(job.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // A journal that is damaged or gone is said, not hidden.
  fs.appendFileSync(w.files.journal, `\n{"id":"${quotes[0].id}","nonce":`);
  assert.equal((await json(w.home, ['jobs'], w.clock.time)).jobs.length, 12);
  fs.renameSync(w.files.journal, `${w.files.journal}.away`);
  fs.mkdirSync(w.files.journal);
  assert.deepEqual((await json(w.home, [], w.clock.time)).problems, ['The purchase record cannot be read.']);
  await assert.rejects(command(w.home, ['jobs']), /^Error: The purchase record cannot be read\.$/);
});

test('the data folder comes from the options, then from DSHPROXY_HOME', async (t) => {
  const home = emptyHome(t);
  const lines = [];
  await run(['purchases', 'on'], (line) => { lines.push(line); }, { env: { DSHPROXY_HOME: home } });
  assert.equal(JSON.parse(lines.join('\n')).purchases, 'on');
  assert.deepEqual(saved(home), { purchases: true, ceiling: DEFAULT_CEILING });
});
