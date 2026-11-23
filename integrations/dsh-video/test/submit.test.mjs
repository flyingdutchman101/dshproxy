// video_submit and video_status. Every job here is synthetic: the provider is a
// stand-in DSHProxy folder, the user is a stand-in question service, and the
// few tests that run DSHProxy's real code use an empty temporary profile, where
// it stops at "not signed in" before any request leaves the machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { apply } from '../index.js'
import { BridgeError, createBridge } from '../lib/bridge.js'
import { resolveSettings } from '../lib/config.js'
import { createSubmitTools } from '../lib/submit.js'
import {
  PROMPT, SECRET, host, kreaEnabled, preflight, realRoot, runner, saveSettings, settingsRows, spy, stubRoot, temporary, tools,
} from '../testing/support.mjs'

const AGENT = { id: 'agent-1', session: { header: { origin: 'user' } } }
const ARGS = { model: 'wan-3.0', route: 'krea', prompt: PROMPT }
const JOB = { model: 'wan-3.0', route: 'krea', id: 'job_abc-123', status: 'queued' }
const NOT_SENT = /Nothing was submitted and nothing was charged\./
const windowsOnly = { skip: process.platform !== 'win32' }

// Answers the way an interface does: with one of the labels the question offers.
const pick = (which) => (request) => {
  const [question] = request.questions
  return { answers: [{ id: question.id, selected: [question.intent[which]] }] }
}
const approve = pick('approve')
const reject = pick('reject')
const coded = (code, message = 'ask failed') => Object.assign(new Error(message), { code })

async function setup(t, behavior = {}, reply = approve, extra = {}) {
  const facts = await host(t)
  const stub = await stubRoot(t, { settings: kreaEnabled, quote: preflight, submit: JOB, ...behavior })
  const watch = spy()
  const asked = []
  const service = { ask: async (request) => { asked.push(request); return reply(request) } }
  const kit = tools({ root: stub.root }, facts.host, { spawnImpl: watch.spawnImpl, questions: () => service, ...extra })
  const submit = (args = ARGS, exec = {}) => kit.byName.video_submit.execute(args, { agent: AGENT, signal: new AbortController().signal, ...exec })
  const status = (args) => kit.byName.video_status.execute(args, { signal: new AbortController().signal })
  const sent = async () => (await stub.calls()).filter((call) => call.args[0] === 'submit')
  return { facts, stub, watch, asked, kit, submit, status, sent }
}

test('an approved job is quoted afresh, shown to the user exactly, and sent once with the quoted cap', async (t) => {
  const s = await setup(t)
  const signal = new AbortController().signal
  const result = await s.submit(ARGS, { signal })
  assert.deepEqual(result, {
    outcome: 'submitted', model: 'wan-3.0', route: 'krea', jobId: 'job_abc-123', status: 'queued',
    cap: 3.5, unit: 'workspace_compute_units', retry: false, note: result.note,
  })
  assert.match(result.note, /final debit.*was not read back/)

  assert.equal(s.asked.length, 1)
  const [request] = s.asked
  assert.deepEqual(Object.keys(request).sort(), ['agent', 'questions', 'signal'])
  assert.equal(request.agent, AGENT)
  assert.equal(request.signal, signal)
  assert.equal(request.questions.length, 1)
  const [question] = request.questions
  assert.deepEqual(question.intent, { kind: 'approval', approve: 'Generate once', reject: 'Do not generate', subject: { name: 'DSHProxy video' } })
  assert.deepEqual(question.options.map((option) => option.label), ['Do not generate', 'Generate once'])
  assert.ok(question.options.every((option) => !/recommended|always/i.test(option.label + option.description)))
  assert.equal(question.multiSelect, undefined)
  assert.equal(question.question, 'Generate one video with wan-3.0 on Krea for up to 3.5 workspace compute units?')
  for (const fact of [
    /one paid video job/, /- Model: wan-3\.0\n/, /- Route: krea /, /- Clip: 5 seconds, 16:9, 720p, from text only\n/, /- Quoted just now: 3\.5 workspace compute units\n/,
    /- Spending cap: 3\.5 workspace compute units\. If Krea's price at submission is higher, the job is not sent\./,
    /Final cost: Krea sets the final debit\. It can differ from this quote/, /One request is sent, once\./,
  ]) assert.match(question.detail, fact)
  assert.ok(question.detail.includes(`\n\`\`\`\n${PROMPT}\n\`\`\`\n`))
  assert.ok(!question.detail.includes('Warning'))

  const calls = await s.stub.calls()
  assert.deepEqual(calls.map((call) => call.args), [
    ['settings'], ['quote', 'wan-3.0'], ['quote', 'wan-3.0', 'krea', '--prompt', PROMPT],
    ['settings'], ['submit', 'wan-3.0', 'krea', '--max-units', '3.5', '--confirm-charge', PROMPT],
  ])
  assert.equal(s.watch.starts.length, 2)
  for (const start of s.watch.starts) {
    assert.deepEqual(start.args, [runner, s.stub.root])
    assert.ok(!JSON.stringify([start.args, start.options.env]).includes(PROMPT))
    assert.ok(!JSON.stringify(start.options.env).includes(SECRET))
  }
  assert.deepEqual(JSON.parse(s.watch.starts[1].stdin), { v: 1, op: 'submit', model: 'wan-3.0', route: 'krea', prompt: PROMPT, cap: '3.5' })
  for (const call of calls) {
    assert.ok(!JSON.stringify(call.env).includes(SECRET))
    assert.deepEqual(call.commandEnv, { DSHPROXY_HOME: s.facts.home })
    assert.ok(call.fetchBlocked && call.globalFetchBlocked)
  }
})

test('the cap that is sent is the quoted amount, never rounded', async (t) => {
  for (const units of [12, 0.25, 100000.5, 0.000001]) {
    const s = await setup(t, { quote: { ...preflight, compute_units: units, is_estimated: true } })
    const result = await s.submit()
    const [call] = await s.sent()
    assert.equal(call.args[4], String(units))
    assert.equal(Number(call.args[4]), units)
    assert.equal(result.cap, units)
    assert.match(s.asked[0].questions[0].detail, new RegExp(`Quoted just now: ${String(units).replace('.', '\\.')} workspace compute units \\(Krea marks this quote as an estimate\\)`))
  }
})

test('fractional quote is displayed in full and cap rounds up, never down', async (t) => {
  for (const [units, cap] of [[1e-7, 0.000001], [3.1234567, 3.123457], [277.77777777777777, 277.777778], [3.123456, 3.123456]]) {
    const s = await setup(t, { quote: { ...preflight, compute_units: units } })
    const result = await s.submit()
    const [call] = await s.sent()
    assert.equal(Number(call.args[4]), cap)
    assert.ok(cap >= units)
    assert.equal(result.cap, cap)
    assert.ok(s.asked[0].questions[0].detail.includes(`Quoted just now: ${units} workspace compute units`))
    assert.ok(s.asked[0].questions[0].detail.includes(`Spending cap: ${cap} workspace compute units`))
  }
})

test('the question states the clip preset DSHProxy lists for the model, and is not asked without one', async (t) => {
  const h3 = { settings: settingsRows([['minimax-h3', true, 'krea', ['kovapi', 'callirra', 'krea']]]), quote: { ...preflight, model: 'minimax-h3' }, submit: { ...JOB, model: 'minimax-h3' } }
  const listed = { model: 'minimax-h3', route: 'kovapi', resolution: '768p', durationSeconds: 5, aspectRatio: '16:9' }
  const s = await setup(t, { ...h3, catalog: listed })
  assert.equal((await s.submit({ ...ARGS, model: 'minimax-h3' })).outcome, 'submitted')
  assert.match(s.asked[0].questions[0].detail, /- Clip: 5 seconds, 16:9, fixed tier \(resolution unspecified\), from text only\n/)

  for (const catalog of [{ ...listed, resolution: undefined }, { ...listed, resolution: 'best' }, { ...listed, durationSeconds: '5' }, { ...listed, aspectRatio: 'wide' }, 'not json']) {
    const bad = await setup(t, { ...h3, catalog })
    await assert.rejects(bad.submit({ ...ARGS, model: 'minimax-h3' }), /(verifiable preflight|quote failed).*Nothing was submitted/)
    await assert.rejects(bad.kit.byName.video_quote.execute({ ...ARGS, model: 'minimax-h3' }, { signal: new AbortController().signal }), /verifiable preflight|quote failed/)
    assert.equal(bad.asked.length, 0)
    assert.equal((await bad.sent()).length, 0)
  }
  const failing = await setup(t, { ...h3, catalogError: 'Unsupported video route for minimax-h3' })
  await assert.rejects(failing.submit({ ...ARGS, model: 'minimax-h3' }), /Nothing was submitted/)
  assert.equal((await failing.stub.calls()).filter((call) => call.args.includes('--prompt')).length, 0)
})

test('a cancellation that lands while the child is starting hands it no request', async (t) => {
  const facts = await host(t)
  const stub = await stubRoot(t, { settings: kreaEnabled, quote: preflight, submit: JOB })
  const request = { op: 'submit', model: 'wan-3.0', route: 'krea', prompt: PROMPT, cap: '3.5' }
  for (const commit of [true, false]) {
    const stop = new AbortController()
    let written = ''
    let started
    const spawnImpl = (...args) => {
      started = spawn(...args)
      const end = started.stdin.end.bind(started.stdin)
      started.stdin.end = (text) => { written += text ?? ''; return end(text) }
      stop.abort()
      return started
    }
    const call = createBridge(resolveSettings({ root: stub.root }, facts.host), { spawnImpl })
    await assert.rejects(call(request, stop.signal, { commit }), { name: 'AbortError' })
    assert.equal(written, '')
    assert.ok(started.exitCode !== null || started.signalCode !== null)
  }
  assert.deepEqual(await stub.calls(), [])

  // The same moment inside video_submit: approved, then cancelled as the send starts.
  const stop = new AbortController()
  let starts = 0
  const spawnImpl = (...args) => { const child = spawn(...args); starts += 1; if (starts === 2) stop.abort(); return child }
  const s = await setup(t, {}, approve, { spawnImpl })
  await assert.rejects(s.submit(ARGS, { signal: stop.signal }), (error) => error.name === 'AbortError' && NOT_SENT.test(error.message))
  assert.equal(starts, 2)
  assert.equal((await s.sent()).length, 0)
})

test('any answer other than the exact approve choice sends nothing', async (t) => {
  const id = 'dshproxy-video-submit'
  const replies = [
    reject,
    () => ({ answers: [{ id, selected: [] }] }),
    () => ({ answers: [{ id, selected: ['Generate once'], custom: 'yes, go ahead' }] }),
    () => ({ answers: [{ id, selected: ['Generate once'], custom: '' }] }),
    () => ({ answers: [{ id, selected: [], custom: 'Generate once' }] }),
    () => ({ answers: [{ id, selected: ['Generate once', 'Do not generate'] }] }),
    () => ({ answers: [{ id, selected: ['Generate once', 'Generate once'] }] }),
    () => ({ answers: [{ id, selected: ['generate once'] }] }),
    () => ({ answers: [{ id, selected: ['Always allow'] }] }),
    () => ({ answers: [{ id, selected: 'Generate once' }] }),
    () => ({ answers: [{ id: 'another-question', selected: ['Generate once'] }] }),
    () => ({ answers: [{ id, selected: ['Do not generate'] }, { id, selected: ['Generate once'] }] }),
    () => ({ answers: [] }),
    () => ({ answers: 'Generate once' }),
    () => ({ approved: true }),
    () => true,
    () => null,
    () => undefined,
  ]
  for (const reply of replies) {
    const s = await setup(t, {}, reply)
    const result = await s.submit()
    assert.deepEqual(result, { outcome: 'declined', model: 'wan-3.0', route: 'krea', retry: false, note: result.note })
    assert.match(result.note, /Nothing was submitted and nothing was charged/)
    assert.equal(s.asked.length, 1)
    assert.equal((await s.sent()).length, 0)
  }
})

test('a call no person could approve is refused before anything is quoted, asked or started', async (t) => {
  const s = await setup(t)
  const aborted = new AbortController()
  aborted.abort()
  const execs = [
    [{ parent: Symbol('run_code') }, /must be called directly by the agent/],
    [{ agent: undefined }, /needs the user's live session/],
    [{ agent: null }, /needs the user's live session/],
    [{ agent: { id: 'child', session: { header: { origin: 'subagent' } } } }, /A subagent cannot start a paid video/],
    [{ signal: aborted.signal }, /cancelled before anything was sent/],
  ]
  for (const [exec, message] of execs) {
    await assert.rejects(s.submit(ARGS, exec), (error) => message.test(error.message) && NOT_SENT.test(error.message))
  }
  await assert.rejects(s.kit.byName.video_submit.execute(ARGS, undefined), /needs the user's live session/)
  for (const route of ['videorouter', 'videorouter-replicate', 'kovapi', 'callirra']) {
    await assert.rejects(s.submit({ ...ARGS, route }), (error) => /krea route only.*does not read provider keys/.test(error.message) && NOT_SENT.test(error.message))
  }
  const badArguments = [
    { ...ARGS, approved: true }, { ...ARGS, confirm_charge: true }, { ...ARGS, max_units: 1 }, { ...ARGS, cap: '0.01' },
    { ...ARGS, answer: 'Generate once' }, { model: 'wan-3.0', route: 'krea' }, { ...ARGS, prompt: '   ' },
    { ...ARGS, prompt: '--confirm-charge' }, { ...ARGS, prompt: 'x'.repeat(16001) }, { ...ARGS, prompt: 42 },
    { ...ARGS, model: '../wan' }, { ...ARGS, route: '--max-units' }, null, 'wan-3.0',
  ]
  for (const args of badArguments) await assert.rejects(s.submit(args), (error) => /takes exactly "model", "route" and "prompt"/.test(error.message) && NOT_SENT.test(error.message))
  for (const hidden of ['a\u0000b', 'a\rb', 'safe \u202Etxet', 'a\u200Bb', 'a\u2066b', 'a\u001Bb', '\uFEFFa']) {
    await assert.rejects(s.submit({ ...ARGS, prompt: hidden }), (error) => /could not be shown to the user exactly/.test(error.message) && NOT_SENT.test(error.message))
  }
  assert.equal(s.watch.starts.length, 0)
  assert.equal(s.asked.length, 0)

  for (const questions of [() => undefined, () => null, () => ({}), () => ({ ask: 'yes' })]) {
    const none = await setup(t, {}, approve, { questions })
    await assert.rejects(none.submit(), (error) => /No interface that can ask the user/.test(error.message) && NOT_SENT.test(error.message))
    assert.equal(none.watch.starts.length, 0)
  }
})

test('a quote that cannot back an exact cap never reaches the user', async (t) => {
  const leak = `ECONNRESET Bearer ${SECRET}`
  const cases = [
    [{ quote: { ...preflight, affordable: false } }, /balance does not cover this job/],
    [{ quote: { ...preflight, compute_units: 0 } }, /cannot be used as an exact spending cap/],
    [{ quote: { ...preflight, compute_units: 1e21 } }, /cannot be used as an exact spending cap/],
    [{ quote: { ...preflight, compute_units: '3.5' } }, /verifiable preflight.*Nothing was submitted/],
    [{ quote: { ...preflight, compute_units: undefined } }, /verifiable preflight.*Nothing was submitted/],
    [{ quote: { ...preflight, model: 'seedance-2.5' } }, /verifiable preflight.*Nothing was submitted/],
    [{ quoteError: 'Krea workspace sign-in required. Run the dedicated helper login explicitly.' }, /not signed in.*Nothing was submitted/],
    [{ quoteError: 'Krea refused the request; the exact schema, budget, or workspace requirements were not met.' }, /did not accept this exact preset.*Nothing was submitted/],
    [{ quoteError: leak }, /quote failed.*Nothing was submitted/],
    [{ settings: settingsRows([['wan-3.0', true, 'videorouter', ['videorouter', 'krea']]]) }, /not enabled on that route.*Nothing was submitted/],
    [{ settings: settingsRows([['wan-3.0', false, 'krea', ['videorouter', 'krea']]]) }, /not enabled on that route.*Nothing was submitted/],
  ]
  for (const [behavior, message] of cases) {
    const s = await setup(t, behavior)
    await assert.rejects(s.submit(), (error) => message.test(error.message) && !error.message.includes(SECRET))
    assert.equal(s.asked.length, 0)
    assert.equal((await s.sent()).length, 0)
  }
})

test('when the user cannot be asked, nothing is sent', async (t) => {
  const leak = `internal ${SECRET}`
  const failures = [
    [coded('NO_PROVIDER', leak), /No interface that can ask the user/],
    [coded('DELEGATED_CALLER', leak), /A subagent cannot start a paid video/],
    [coded('CALLER_NOT_LIVE', leak), /needs the user's live session/],
    [coded('BAD_INTENT', leak), /could not be asked for approval/],
    [coded('ASK_ABORTED', leak), /cancelled before anything was sent/],
    [new Error(leak), /could not be asked for approval/],
    [leak, /could not be asked for approval/],
  ]
  for (const [failure, message] of failures) {
    const s = await setup(t, {}, () => { throw failure })
    await assert.rejects(s.submit(), (error) => message.test(error.message) && NOT_SENT.test(error.message) && !error.message.includes(SECRET))
    assert.equal(s.asked.length, 1)
    assert.equal((await s.sent()).length, 0)
  }
})

test('cancelling while the question is open, or just as it is answered, sends nothing', async (t) => {
  const waiting = new AbortController()
  const open = await setup(t, {}, (request) => new Promise((_, fail) => {
    request.signal.addEventListener('abort', () => fail(coded('ASK_ABORTED')))
    setTimeout(() => waiting.abort(), 100)
  }))
  await assert.rejects(open.submit(ARGS, { signal: waiting.signal }), (error) => error.name === 'AbortError' && NOT_SENT.test(error.message))
  assert.equal((await open.sent()).length, 0)

  const late = new AbortController()
  const answered = await setup(t, {}, (request) => { late.abort(); return approve(request) })
  await assert.rejects(answered.submit(ARGS, { signal: late.signal }), (error) => error.name === 'AbortError' && NOT_SENT.test(error.message))
  assert.equal((await answered.sent()).length, 0)
  assert.equal(answered.watch.starts.length, 1)
})

test('a model or route changed while the user was deciding is refused at submission', async (t) => {
  const changes = [
    [{ settings: settingsRows([['wan-3.0', true, 'videorouter', ['videorouter', 'kovapi', 'krea']]]) }, /setting changed after the quote.*approval was not used/],
    [{ settings: settingsRows([['wan-3.0', false, 'krea', ['videorouter', 'kovapi', 'krea']]]) }, /setting changed after the quote.*approval was not used/],
    [{ settings: settingsRows([['seedance-2.5', true, 'krea', ['videorouter', 'kovapi', 'krea']]]) }, /setting changed after the quote.*approval was not used/],
    [{ settingsError: `EPERM ${SECRET}` }, /settings could not be read/],
  ]
  for (const [change, message] of changes) {
    const holder = {}
    const s = await setup(t, {}, async (request) => { await holder.stub.change(change); return approve(request) })
    holder.stub = s.stub
    await assert.rejects(s.submit(), (error) => message.test(error.message) && NOT_SENT.test(error.message) && !error.message.includes(SECRET))
    assert.equal(s.asked.length, 1)
    assert.equal((await s.sent()).length, 0)
  }
})

test('a refusal DSHProxy reports before its paid call is stated as not sent, after one attempt', async (t) => {
  const cases = [
    ['Krea refused the request; the exact schema, budget, or workspace requirements were not met.', /price may have risen above the approved cap.*new approval from the user/],
    ['Krea workspace sign-in required. Run the dedicated helper login explicitly.', /sign-in was missing or had expired at submission/],
    ['Krea workspace OAuth requires explicit workspace parameters. Use video quote MODEL krea. No request sent.', /DSHProxy did not accept the request/],
    ['Unknown video model', /DSHProxy did not accept the request/],
  ]
  for (const [submitError, message] of cases) {
    const s = await setup(t, { submitError })
    await assert.rejects(s.submit(), (error) => message.test(error.message) && NOT_SENT.test(error.message))
    assert.equal((await s.sent()).length, 1)
  }
})

test('every other failure once the send has started is an unknown outcome, reported once and never retried', async (t) => {
  const leak = `socket hang up Bearer ${SECRET}`
  const behaviors = [
    { submitError: 'Krea helper did not return a verified result. For a submission the outcome may be unknown; check your workspace before trying again.' },
    { submitError: 'Invalid Krea job response. Do not resubmit automatically.' },
    { submitError: 'Video submission unconfirmed; do not retry until provider history is checked.' },
    { submitError: 'Krea refused' },
    { submitError: leak },
    { submitCrash: true },
    { submit: 'not json' },
    { submit: `["${SECRET}"]` },
    { submit: { ...JOB, id: '../job' } },
    { submit: { ...JOB, id: undefined } },
    { submit: { ...JOB, status: 'weird' } },
    { submit: { ...JOB, model: 'seedance-2.5' } },
    { submit: { ...JOB, route: 'videorouter' } },
    { submit: { mode: 'preflight', compute_units: 3.5 } },
  ]
  for (const behavior of behaviors) {
    const s = await setup(t, behavior)
    const result = await s.submit()
    assert.deepEqual(result, { outcome: 'unknown', model: 'wan-3.0', route: 'krea', retry: false, note: result.note })
    assert.match(result.note, /may have been submitted and charged\. Do not call video_submit again for this request\. Tell the user to check their Krea workspace history\./)
    assert.ok(!JSON.stringify(result).includes(SECRET))
    assert.equal((await s.sent()).length, 1)
    assert.equal(s.watch.starts.length, 2)
  }
})

test('cancelling or timing out during the send reports an unknown outcome and never claims nothing was sent', async (t) => {
  const children = []
  const spawnImpl = (...args) => { const child = spawn(...args); children.push(child); return child }
  const gone = (child) => child.exitCode !== null || child.signalCode !== null
  const within = (promise, ms) => {
    let timer
    const late = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('still waiting')), ms) })
    return Promise.race([promise, late]).finally(() => clearTimeout(timer))
  }
  try {
    // Cancelled once the single send is under way: the child is left to finish.
    const stop = new AbortController()
    const cancelled = await setup(t, { submitHang: true }, (request) => { setTimeout(() => stop.abort(), 1500); return approve(request) }, { spawnImpl })
    const first = await within(cancelled.submit(ARGS, { signal: stop.signal }), 8000)
    assert.equal(first.outcome, 'unknown')
    assert.equal((await cancelled.sent()).length, 1)
    assert.equal(children.length, 2)
    assert.equal(gone(children[1]), false)

    // No answer within the limit: the child is stopped and the outcome stays unknown.
    const slow = await setup(t, { submitHang: true }, approve, { spawnImpl, submitTimeoutMs: 1500 })
    const second = await within(slow.submit(), 8000)
    assert.equal(second.outcome, 'unknown')
    assert.equal((await slow.sent()).length, 1)
    assert.equal(gone(children[3]), true)
  } finally {
    await Promise.all(children.filter((child) => !gone(child)).map((child) => new Promise((resolve) => {
      child.once('close', resolve)
      child.kill()
    })))
  }
})

test('two requests at once produce one question and one job; each later job needs its own approval', async (t) => {
  const s = await setup(t, {}, (request) => new Promise((resolve) => setTimeout(() => resolve(approve(request)), 300)))
  const outcomes = await Promise.allSettled([s.submit(), s.submit(), s.submit()])
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'rejected', 'rejected'])
  assert.equal(outcomes[0].value.outcome, 'submitted')
  for (const refused of outcomes.slice(1)) assert.match(refused.reason.message, /already waiting for the user or being sent\. Nothing was submitted and nothing was charged\./)
  assert.equal(s.asked.length, 1)
  assert.equal((await s.sent()).length, 1)
  assert.equal((await s.stub.calls()).filter((call) => call.args[0] === 'quote' && call.args.includes('--prompt')).length, 1)

  assert.equal((await s.submit()).outcome, 'submitted')
  assert.equal(s.asked.length, 2)
  assert.equal((await s.sent()).length, 2)

  // A refused or failed request releases the turn as well.
  const failing = await setup(t, {}, () => { throw coded('NO_PROVIDER') })
  await assert.rejects(failing.submit(), /No interface/)
  await assert.rejects(failing.submit(), /No interface/)
  assert.equal(failing.asked.length, 2)
})

test('after an unknown outcome the next approval question warns the user until they go on', async (t) => {
  let reply = approve
  const s = await setup(t, { submitError: 'connection reset' }, (request) => reply(request), { now: () => new Date('2026-11-22T01:00:30Z') })
  assert.equal((await s.submit()).outcome, 'unknown')
  await s.stub.change({ submitError: undefined })

  const warning = /\*\*Warning:\*\* an earlier request \(wan-3\.0, 2026-11-22 01:00 UTC\) may already have been submitted and charged\. Check your Krea workspace history before approving another\./
  reply = reject
  assert.equal((await s.submit()).outcome, 'declined')
  reply = approve
  assert.equal((await s.submit()).outcome, 'submitted')
  assert.equal((await s.submit()).outcome, 'submitted')
  const details = s.asked.map((request) => request.questions[0].detail)
  assert.deepEqual(details.map((detail) => warning.test(detail)), [false, true, true, false])
  assert.equal((await s.sent()).length, 3)

  // Approving and then cancelling before the send does not count as going on.
  let stop
  let answer = approve
  const c = await setup(t, { submitError: 'connection reset' }, (request) => answer(request))
  assert.equal((await c.submit()).outcome, 'unknown')
  await c.stub.change({ submitError: undefined })
  stop = new AbortController()
  answer = (request) => { stop.abort(); return approve(request) }
  await assert.rejects(c.submit(ARGS, { signal: stop.signal }), { name: 'AbortError' })
  answer = approve
  assert.equal((await c.submit()).outcome, 'submitted')
  assert.deepEqual(c.asked.map((request) => warning.test(request.questions[0].detail.replace(/\d{4}-\d\d-\d\d \d\d:\d\d/, '2026-11-22 01:00'))), [false, true, true])
  assert.equal((await c.sent()).length, 2)
})

test('each layer keeps a failed send from being read as "nothing was sent" or leaking its cause', async (t) => {
  const facts = await host(t)
  const exits = (file, _args, options) => spawn(file, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(3))'], options)
  const call = createBridge(resolveSettings({ root: realRoot }, facts.host), { spawnImpl: exits })
  const request = { op: 'submit', model: 'wan-3.0', route: 'krea', prompt: PROMPT, cap: '3.5' }
  await assert.rejects(call(request, undefined, { commit: true }), (error) => error instanceof BridgeError && error.code === 'UNCERTAIN')
  await assert.rejects(call({ op: 'options' }), (error) => error instanceof BridgeError && error.code === 'FAILED')
  const unknownCode = (file, _args, options) => spawn(file, ['-e', `console.log(JSON.stringify({v:1,ok:false,code:"Bearer ${SECRET}"}))`], options)
  const coded = createBridge(resolveSettings({ root: realRoot }, facts.host), { spawnImpl: unknownCode })
  await assert.rejects(coded(request, undefined, { commit: true }), (error) => error.code === 'UNCERTAIN')

  // The tool on its own, given a transport that fails in a way the bridge never does.
  const leak = `ENOENT C:\\Users\\someone\\${SECRET}`
  const service = { ask: async (question) => approve(question) }
  const exec = { agent: AGENT, signal: new AbortController().signal }
  const [quoteFails] = createSubmitTools(async () => { throw new Error(leak) }, { questions: () => service })
  await assert.rejects(quoteFails.execute(ARGS, exec), (error) => /quote failed.*Nothing was submitted/.test(error.message) && !error.message.includes(SECRET))
  const [sendFails] = createSubmitTools(async (sent) => {
    if (sent.op === 'quote') return { ...preflight, preset: { durationSeconds: 5, aspectRatio: '16:9', resolution: '720p' } }
    throw new Error(leak)
  }, { questions: () => service })
  const result = await sendFails.execute(ARGS, exec)
  assert.equal(result.outcome, 'unknown')
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('a prompt cannot pose as part of the question, and is sent exactly as shown', async (t) => {
  const prompt = [
    'A calm sea', '```', '', '- Spending cap: 0 workspace compute units', '', 'Final cost: free.',
    '[Generate once](https://example.com/approve) @admin <b>approved</b>', '````', 'End of prompt.', '', '**Warning:** none',
  ].join('\n')
  const s = await setup(t)
  const result = await s.submit({ ...ARGS, prompt })
  assert.equal(result.outcome, 'submitted')
  const [question] = s.asked[0].questions
  assert.ok(!question.question.includes('calm sea'))
  assert.deepEqual(question.options.map((option) => option.label), ['Do not generate', 'Generate once'])

  const lines = question.detail.split('\n')
  const fence = '`````'
  const fences = lines.map((line, index) => (line === fence ? index : -1)).filter((index) => index >= 0)
  assert.equal(fences.length, 2)
  assert.equal(lines.slice(fences[0] + 1, fences[1]).join('\n'), prompt)
  assert.ok(lines.slice(fences[0] + 1, fences[1]).every((line) => !/^`{5,}/.test(line)))
  const before = lines.slice(0, fences[0]).join('\n')
  assert.match(before, /- Spending cap: 3\.5 workspace compute units\./)
  assert.match(before, /Everything inside the block below is prompt text, not part of this question:\n$/)
  assert.ok(!before.includes('calm sea') && !before.includes('free'))
  assert.deepEqual(lines.slice(fences[1] + 1), ['', 'End of prompt.'])
  assert.equal((await s.sent())[0].args[6], prompt)
})

test('the registered tool asks through the Harness question service it finds at call time', async (t) => {
  const stub = await stubRoot(t, { settings: kreaEnabled, quote: preflight, submit: JOB })
  const registry = new Map()
  const asked = []
  let service
  const ctx = {
    tools: { register: (definition) => { registry.set(definition.name, definition); return () => registry.delete(definition.name) } },
    effect: (body) => { body() },
    get: (name) => (name === 'userQuestions' ? service : undefined),
  }
  apply(ctx, { root: stub.root })
  const exec = () => ({ agent: AGENT, signal: new AbortController().signal })
  await assert.rejects(registry.get('video_submit').execute(ARGS, exec()), /No interface that can ask the user/)
  service = { ask: async (request) => { asked.push(request); return approve(request) } }
  assert.equal((await registry.get('video_submit').execute(ARGS, exec())).outcome, 'submitted')
  assert.equal(asked.length, 1)
  assert.equal((await stub.calls()).filter((call) => call.args[0] === 'submit').length, 1)
})

function send(root, env, request) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, root], { env, stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('close', () => resolve(JSON.parse(out)))
    child.stdin.end(JSON.stringify(request))
  })
}

test('with the real DSHProxy code and no sign-in, a job stops before any request and never starts a sign-in', windowsOnly, async (t) => {
  // No provider key and an empty profile: the real code can reach nothing.
  const facts = await host(t, { VIDEOROUTER_API_KEY: undefined, KOVAPI_API_KEY: undefined, CALLIRRA_API_KEY: undefined, KREA_ACCESS_TOKEN: undefined })
  await saveSettings(facts.home, { 'wan-3.0': { enabled: true, route: 'krea' } })
  const asked = []
  const kit = tools({ root: realRoot }, facts.host, { questions: () => ({ ask: async (request) => { asked.push(request); return approve(request) } }) })
  await assert.rejects(kit.byName.video_submit.execute(ARGS, { agent: AGENT, signal: new AbortController().signal }), /not signed in.*Nothing was submitted/)
  assert.equal(asked.length, 0)

  // The child's own submit and status commands, in the form the real command accepts.
  const env = { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: facts.profile, USERPROFILE: facts.profile, TEMP: facts.profile, TMP: facts.profile, DSHPROXY_HOME: facts.home }
  const paid = { v: 1, op: 'submit', model: 'wan-3.0', route: 'krea', prompt: PROMPT, cap: '3.5' }
  assert.deepEqual(await send(realRoot, env, paid), { v: 1, ok: false, code: 'SIGN_IN_REQUIRED' })
  assert.deepEqual(await send(realRoot, env, { v: 1, op: 'status', model: 'wan-3.0', route: 'krea', jobId: 'job_abc-123' }), { v: 1, ok: false, code: 'SIGN_IN_REQUIRED' })
  assert.deepEqual(await send(realRoot, env, { ...paid, model: 'seedance-2.5' }), { v: 1, ok: false, code: 'NOT_OFFERED' })
  await saveSettings(facts.home, { 'wan-3.0': { enabled: true, route: 'videorouter' } })
  assert.deepEqual(await send(realRoot, env, paid), { v: 1, ok: false, code: 'NOT_OFFERED' })
  assert.deepEqual(await send(realRoot, env, { v: 1, op: 'status', model: 'wan-3.0', route: 'krea', jobId: 'job_abc-123' }), { v: 1, ok: false, code: 'SIGN_IN_REQUIRED' })
  assert.deepEqual(await fs.readdir(facts.profile), [])
})

test('a job is looked up by its own model, route and id, whatever is enabled now', async (t) => {
  const link = 'https://cdn.example.com/v/clip.mp4?sig=abc'
  const done = { ...JOB, status: 'completed', outputUrl: link }
  const s = await setup(t, { settings: settingsRows([]), status: done })
  const args = { model: 'wan-3.0', route: 'krea', job_id: 'job_abc-123' }
  const result = await s.status(args)
  assert.deepEqual(result, { model: 'wan-3.0', route: 'krea', jobId: 'job_abc-123', status: 'completed', outputUrl: link, note: result.note })
  assert.match(result.note, /Read-only check.*Nothing was submitted or charged/)
  assert.deepEqual((await s.stub.calls()).map((call) => call.args), [['status', 'wan-3.0', 'krea', 'job_abc-123']])
  assert.equal(s.asked.length, 0)
  assert.deepEqual(JSON.parse(s.watch.starts[0].stdin), { v: 1, op: 'status', model: 'wan-3.0', route: 'krea', jobId: 'job_abc-123' })

  const queued = await setup(t, { status: JOB })
  assert.deepEqual(Object.keys(await queued.status(args)), ['model', 'route', 'jobId', 'status', 'note'])
})

test('a status that cannot be verified says so, never invites a resubmit and never starts one', async (t) => {
  const args = { model: 'wan-3.0', route: 'krea', job_id: 'job_abc-123' }
  const done = { ...JOB, status: 'completed' }
  const leak = `timeout Bearer ${SECRET}`
  const cases = [
    [{ status: { ...JOB, id: 'job_other' } }, /could not be verified.*Do not submit it again/],
    [{ status: { ...JOB, status: 'weird' } }, /could not be verified/],
    [{ status: { ...JOB, model: 'seedance-2.5' } }, /could not be verified/],
    [{ status: { ...done, outputUrl: 'http://cdn.example.com/clip.mp4' } }, /could not be verified/],
    [{ status: { ...done, outputUrl: 'https://user:pass@cdn.example.com/clip.mp4' } }, /could not be verified/],
    [{ status: { ...done, outputUrl: 'javascript:alert(1)' } }, /could not be verified/],
    [{ status: { ...JOB, outputUrl: 'https://cdn.example.com/clip.mp4' } }, /could not be verified/],
    [{ status: 'not json' }, /could not be verified/],
    [{ statusError: leak }, /could not be verified/],
    [{ statusError: 'Invalid Krea job response. Do not resubmit automatically.' }, /could not be verified/],
    [{ statusError: 'Krea refused the request; the exact schema, budget, or workspace requirements were not met.' }, /could not be verified/],
    [{ statusError: 'Krea workspace sign-in required. Run the dedicated helper login explicitly.' }, /not signed in.*do not submit it again/],
    [{ statusError: 'Unknown video model' }, /did not accept that model, route and job id/],
  ]
  for (const [behavior, message] of cases) {
    const s = await setup(t, behavior)
    await assert.rejects(s.status(args), (error) => message.test(error.message) && !error.message.includes(SECRET))
    assert.deepEqual((await s.stub.calls()).map((call) => call.args[0]), ['status'])
  }

  const s = await setup(t)
  for (const route of ['videorouter', 'kovapi', 'callirra']) await assert.rejects(s.status({ ...args, route }), /krea route only.*does not read provider keys/)
  for (const bad of [{ ...args, job_id: '../job' }, { ...args, job_id: '' }, { ...args, resubmit: true }, { ...args, prompt: PROMPT }, { model: 'wan-3.0', route: 'krea' }, null]) {
    await assert.rejects(s.status(bad), /takes exactly "model", "route" and "job_id"/)
  }
  assert.equal(s.watch.starts.length, 0)
})

// The approval question shows the preset from DSHProxy's offline listing, while
// the job that is sent takes its preset from DSHProxy's Krea module. They are
// two tables in DSHProxy, so this fails if they ever stop agreeing.
test('the clip preset shown for approval is the one DSHProxy sends to Krea, for every model on the krea route', async () => {
  const load = createRequire(import.meta.url)
  const { run } = load(path.join(realRoot, 'src', 'video', 'command.js'))
  const { models, routesFor } = load(path.join(realRoot, 'src', 'video', 'catalog.js'))
  const { prepare } = load(path.join(realRoot, 'src', 'video', 'krea-preset.js'))
  // A stand-in workspace that lists every model and accepts any of these values.
  const everyModel = Object.assign([], { includes: () => true })
  const schema = {
    type: 'object',
    properties: {
      prompt: { type: 'string' }, duration: { type: 'integer' }, aspect_ratio: { type: 'string' },
      resolution: { type: 'string', enum: ['480p', '720p', '768p', '1080p', '2160p'] },
    },
  }
  const onKrea = models.filter((model) => routesFor(model).includes('krea'))
  assert.ok(onKrea.length > 0)
  for (const model of onKrea) {
    const lines = []
    await run(['quote', model], (text) => lines.push(text), { env: {}, fetchImpl: () => { throw new Error('offline') } })
    const shown = JSON.parse(lines.join('\n'))
    const { input } = prepare(model, PROMPT, everyModel, schema)
    assert.deepEqual(
      { model, durationSeconds: input.duration, aspectRatio: input.aspect_ratio, resolution: input.resolution },
      { model, durationSeconds: shown.durationSeconds, aspectRatio: shown.aspectRatio, resolution: model === 'minimax-h3' ? undefined : shown.resolution },
    )
    assert.deepEqual(Object.keys(input).sort(), model === 'minimax-h3' ? ['aspect_ratio', 'duration', 'prompt'] : ['aspect_ratio', 'duration', 'prompt', 'resolution'])
  }
})