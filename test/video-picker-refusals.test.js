'use strict';
// Every request that is not the one confirmation of an open quote gets a
// plain answer and buys nothing: rows 4 to 14 of the design's table 4.3, one
// test each, with amendments A4 (text that is not a prompt never reaches a
// provider) and A6 (a confirmation that cannot be matched does not loop).
//
// Everything runs against fakes: no provider, no network, no credential.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  create, ENTRY, OTHER, PROMPT, HOUR, REMINDER, sampled, TITLE_SYSTEM, GOAL_ROUND, SCHEDULE_REMINDER,
  world, claimsText, recordsOf, ask, request, quoted, confirming, submitsOf, unknownText, titleRequest, compactionRequest
} = require('./video-picker-world');

const SWITCHED_OFF = 'This video entry is switched off in DSHProxy. Nothing was quoted or bought. Switch it on with `dshproxy video entries`, then run `dshproxy dsh apply`.';
const NOT_A_PROMPT = 'This entry makes video clips: type what the clip should show, in at most 16,000 bytes. Nothing was quoted or bought.';
const AUTOMATION = 'This entry makes a video from a prompt you type. Goals and scheduled tasks are not run here. Nothing was quoted or bought.';
const ATTACHMENT = 'This entry takes text only. Nothing was quoted or bought.';
const SILENT = 'I found no message from you. Type a prompt to get a quote.';
const STRAY = 'There is nothing to confirm: a `yes` buys only when it is the one reply directly after a quote. Nothing was bought. Send the prompt again to get a quote.';
const UNMATCHED = 'I could not match your confirmation to a quote, so nothing was bought. Type `status Q-…` with the quote\'s id to see it, or type the prompt again for a new quote.';
const DROPPED = 'Dropped. Nothing was bought.';
const NEAR = 'Nothing was bought. To buy the quoted clip, reply with only `yes` (or `da`). To drop it, reply `no`.';
const NO_JOB = 'There is no job in this conversation yet. Type a prompt to get a quote.';
const DAY = 24 * HOUR;

// What a test may not change: the number of quote requests and of purchases.
const calls = (w) => ({ quote: w.calls.quote.length, submit: w.calls.submit.length });
const after = (quote, word, shape) => request(quote.model, [...quote.turns, ['user', word]], shape);
// A quote that was bought; `history` is the conversation up to the answer.
async function bought(w, prompt = PROMPT, before = []) {
  const quote = await quoted(w, prompt, ENTRY, before);
  const text = await ask(w, confirming(quote));
  assert.match(text, /^Buying one clip: /);
  return { ...quote, answer: text, history: [...quote.turns, ['user', 'yes'], ['assistant', text]] };
}

// ------------------------------- row 4 -------------------------------

test('row 4: an entry that is not switched on gets one sentence; nothing is quoted or bought, and its open quote stays open', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const before = calls(w);
  w.more['wan-3.0/720p/videorouter'] = { model: 'wan-3.0', resolution: '720p', route: 'videorouter', label: 'Wan 3.0 - 720p - VideoRouter', unit: 'usd' };
  w.more['wan-3.0/720p/kovapi'] = { model: 'wan-3.0', resolution: '720p', route: 'kovapi', label: 'Wan 3.0 - 720p - KovAPI', unit: 'tokens' };
  w.off.add(ENTRY);
  const bodies = [
    request(ENTRY, [['user', PROMPT]]),
    confirming(quote),
    after(quote, 'no'),
    after(quote, 'ok'),
    titleRequest(ENTRY, [PROMPT]),
    request(ENTRY, [['user', GOAL_ROUND]]),
    request(ENTRY, [...quote.turns]),
    // An entry nobody ever listed, and no entry at all.
    request('seedance-9/4k/krea', [['user', PROMPT]]),
    request('claude-opus-4', [...quote.turns, ['user', 'yes']]),
    { ...request(ENTRY, [['user', PROMPT]]), model: undefined },
    { ...request(ENTRY, [['user', PROMPT]]), model: ['seedance-2.5/720p/krea'] },
    // An entry whose amounts are in a unit the picker cannot count is switched off too.
    request('wan-3.0/720p/videorouter', [['user', PROMPT]]),
    request('wan-3.0/720p/kovapi', [['user', PROMPT]])
  ];
  for (const body of bodies) assert.equal(await ask(w, body), SWITCHED_OFF);
  assert.deepEqual(calls(w), before);
  assert.equal(claimsText(w), '');

  // Switched on again, the quote is as it was: the one confirmation buys.
  w.off.delete(ENTRY);
  assert.match(await ask(w, confirming(quote)), /^Buying one clip: /);
  assert.equal(submitsOf(w, quote.id), 1);
});

test('row 4 does not hide a job: a quote that was used is reported, and `status` answers, after its entry was switched off', async (t) => {
  const w = world(t);
  const job = await bought(w);
  const report = [
    `Job job-1 (Seedance 2.5 - 720p - Krea, quote ${job.id}): completed.`,
    '',
    '[Open the clip](https://clips.example/job-1.mp4)',
    '',
    'Krea held up to 856 units and sets the final charge itself. Check it with `dshproxy video balance krea`.',
    `Finished ${job.id}`
  ].join('\n');
  const before = calls(w);
  w.off.add(ENTRY);
  w.off.add(OTHER);
  // The same confirmation again, a status question, a status question that
  // names the quote from any conversation, and a summary request.
  assert.equal(await ask(w, confirming(job)), report);
  for (const word of ['da', 'ok', 'yes please', 'no']) assert.equal(await ask(w, after(job, word)), report, word);
  for (const word of ['status', 'stanje', `status ${job.id}`]) assert.equal(await ask(w, request(ENTRY, [...job.history, ['user', word]])), report, word);
  assert.equal(await ask(w, request(OTHER, [['user', `Status ${job.id.toLowerCase()}`]])), report);
  assert.equal(await ask(w, compactionRequest(ENTRY, job.history)), `Video conversation.\nJob job-1 (Seedance 2.5 - 720p - Krea, quote ${job.id}): completed. [Open the clip](https://clips.example/job-1.mp4)`);
  // Quoting needs the entry on.
  assert.equal(await ask(w, request(ENTRY, [...job.history, ['user', 'Another clip, please']])), SWITCHED_OFF);
  assert.deepEqual(calls(w), before);
});

// ------------------------------- row 5 -------------------------------

test('row 5: a title request is answered with a title; nothing is quoted or bought, whatever the conversation holds', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const before = calls(w);
  const long = 'A very long description of a clip in which a red ball rolls slowly across a wooden table and falls';
  const cases = [
    // The frames of the facts file: the system prompt and the user text.
    [titleRequest(ENTRY, [PROMPT]), 'Video: A red ball rolls slowly across a wooden table'],
    [titleRequest(ENTRY, [long, 'yes']), `Video: ${long.slice(0, 48).trim()}`],
    [titleRequest(ENTRY, [PROMPT, 'yes']), `Video: ${PROMPT}`],
    [titleRequest(ENTRY, ['yes']), 'Video: yes'],
    [titleRequest(ENTRY, ['  Line one\r\n\tline\u202E two\u0000  ']), 'Video: Line one line two'],
    [titleRequest(ENTRY, []), 'Video clip'],
    [titleRequest(ENTRY, [42, PROMPT]), 'Video clip'],
    [titleRequest(ENTRY, [{ text: PROMPT }]), `Video: ${PROMPT}`],
    // Either frame alone is enough.
    [titleRequest(ENTRY, [PROMPT], { system: 'You name sessions.' }), `Video: ${PROMPT}`],
    [titleRequest(ENTRY, [PROMPT], { system: [{ type: 'text', text: TITLE_SYSTEM }], frame: 'Messages:' }), 'Video clip'],
    [{ ...request(ENTRY, [...quote.turns, ['user', 'yes']]), system: TITLE_SYSTEM }, 'Video clip'],
    // The array is not JSON.
    [{ ...titleRequest(ENTRY, [PROMPT]), messages: [{ role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[not json' }] }, 'Video clip']
  ];
  for (const [body, title] of cases) {
    const text = await ask(w, body);
    assert.equal(text, title);
    assert.ok(Array.from(text).length <= 'Video: '.length + 48 && !text.includes('\n'));
  }
  // The open quote of the conversation inside the title request, with the confirming word after it.
  const body = request(ENTRY, [...quote.turns, ['user', 'yes'], ['user', `Generate the session title from this JSON array of human messages:\n${JSON.stringify([PROMPT, 'yes'])}`]]);
  assert.equal(await ask(w, body), `Video: ${PROMPT}`);
  assert.deepEqual(calls(w), before);
  assert.equal(claimsText(w), '');
});

test('row 5, the frame reworded and the body kept: it is not a prompt, so no quote is asked for and nothing is bought', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const before = calls(w);
  const body = JSON.stringify([PROMPT, 'yes']);
  for (const frame of [
    'Write a short title for the session from this JSON array of human messages:',
    'JSON array of human messages follows. Produce a title for it.',
    'Please generate the session title from this JSON array of human messages:'
  ]) {
    for (const system of ['You name coding sessions. Answer with the title only.', null]) {
      assert.equal(await ask(w, titleRequest(ENTRY, [PROMPT, 'yes'], { system, frame })), NOT_A_PROMPT, frame);
      // The same after a quote that is open.
      assert.equal(await ask(w, request(ENTRY, [...quote.turns, ['user', `${frame}\n${body}`]])), NOT_A_PROMPT, frame);
    }
  }
  assert.deepEqual(calls(w), before);
  assert.equal(claimsText(w), '');
});

// ------------------------------- row 6 -------------------------------

test('row 6: a compaction request gets "Video conversation." and one line for every job in the history; a goal round or a scheduled task gets one sentence', async (t) => {
  const w = world(t);
  // A conversation with a finished job, a job that is still running, a
  // rehearsal and an open quote.
  const first = await bought(w);
  w.statusPlan.push({ ok: true, status: 'processing', progress: 35 });
  const running = await quoted(w, 'A paper boat on a pond', ENTRY, first.history);
  let seen = '';
  await w.picker.answer(confirming(running), (piece) => {
    seen += piece;
    if (seen.includes('processing')) throw new Error('the client went away');
  });
  const history = [...running.turns, ['user', 'yes'], ['assistant', seen]];
  // Each of the next two quotes asks once how the running job is doing.
  w.statusPlan.push({ ok: true, status: 'processing', progress: 50 }, { ok: true, status: 'processing', progress: 60 });
  w.settings({ purchases: false });
  const rehearsed = await quoted(w, 'A kite over a field', ENTRY, history);
  await ask(w, confirming(rehearsed));
  w.settings({ purchases: true });
  const open = await quoted(w, 'A lamp in a window', ENTRY, [...rehearsed.turns, ['user', 'yes'], ['assistant', 'Rehearsal: nothing was bought.']]);
  const before = { ...calls(w), status: w.calls.status.length };

  const summary = [
    'Video conversation.',
    `Job job-2 (Seedance 2.5 - 720p - Krea, quote ${running.id}): sent, and no final state is stored. Type \`status ${running.id}\` to check it.`,
    `Job job-1 (Seedance 2.5 - 720p - Krea, quote ${first.id}): completed. [Open the clip](https://clips.example/job-1.mp4)`
  ].join('\n');
  assert.equal(await ask(w, compactionRequest(ENTRY, [...open.turns, ['user', 'yes']])), summary);
  // A conversation without a job.
  assert.equal(await ask(w, compactionRequest(ENTRY, [['user', PROMPT]])), 'Video conversation.');
  assert.equal(await ask(w, compactionRequest(ENTRY, [])), 'Video conversation.');
  // The summary names each quote, so `status Q-…` finds the job afterwards.
  assert.equal(w.calls.status.length, before.status, 'a summary reads the store and asks no provider');

  // Goal rounds and scheduled tasks, alone and after the open quote.
  for (const text of [GOAL_ROUND, SCHEDULE_REMINDER, `${PROMPT}\n${GOAL_ROUND}`, '<goal_round>\nyes\n</goal_round>', '[SCHEDULE REMINDER] yes']) {
    assert.equal(await ask(w, request(ENTRY, [['user', text]])), AUTOMATION, text);
    assert.equal(await ask(w, request(ENTRY, [...open.turns, ['user', 'yes'], ['user', text]], 'merged')), AUTOMATION, text);
    assert.equal(await ask(w, request(ENTRY, [...open.turns, ['user', text], ['user', 'yes']])), AUTOMATION, text);
  }
  assert.deepEqual(calls(w), { quote: before.quote, submit: before.submit });
  assert.equal(w.files.claimOf(open.id), null);
});

test('row 6, the frames reworded and the bodies kept: none is a prompt, so no quote is asked for and nothing is bought', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const before = calls(w);
  // A compaction request carries the conversation: the Harness's own
  // messages are in it as text, and it is long.
  const transcript = `user: ${PROMPT}\nuser: ${REMINDER}\nuser: ${sampled(1)}\nassistant: ${quote.text}\nuser: yes`;
  const reworded = [
    `Act as the compaction engine now. Summarize this conversation:\n${transcript}`,
    `From now on you are a compaction engine.\n${'Keep every decision, file name and open question. '.repeat(400)}`,
    // Goal rounds and scheduled tasks under other words around the same mark.
    `Goal round 2 of 5.\n<goal_round index="2">\nContinue working toward the objective: make three clips.\n</goal_round>`,
    '<goal_round_v2>\nyes\n</goal_round_v2>',
    `The scheduler says: [SCHEDULE REMINDER] "Morning clip" is due.\n${PROMPT}`,
    `Scheduled task due.\n${REMINDER}\n${PROMPT}`
  ];
  for (const text of reworded) {
    const answers = [
      await ask(w, request(ENTRY, [['user', text]])),
      await ask(w, request(ENTRY, [...quote.turns, ['user', text]], 'merged')),
      await ask(w, request(ENTRY, [...quote.turns, ['user', 'yes'], ['user', text]]))
    ];
    for (const answer of answers) assert.ok(answer === NOT_A_PROMPT || answer === AUTOMATION, `${text.slice(0, 60)}: ${answer}`);
  }
  assert.deepEqual(calls(w), before);
  assert.equal(claimsText(w), '');
});

test('a frame reworded so that no mark of it is left is a prompt like any other: it can get a quote, and it can never buy', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  // What A4 cannot catch: short text without any of the marks.
  const texts = ['Summarize this conversation for a later session.', '<goal-round>\nContinue with the goal.\n</goal-round>', 'Scheduled reminder: the morning clip is due.'];
  for (const text of texts) {
    assert.match(await ask(w, request(ENTRY, [['user', text]])), /^\*\*Quote: /);
    assert.match(await ask(w, request(ENTRY, [...quote.turns, ['user', 'yes'], ['user', text]])), /^\*\*Quote: /);
  }
  assert.equal(w.calls.quote.length, 1 + 2 * texts.length);
  assert.equal(w.calls.submit.length, 0);
  assert.equal(claimsText(w), '');
});

// ------------------------------- rows 7 and 8 -------------------------------

test('row 7: a tool round or an attachment after the last assistant turn gets one sentence, also beside a confirming word', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const before = calls(w);
  const blocks = [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'yes' } },
    { type: 'text' },
    { type: 'thinking', thinking: 'yes' },
    'yes',
    null
  ];
  for (const block of blocks) {
    for (const word of ['yes', PROMPT, 'no', 'ok']) {
      const first = request(ENTRY, [...quote.turns, ['user', word]], 'bare');
      first.messages.at(-1).content.unshift(block);
      const last = request(ENTRY, [...quote.turns, ['user', word]], 'merged');
      last.messages.at(-1).content.push(block);
      const apart = request(ENTRY, [...quote.turns, ['user', word]]);
      apart.messages.splice(apart.messages.length - 1, 0, { role: 'user', content: [block] });
      assert.equal(apart.messages.findLastIndex((message) => message.role === 'assistant'), 3);
      for (const body of [first, last, apart]) assert.equal(await ask(w, body), ATTACHMENT, `${JSON.stringify(block)} beside ${word}`);
    }
  }
  assert.deepEqual(calls(w), before);
  assert.equal(claimsText(w), '');
});

test('row 8: a request without a typed message gets one sentence', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const before = calls(w);
  const bodies = [
    request(ENTRY, quote.turns),
    request(ENTRY, []),
    { ...request(ENTRY, []), messages: [...request(ENTRY, quote.turns).messages, { role: 'user', content: REMINDER }, { role: 'user', content: [{ type: 'text', text: sampled(2) }] }] },
    { ...request(ENTRY, []), messages: [{ role: 'user', content: [] }] },
    request(ENTRY, [...quote.turns, ['user', '   \n\t ']])
  ];
  for (const body of bodies) assert.equal(await ask(w, body), SILENT);
  assert.deepEqual(calls(w), before);
  assert.equal(claimsText(w), '');
});

// ------------------------------- rows 9 and 10 -------------------------------

test('row 9: the one confirmation of an open quote is the only request that buys, and it buys once', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  // Everything else first, in the same conversation: none of it buys or closes the quote.
  for (const word of ['yes please', 'ok', 'status', 'stanje', `status ${quote.id}`, 'what does it cost?']) await ask(w, after(quote, word));
  assert.equal(w.calls.submit.length, 0);
  assert.equal(claimsText(w), '');
  const quotes = w.calls.quote.length;
  assert.match(await ask(w, confirming(quote)), /^Buying one clip: /);
  assert.equal(await ask(w, titleRequest(ENTRY, [PROMPT, 'yes'])), `Video: ${PROMPT}`);
  for (const word of ['yes', 'da', 'ok', 'no', 'status']) assert.match(await ask(w, after(quote, word)), /^Job job-1 /);
  assert.deepEqual(calls(w), { quote: quotes, submit: 1 });
  assert.equal(recordsOf(w).length, 1);
});

test('row 10: a confirming word that is not the one reply directly after a quote buys nothing, is never a prompt and does not invite a loop', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const before = calls(w);
  // No quote before it at all, or more than the one word after it.
  for (const body of [
    request(ENTRY, [['user', 'yes']]),
    request(ENTRY, [['user', 'Da!']], 'merged'),
    request(ENTRY, [...quote.turns, ['user', 'really'], ['user', 'yes']]),
    request(ENTRY, [...quote.turns, ['user', 'yes'], ['user', 'da']], 'bare'),
    request(ENTRY, [...quote.turns, ['user', '<harness-notice>\nThe session was resumed.\n</harness-notice>'], ['user', 'potvrdi']])
  ]) assert.equal(await ask(w, body), STRAY);
  // The one reply after an assistant turn that is not a stored quote, word for word.
  for (const turn of [
    'Here is a poem about a red ball.',
    quote.text.replace('5 seconds', '50 seconds'),
    quote.text.replace(quote.id, 'Q-AAAAAAAAAAAAAAAA'),
    `${quote.text}\nThank you.`,
    quote.text.slice(0, quote.text.lastIndexOf('\n')),
    NEAR,
    UNMATCHED
  ]) assert.equal(await ask(w, request(ENTRY, [['user', PROMPT], ['assistant', turn], ['user', 'yes']])), UNMATCHED);
  // The answer to that is not a quote: the next `yes` finds nothing to confirm either.
  assert.equal(await ask(w, request(ENTRY, [...quote.turns, ['user', 'yes'], ['user', 'yes'], ['assistant', STRAY], ['user', 'yes']])), UNMATCHED);
  assert.deepEqual(calls(w), before);
  assert.equal(claimsText(w), '');
});

// ------------------------------- row 11 -------------------------------

test('row 11: a refusal after an open quote closes it for good; no later `yes` buys', async (t) => {
  const w = world(t);
  const words = ['no', 'No.', 'NE', 'ne!', 'cancel', 'Stop', 'odustani', 'Odustajem.', 'nemoj'];
  const dropped = [];
  for (const [index, word] of words.entries()) {
    const quote = await quoted(w, `Clip ${index}`);
    assert.equal(await ask(w, after(quote, word, ['separate', 'merged', 'bare'][index % 3])), DROPPED, word);
    dropped.push(quote);
    // The quote is used: its claim is in the journal and its outcome says by whom.
    const claim = w.files.claimOf(quote.id);
    assert.equal(w.files.readOutcome(quote.id, claim.record.nonce).state, 'declined');
    assert.deepEqual(JSON.parse(fs.readFileSync(w.files.outcomeFile(quote.id), 'utf8')), { state: 'declined', nonce: claim.record.nonce });
    w.restart();
    for (const again of ['yes', 'da', word, 'ok', `status ${quote.id}`]) assert.equal(await ask(w, after(quote, again)), 'You dropped that quote.', `${again} after ${word}`);
  }
  assert.equal(recordsOf(w).length, words.length);
  assert.deepEqual(calls(w), { quote: words.length, submit: 0 });
  // A dropped quote does not count against the ceiling.
  assert.deepEqual(w.files.usage(w.clock.time), { clips: 0, krea_units: 0, usd_micros: 0, callirra_credits: 0 });

  // A refusing word is never a prompt, and without an open quote it changes nothing.
  const journal = fs.readFileSync(w.files.journal, 'utf8');
  const nothing = 'There is no open quote to drop. Nothing was bought.';
  assert.equal(await ask(w, request(ENTRY, [['user', 'no']])), nothing);
  assert.equal(await ask(w, request(ENTRY, [['user', PROMPT], ['assistant', 'A poem.'], ['user', 'stop']])), nothing);
  const open = await quoted(w, 'A paper boat on a pond');
  assert.equal(await ask(w, request(ENTRY, [['user', open.prompt], ['assistant', open.text.replace('5 seconds', '9 seconds')], ['user', 'no']])), nothing);
  // A quote that ran out is closed already: nothing is written for it.
  w.clock.time += 600001;
  assert.equal(await ask(w, after(open, 'no')), 'That quote is no longer valid, so there is nothing to drop. Nothing was bought.');
  assert.equal(fs.readFileSync(w.files.journal, 'utf8'), journal);
  // After a purchase, `no` reports the job; it cannot take the purchase back.
  const paid = await bought(w, 'A kite over a field');
  assert.match(await ask(w, after(paid, 'no')), /^Job job-1 \(Seedance 2\.5 - 720p - Krea, quote Q-[A-Z2-9]{16}\): completed\./);
  assert.equal(w.calls.submit.length, 1);
  assert.equal(w.calls.quote.length, words.length + 2);
});

test('a refusal that cannot be recorded says so, and the quote stays open', async (t) => {
  const w = world(t, { age: 0 });
  const quote = await quoted(w);
  const sentence = 'The quote could not be closed just now. Nothing was bought. The quote runs out by itself ten minutes after it was made.';
  // The journal is younger than a minute: it takes no line.
  assert.equal(await ask(w, after(quote, 'no')), sentence);
  assert.equal(claimsText(w), '');
  w.clock.time += 60000;
  assert.match(await ask(w, confirming(quote)), /^Buying one clip: /);
  assert.equal(w.calls.submit.length, 1);
});

// ------------------------------- row 12 -------------------------------

test('row 12: `status` and `stanje`, alone or with a quote id, report from the store and never buy', { timeout: 60000 }, async (t) => {
  const w = world(t);
  // No job yet, with an open quote in the conversation: the question is not a confirmation and not a prompt.
  const open = await quoted(w);
  for (const word of ['status', 'Status.', 'STATUS', 'stanje', 'Stanje!']) {
    assert.equal(await ask(w, request(ENTRY, [['user', word]])), NO_JOB, word);
    assert.equal(await ask(w, after(open, word, 'merged')), NO_JOB, word);
  }
  const stands = new Date(w.clock.time + 600000);
  const until = `${String(stands.getHours()).padStart(2, '0')}:${String(stands.getMinutes()).padStart(2, '0')}`;
  assert.equal(await ask(w, after(open, `status ${open.id}`)), `Quote ${open.id} (Seedance 2.5 - 720p - Krea) was not used: nothing was bought with it. It stands until ${until}.`);
  assert.equal(await ask(w, request(OTHER, [['user', `stanje ${open.id.toLowerCase()}.`]])), `Quote ${open.id} (Seedance 2.5 - 720p - Krea) was not used: nothing was bought with it. It stands until ${until}.`);
  assert.equal(await ask(w, request(ENTRY, [['user', 'status Q-AAAAAAAAAAAAAAAA']])), 'I know no quote with that id. Nothing was bought.');
  for (const word of ['status Q-123', 'status please', `status ${open.id}X`, `stanje ..\\..\\${open.id}`]) {
    assert.equal(await ask(w, after(open, word)), 'I could not read a quote id in that. Type `status` alone for the newest job of this conversation, or `status Q-…` with the whole id of a quote. Nothing was bought.', word);
  }
  assert.deepEqual(calls(w), { quote: 1, submit: 0 });
  assert.equal(claimsText(w), '');
  // The quote is still open after all of that.
  w.statusPlan.push({ ok: true, status: 'processing', progress: 35 });
  let seen = '';
  await w.picker.answer(confirming(open), (piece) => {
    seen += piece;
    if (seen.includes('processing')) throw new Error('the client went away');
  });
  assert.equal(w.calls.submit.length, 1);
  const turns = [...open.turns, ['user', 'yes'], ['assistant', seen]];

  // The job is running: one line, then it is followed to its end.
  w.clock.time += 3 * 60000;
  w.statusPlan.push({ ok: true, status: 'processing', progress: 75 }, { ok: true, status: 'processing', progress: 75 }, { ok: true, status: 'processing', progress: 90 });
  const running = await ask(w, request(ENTRY, [...turns, ['user', 'status']]));
  assert.equal(running, [
    `Job job-1 (Seedance 2.5 - 720p - Krea, quote ${open.id}): processing, 75 %. Sent 3 minutes ago.`,
    'Generating ... processing 90 % .',
    'Done after 3 min 50 s.',
    '',
    '[Open the clip](https://clips.example/job-1.mp4)',
    '',
    'Krea held up to 856 units and sets the final charge itself. Check it with `dshproxy video balance krea`.',
    `Finished ${open.id}`
  ].join('\n'));
  // Finished: the stored link, and the provider is not asked again.
  const checks = w.calls.status.length;
  const finished = [
    `Job job-1 (Seedance 2.5 - 720p - Krea, quote ${open.id}): completed.`,
    '',
    '[Open the clip](https://clips.example/job-1.mp4)',
    '',
    'Krea held up to 856 units and sets the final charge itself. Check it with `dshproxy video balance krea`.',
    `Finished ${open.id}`
  ].join('\n');
  w.restart();
  for (const word of ['status', 'stanje', `status ${open.id}`, `STANJE ${open.id.toLowerCase()}`]) assert.equal(await ask(w, request(ENTRY, [...turns, ['user', word]])), finished, word);
  // A conversation that was compacted has no quote in its turns: the id finds the job.
  assert.equal(await ask(w, request(ENTRY, [['user', 'A summary'], ['assistant', 'Video conversation.'], ['user', 'status']])), NO_JOB);
  assert.equal(await ask(w, request(ENTRY, [['user', 'A summary'], ['assistant', 'Video conversation.'], ['user', `status ${open.id}`]])), finished);
  assert.equal(w.calls.status.length, checks);

  // `status` alone is the newest job of the conversation, not a newer quote that was dropped or is open.
  const second = await bought(w, 'A paper boat on a pond', turns);
  const droppedQuote = await quoted(w, 'A kite over a field', ENTRY, second.history);
  assert.equal(await ask(w, after(droppedQuote, 'no')), DROPPED);
  const newest = await quoted(w, 'A lamp in a window', ENTRY, [...droppedQuote.turns, ['user', 'no'], ['assistant', DROPPED]]);
  assert.match(await ask(w, after(newest, 'status')), new RegExp(`^Job job-2 \\(Seedance 2\\.5 - 720p - Krea, quote ${second.id}\\): completed\\.`));
  assert.equal(await ask(w, after(newest, `status ${droppedQuote.id}`)), 'You dropped that quote.');
  // Only a dropped quote in the conversation: that is what there is to report.
  assert.equal(await ask(w, request(ENTRY, [...droppedQuote.turns.slice(-2), ['user', 'status']])), 'You dropped that quote.');
  assert.equal(w.calls.submit.length, 2);
  assert.equal(w.files.claimOf(newest.id), null);
});

test('row 12: a state that cannot be read, an unknown outcome and a quote whose record is gone each get their own sentence', async (t) => {
  const w = world(t);
  w.statusPlan.push({ ok: false, reason: 'sign-in' });
  const quote = await quoted(w);
  const first = await ask(w, confirming(quote));
  assert.ok(first.endsWith('\nThe job\'s state could not be read: the Krea sign-in has expired. The job itself is not affected. Job job-1.'), first);
  const turns = [...quote.turns, ['user', 'yes'], ['assistant', first]];
  w.statusPlan.push({ ok: false, reason: 'unreachable' });
  assert.equal(await ask(w, request(ENTRY, [...turns, ['user', 'status']])), 'The job\'s state could not be read: the provider could not be reached. The job itself is not affected. Job job-1.');
  w.statusPlan.push({ ok: true, status: 'failed' });
  assert.equal(await ask(w, request(ENTRY, [...turns, ['user', 'stanje']])), [
    `Job job-1 (Seedance 2.5 - 720p - Krea, quote ${quote.id}): failed. Sent less than a minute ago.`,
    '',
    'The job failed at Krea. Whether anything was charged is Krea\'s decision; check your balance. I did not send it again.',
    `Finished ${quote.id}`
  ].join('\n'));

  // An outcome nobody knows.
  w.submitPlan.push('silent');
  const lost = await quoted(w, 'A paper boat on a pond');
  assert.equal((await ask(w, confirming(lost))).split('\n').slice(1).join('\n'), unknownText(lost.id));
  for (const word of ['status', `status ${lost.id}`]) assert.equal(await ask(w, after(lost, word)), unknownText(lost.id));

  // The quote file is gone (cleaned up, or lost): the journal still says the quote was used.
  fs.unlinkSync(path.join(w.files.folder, 'quotes', `${lost.id}.json`));
  assert.equal(await ask(w, request(ENTRY, [['user', `status ${lost.id}`]])), `Quote ${lost.id} was used, but its record is no longer kept, so its state cannot be shown. It will not be sent again.`);
  assert.equal(await ask(w, after(lost, 'status')), NO_JOB);
  assert.equal(await ask(w, confirming(lost)), UNMATCHED);
  assert.equal(w.calls.submit.length, 2);
});

// ------------------------------- row 13 -------------------------------

test('row 13: a short answer to an open quote that is not one of the words that count gets one sentence: no purchase and no new quote', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const before = calls(w);
  const firsts = ['yes', 'da', 'ok', 'okay', 'sure', 'yep', 'yeah', 'y', 'go', 'može', 'moze', 'ajde', 'hajde', 'kupi', 'buy', 'naravno', 'confirm', 'potvrdi', 'potvrđujem', 'potvrdujem', 'no', 'ne'];
  const confirmingWords = new Set(['yes', 'da', 'confirm', 'potvrdi', 'potvrđujem', 'potvrdujem']);
  const refusing = new Set(['no', 'ne']);
  for (const first of firsts) {
    // The bare word, where it is not one of the words that confirm or refuse.
    if (!confirmingWords.has(first) && !refusing.has(first)) assert.equal(await ask(w, after(quote, first)), NEAR, first);
    for (const reply of [`${first} please`, `${first[0].toUpperCase()}${first.slice(1)}, do it now`, `${first}?`, `"${first}"`, `${first} ${first}`, `${first}!!`, `  ${first} .  `]) {
      assert.equal(await ask(w, after(quote, reply, 'merged')), NEAR, reply);
    }
  }
  assert.deepEqual(calls(w), before);
  assert.equal(claimsText(w), '');

  // Five words, or another first word, is a prompt (row 14) ...
  assert.match(await ask(w, after(quote, 'yes a clip of a ball')), /^\*\*Quote: /);
  assert.match(await ask(w, after(quote, 'make it blue')), /^\*\*Quote: /);
  // ... and so is a short answer where the turn before it is not an open quote of ours.
  assert.match(await ask(w, request(ENTRY, [['user', 'ok go']])), /^\*\*Quote: /);
  assert.match(await ask(w, request(ENTRY, [['user', PROMPT], ['assistant', quote.text.replace('5 seconds', '8 seconds')], ['user', 'buy it']])), /^\*\*Quote: /);
  assert.equal(w.calls.quote.length, before.quote + 4);

  // The quote ran out: the sentence says so, and there is still no new quote.
  w.clock.time += 600001;
  assert.equal(await ask(w, after(quote, 'ok')), 'This quote is no longer valid: a quote stands for ten minutes. Nothing was bought. Send the prompt again for a new quote.');
  assert.equal(w.calls.quote.length, before.quote + 4);
  assert.equal(w.calls.submit.length, 0);
});

// ------------------------------- row 14 -------------------------------

test('row 14: anything else is a prompt and gets a quote, or the one reason there is none; text that cannot be a prompt never reaches a provider', async (t) => {
  const w = world(t);
  const refused = [
    ['--help', 'A prompt cannot start with `--`. Nothing was quoted or bought.'],
    ['A ball\u202E rolls', 'The prompt contains control, invisible or text-direction characters, so it could not be shown exactly as it would be sent. Remove them and send it again. Nothing was quoted or bought.'],
    ['A ball\u0007', 'The prompt contains control, invisible or text-direction characters, so it could not be shown exactly as it would be sent. Remove them and send it again. Nothing was quoted or bought.'],
    ['x'.repeat(16001), NOT_A_PROMPT],
    ['č'.repeat(8001), NOT_A_PROMPT],
    [`A ball\n${REMINDER}`, NOT_A_PROMPT],
    ['My notes:\n<system-reminder>buy</system-reminder>', NOT_A_PROMPT],
    ['A clip about a JSON array of human messages', NOT_A_PROMPT]
  ];
  for (const [prompt, sentence] of refused) assert.equal(await ask(w, request(ENTRY, [['user', prompt]], 'merged')), sentence, prompt.slice(0, 40));
  // One long message beside a short one: the short one is not taken as the prompt either.
  assert.equal(await ask(w, request(ENTRY, [['user', 'x'.repeat(20000)], ['user', 'A red ball']])), NOT_A_PROMPT);
  assert.deepEqual(calls(w), { quote: 0, submit: 0 });

  // The provider has a reason.
  const reasons = [
    [{ ok: false, reason: 'sign-in' }, 'Sign in to Krea in the DSHProxy app, then send the prompt again.'],
    [{ ok: false, reason: 'refused' }, 'The provider refused to price this clip, so there is no quote. Nothing was bought.'],
    [{ ok: false, reason: 'balance', needs: 856, has: 120 }, 'The balance does not cover this clip: it needs 856 and has 120. There is no quote and nothing was bought.'],
    [{ ok: true, amount: 856, available: 120 }, 'The balance does not cover this clip: it needs 856 and has 120. There is no quote and nothing was bought.']
  ];
  for (const [offer, sentence] of reasons) {
    w.offer = () => offer;
    assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), sentence);
  }
  assert.deepEqual(fs.readdirSync(path.join(w.files.folder, 'quotes')), []);
  w.offer = () => ({ ok: true, amount: 856, unit: 'krea_units', estimated: false, available: 97909.73 });

  // 16,000 bytes exactly is a prompt, and so is one that only looks like a word that counts.
  for (const prompt of ['x'.repeat(16000), 'yesterday at the lake', 'status of the art', 'no man\'s land at dawn in fog', 'ｙｅｓ']) {
    assert.match(await ask(w, request(ENTRY, [['user', prompt]])), /^\*\*Quote: /, prompt.slice(0, 30));
  }
  assert.equal(w.calls.quote.length, reasons.length + 5);
  assert.equal(w.calls.submit.length, 0);
  assert.equal(claimsText(w), '');
});

test('row 14: no more than 20 quotes in ten minutes', async (t) => {
  const w = world(t);
  for (let index = 0; index < 20; index += 1) {
    await quoted(w, `Clip ${index}`, index % 2 ? OTHER : ENTRY);
    w.clock.time += 1000;
  }
  const sentence = 'More than 20 quotes were asked for in ten minutes, so there is no new one. Nothing was bought. Wait a few minutes and send the prompt again.';
  w.restart();
  assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), sentence);
  assert.equal(await ask(w, request(OTHER, [['user', PROMPT]])), sentence);
  assert.equal(w.calls.quote.length, 20, 'a quote over the limit is not asked for');
  // Ten minutes after the first of them there is room for one more.
  w.clock.time += 600000 - 20000;
  await quoted(w);
  assert.equal(await ask(w, request(ENTRY, [['user', PROMPT]])), sentence);
  assert.equal(w.calls.submit.length, 0);
});

test('row 14: a new quote starts with one line about an earlier job of the conversation that no answer has finished', { timeout: 60000 }, async (t) => {
  const w = world(t);
  // The client went away while the first job was running.
  w.statusPlan.push({ ok: true, status: 'processing', progress: 35 });
  const first = await quoted(w);
  let seen = '';
  await w.picker.answer(confirming(first), (piece) => {
    seen += piece;
    if (seen.includes('processing')) throw new Error('the client went away');
  });
  const turns = [...first.turns, ['user', 'yes'], ['assistant', seen]];

  w.statusPlan.push({ ok: true, status: 'processing', progress: 75 });
  const second = await quoted(w, 'A paper boat on a pond', ENTRY, turns);
  assert.ok(second.text.startsWith('Earlier job job-1: processing, 75 %. Send `status` to follow it.\n\n**Quote: Seedance 2.5 - 720p - Krea**\n'), second.text);
  // The quote with that line is the quote: its one confirmation buys.
  w.statusPlan.push({ ok: false, reason: 'unreachable' });
  const third = await quoted(w, 'A kite over a field', ENTRY, turns);
  assert.ok(third.text.startsWith('Earlier job job-1: its state could not be read. Send `status` to check it.\n\n**Quote: '), third.text);
  const fourth = await quoted(w, 'A lamp in a window', ENTRY, turns);
  assert.ok(fourth.text.startsWith('Earlier job job-1: completed. [Open the clip](https://clips.example/job-1.mp4)\n\n**Quote: '), fourth.text);
  // Stored now: the next quote says the same without asking the provider.
  const checks = w.calls.status.length;
  const fifth = await quoted(w, 'A door in a wall', ENTRY, turns);
  assert.ok(fifth.text.startsWith('Earlier job job-1: completed. [Open the clip](https://clips.example/job-1.mp4)\n\n**Quote: '), fifth.text);
  assert.equal(w.calls.status.length, checks);
  assert.equal(w.calls.submit.length, 1);
  assert.match(await ask(w, confirming(fifth)), /^Buying one clip: Seedance 2\.5 - 720p - Krea, at most 856 units/);
  assert.equal(submitsOf(w, fifth.id), 1);

  // An answer in the conversation that finished the job: no line.
  const done = await ask(w, request(ENTRY, [...turns, ['user', 'status']]));
  assert.ok(done.endsWith(`Finished ${first.id}`));
  const sixth = await quoted(w, 'A cat on a roof', ENTRY, [...turns, ['user', 'status'], ['assistant', done]]);
  assert.ok(sixth.text.startsWith('**Quote: '), sixth.text);
  // A quote that was only dropped, or rehearsed, is no job.
  const dropped = await quoted(w, 'A boat');
  await ask(w, after(dropped, 'no'));
  assert.ok((await quoted(w, 'A ship', ENTRY, [...dropped.turns, ['user', 'no'], ['assistant', DROPPED]])).text.startsWith('**Quote: '));
});

// ------------------------------- while a job is followed -------------------------------

test('a dot every ten seconds while a job is followed, whether or not a status check is under way', { timeout: 60000 }, async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  // The second check takes 47 seconds to come back, the third 25.
  w.statusPlan.push(
    { ok: true, status: 'processing', progress: 35 },
    () => w.clock.sleep(47000).then(() => ({ ok: true, status: 'processing', progress: 75 })),
    () => w.clock.sleep(25000).then(() => ({ ok: true, status: 'completed', links: ['https://clips.example/job-1.mp4'] }))
  );
  const started = w.clock.time;
  const text = await ask(w, confirming(quote));
  // Checks: at 5 s; at 20 s, back at 67 s; at 82 s, back at 107 s. Dots at 10, 20, ... 100 s.
  assert.equal(text, [
    `Buying one clip: Seedance 2.5 - 720p - Krea, at most 856 units (quote ${quote.id}).`,
    'Sent once. Job job-1 is scheduled.',
    'Generating processing 35 % ...... processing 75 % ....',
    'Done after 1 min 47 s.',
    '',
    '[Open the clip](https://clips.example/job-1.mp4)',
    '',
    'Krea held up to 856 units and sets the final charge itself. Check it with `dshproxy video balance krea`.',
    `Finished ${quote.id}`
  ].join('\n'));
  assert.equal(w.clock.time - started, 107000);
  assert.equal(w.calls.status.length, 3, 'a check is not started while another is under way');

  // A check that never comes back: the dots go on, and the answer ends after twelve minutes.
  const stuck = await quoted(w, 'A paper boat on a pond');
  w.statusPlan.push(() => new Promise(() => {}));
  const before = w.clock.time;
  const second = await ask(w, confirming(stuck));
  assert.equal(second, [
    `Buying one clip: Seedance 2.5 - 720p - Krea, at most 856 units (quote ${stuck.id}).`,
    'Sent once. Job job-2 is scheduled.',
    `Generating ${'.'.repeat(71)}`,
    'Still running after 12 minutes. Job job-2. Send `status` to check it.'
  ].join('\n'));
  assert.equal(w.clock.time - before, 720000);
  assert.equal(w.calls.submit.length, 2);
});

test('a clock without a timer of its own gets one made from its sleep: the picker still follows a job and rehearses', { timeout: 60000 }, async (t) => {
  const w = world(t);
  const picker = create({ ...w.options(), clock: { now: w.clock.now, sleep: w.clock.sleep } });
  w.statusPlan.push({ ok: true, status: 'processing', progress: 35 }, () => w.clock.sleep(33000).then(() => ({ ok: true, status: 'processing', progress: 75 })));
  const quote = await quoted(w);
  // Checks at 5 s and at 20 s, the second back at 53 s; dots at 10 to 50 s and at 60 s; done at 68 s.
  const text = await ask(w, confirming(quote), picker);
  assert.ok(text.startsWith([
    `Buying one clip: Seedance 2.5 - 720p - Krea, at most 856 units (quote ${quote.id}).`,
    'Sent once. Job job-1 is scheduled.',
    'Generating processing 35 % ..... processing 75 % .',
    'Done after '
  ].join('\n')), text);
  assert.ok(text.endsWith(`Finished ${quote.id}`));
  assert.equal(w.calls.submit.length, 1);
  assert.throws(() => create({ ...w.options(), clock: { now: w.clock.now, sleep: w.clock.sleep, after: 'soon' } }), /clock/);
});

// ------------------------------- clean-up -------------------------------

const filesOf = (w, kind) => fs.readdirSync(path.join(w.files.folder, kind)).sort();

test('clean-up deletes a quote that was never used a day after it was issued, when a picker is made and at most once a day after', async (t) => {
  const w = world(t);
  const old = await quoted(w, 'Clip one');
  w.clock.time += DAY - 60000;
  const recent = await quoted(w, 'Clip two');
  const journal = fs.readFileSync(w.files.journal);

  // The running picker cleaned up when it was made; within a day it does not do so again.
  w.clock.time += 2 * 60000;
  await ask(w, request(ENTRY, [['user', 'status']]));
  assert.deepEqual(filesOf(w, 'quotes'), [`${old.id}.json`, `${recent.id}.json`].sort());
  // A picker that is made now does.
  w.restart();
  assert.deepEqual(filesOf(w, 'quotes'), [`${recent.id}.json`]);
  // A confirmation of the deleted quote finds no record and buys nothing.
  assert.equal(await ask(w, confirming(old)), UNMATCHED);
  assert.equal(await ask(w, after(old, `status ${old.id}`)), 'I know no quote with that id. Nothing was bought.');

  // The same picker, a day later, at its next request.
  w.clock.time += DAY;
  assert.deepEqual(filesOf(w, 'quotes'), [`${recent.id}.json`]);
  await ask(w, request(ENTRY, [['user', 'status']]));
  assert.deepEqual(filesOf(w, 'quotes'), []);
  assert.equal(w.calls.submit.length, 0);
  assert.ok(fs.readFileSync(w.files.journal).equals(journal), 'clean-up changed the journal');
});

test('clean-up keeps the files of a claim for 30 days, then deletes the quote, the result and the outcome, and never touches the journal', async (t) => {
  const w = world(t);
  const paid = await bought(w, 'Clip one');
  const dropped = await quoted(w, 'Clip two');
  await ask(w, after(dropped, 'no'));
  w.submitPlan.push('hang');
  const hung = w.hung();
  const lost = await quoted(w, 'Clip three');
  w.picker.answer(confirming(lost), () => {});
  await hung;
  const journal = fs.readFileSync(w.files.journal);
  const all = (kind, quotes) => quotes.map((quote) => `${quote.id}.json`).sort();

  // 30 days less a minute: everything is kept, and every quote still answers.
  w.clock.time += 30 * DAY - 60000;
  w.restart();
  assert.deepEqual(filesOf(w, 'quotes'), all('quotes', [paid, dropped, lost]));
  assert.deepEqual(filesOf(w, 'outcomes'), all('outcomes', [paid, dropped]));
  assert.deepEqual(filesOf(w, 'results'), all('results', [paid]));
  assert.match(await ask(w, confirming(paid)), /^Job job-1 /);
  assert.equal(await ask(w, confirming(lost)), unknownText(lost.id));

  // Two minutes later a new picker deletes all three sets.
  w.clock.time += 2 * 60000;
  w.restart();
  for (const kind of ['quotes', 'outcomes', 'results']) assert.deepEqual(filesOf(w, kind), [], kind);
  assert.ok(fs.readFileSync(w.files.journal).equals(journal), 'clean-up changed the journal');
  assert.deepEqual(fs.readdirSync(w.files.folder).sort(), ['claims.log', 'outcomes', 'quotes', 'results', 'settings.json']);

  // The journal still says they were used: nothing can buy with them.
  for (const quote of [paid, dropped, lost]) {
    assert.notEqual(w.files.claimOf(quote.id), null);
    assert.equal(await ask(w, confirming(quote)), UNMATCHED);
    assert.equal(await ask(w, request(ENTRY, [['user', `status ${quote.id}`]])), `Quote ${quote.id} was used, but its record is no longer kept, so its state cannot be shown. It will not be sent again.`);
  }
  assert.equal(w.calls.submit.length, 2);
  assert.ok(fs.readFileSync(w.files.journal).equals(journal));
});

test('what a clean-up leaves half done can never buy: the quote goes first, and files that are in the way are left alone', async (t) => {
  const w = world(t);
  const paid = await bought(w, 'Clip one');
  const other = await bought(w, 'Clip two');
  // Things that are not the picker's.
  fs.writeFileSync(path.join(w.files.folder, 'quotes', 'notes.txt'), 'mine');
  fs.writeFileSync(path.join(w.files.folder, 'outcomes', 'Q-not-an-id.json'), '{}');
  w.clock.time += 31 * DAY;

  // The first clean-up gets as far as the quotes: unlink fails for everything else.
  const original = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (!String(file).includes(`${path.sep}quotes${path.sep}`)) throw Object.assign(new Error('in use'), { code: 'EBUSY' });
    return original(file);
  };
  try {
    w.restart();
  } finally {
    fs.unlinkSync = original;
  }
  assert.deepEqual(filesOf(w, 'quotes'), ['notes.txt']);
  assert.deepEqual(filesOf(w, 'results'), [`${paid.id}.json`, `${other.id}.json`].sort());
  for (const quote of [paid, other]) assert.equal(await ask(w, confirming(quote)), UNMATCHED);

  // The next clean-up finishes the job.
  w.restart();
  assert.deepEqual(filesOf(w, 'results'), []);
  assert.deepEqual(filesOf(w, 'outcomes'), ['Q-not-an-id.json']);
  assert.deepEqual(filesOf(w, 'quotes'), ['notes.txt']);
  assert.equal(w.calls.submit.length, 2);
});
