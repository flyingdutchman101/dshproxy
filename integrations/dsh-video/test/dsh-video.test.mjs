// Everything here runs offline: synthetic settings in temporary folders, a
// temporary Windows profile for the one test that reaches the real Krea
// helper, and a stub DSHProxy folder wherever a provider answer is needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { apply, build } from '../index.js'
import { BridgeError, createBridge } from '../lib/bridge.js'
import { resolveSettings } from '../lib/config.js'
import { createTools } from '../lib/tools.js'

import {
  bundleDir, realRoot, runner, SECRET, PROMPT, ALLOWED_ENV, ADDED_BY_NODE_ON_WINDOWS, temporary, host, saveSettings, spy, tools, stubRoot, settingsRows, kreaEnabled, preflight,
} from '../testing/support.mjs'

// A stand-in plugin context. Its registry hands each disposer to the caller and
// removes nothing by itself, so a tool is only gone if the plugin removed it.
function pluginContext() {
  const registry = new Map()
  const cleanups = []
  return {
    registry,
    ctx: {
      tools: {
        register(definition) {
          if (registry.has(definition.name)) throw new Error(`duplicate tool "${definition.name}"`)
          registry.set(definition.name, definition)
          return () => { if (registry.get(definition.name) === definition) registry.delete(definition.name) }
        },
      },
      effect(body) {
        const cleanup = body()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
      get: () => undefined,
    },
    unload() { for (const cleanup of cleanups.splice(0).reverse()) cleanup() },
  }
}

const TOOL_NAMES = ['video_options', 'video_quote', 'video_submit', 'video_status']

test('turning the plugin off removes every tool', () => {
  const plugin = pluginContext()
  apply(plugin.ctx, {})
  assert.deepEqual([...plugin.registry.keys()], TOOL_NAMES)
  plugin.unload()
  assert.deepEqual([...plugin.registry.keys()], [])
})

test('a plugin that fails while loading leaves none of its tools behind', () => {
  const plugin = pluginContext()
  const taken = { name: 'video_status' }
  plugin.registry.set('video_status', taken)
  assert.throws(() => apply(plugin.ctx, {}), /duplicate tool "video_status"/)
  assert.deepEqual([...plugin.registry.entries()], [['video_status', taken]])
  plugin.unload()
  assert.deepEqual([...plugin.registry.entries()], [['video_status', taken]])
})

test('the bundle registers exactly its four tools, and only video_submit can spend', () => {
  const plugin = pluginContext()
  apply(plugin.ctx, {})
  const registered = [...plugin.registry.values()]
  assert.deepEqual(registered.map((tool) => tool.name), TOOL_NAMES)
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.timeoutMs, undefined)
  }
  assert.match(registered[1].description, /sends the prompt off this machine/i)
  assert.match(registered[1].description, /never generates or charges/i)
  assert.match(registered[2].description, /asks the user to approve that exact job/)
  assert.match(registered[2].description, /no argument that grants approval/)
  assert.deepEqual(Object.keys(registered[2].parameters.properties), ['model', 'route', 'prompt'])
  assert.equal(registered[2].parameters.additionalProperties, false)
  assert.match(registered[3].description, /never submits, resubmits or charges/)
})

test('options lists only models the user enabled with a chosen route, from local settings', async (t) => {
  const facts = await host(t)
  const watch = spy()
  const kit = tools({ root: realRoot }, facts.host, watch)
  assert.deepEqual((await kit.run('video_options', {})).models, [])
  await saveSettings(facts.home, {
    'wan-3.0': { enabled: true, route: 'videorouter' },
    'minimax-h3': { enabled: true, route: 'krea' },
    'seedance-2.0': { enabled: true, route: null },
    'seedance-2.5': { enabled: false, route: 'kovapi' },
  })
  const result = await kit.run('video_options', {})
  assert.deepEqual(result.models, [
    { model: 'minimax-h3', route: 'krea', quoteSendsPrompt: true, canSubmit: true },
    { model: 'wan-3.0', route: 'videorouter', quoteSendsPrompt: false, canSubmit: false },
  ])
  assert.deepEqual(await fs.readdir(facts.profile), [])
})

test('an API-route quote is the dated published estimate and never carries the prompt anywhere', async (t) => {
  const facts = await host(t)
  await saveSettings(facts.home, { 'wan-3.0': { enabled: true, route: 'videorouter' }, 'minimax-h3': { enabled: true, route: 'callirra' } })
  const watch = spy()
  const kit = tools({ root: realRoot }, facts.host, watch)
  const usd = await kit.run('video_quote', { model: 'wan-3.0', route: 'videorouter', prompt: PROMPT })
  assert.deepEqual([usd.kind, usd.amount, usd.unit, usd.estimatedUsd], ['published-estimate', 0.226013, 'USD', 0.226013])
  assert.deepEqual([usd.contactedProvider, usd.promptSent], [false, false])
  assert.deepEqual(usd.preset, { durationSeconds: 5, aspectRatio: '16:9', resolution: '720p', input: 'text' })
  assert.match(usd.estimateDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(usd.sources.every((url) => url.startsWith('https://')))
  const credits = await kit.run('video_quote', { model: 'minimax-h3', route: 'callirra' })
  assert.deepEqual([credits.amount, credits.unit, credits.estimatedUsd, credits.priceBasis], [10, 'plan_credits', 0.099667, 'effective'])
  assert.equal(typeof credits.assumption, 'string')
  assert.equal(watch.starts.length, 2)
  for (const start of watch.starts) assert.ok(!JSON.stringify([start.args, start.options.env, start.stdin]).includes(PROMPT))
})

test('a quote is refused unless the model is enabled on exactly that route', async (t) => {
  const facts = await host(t)
  await saveSettings(facts.home, { 'wan-3.0': { enabled: true, route: 'videorouter' }, 'seedance-2.0': { enabled: false, route: 'kovapi' } })
  const kit = tools({ root: realRoot }, facts.host)
  const refused = /not enabled on that route/
  await assert.rejects(kit.run('video_quote', { model: 'wan-3.0', route: 'kovapi' }), refused)
  await assert.rejects(kit.run('video_quote', { model: 'wan-3.0', route: 'krea', prompt: PROMPT }), refused)
  await assert.rejects(kit.run('video_quote', { model: 'seedance-2.0', route: 'kovapi' }), refused)
  await assert.rejects(kit.run('video_quote', { model: 'no-such-model', route: 'videorouter' }), refused)
  assert.deepEqual(await fs.readdir(facts.profile), [])
})

test('unreadable settings are reported without the file path or its contents', async (t) => {
  const facts = await host(t)
  await fs.writeFile(path.join(facts.home, 'video-settings.json'), `{"models": ${SECRET}`)
  const kit = tools({ root: realRoot }, facts.host)
  await assert.rejects(kit.run('video_options', {}), (error) => {
    assert.match(error.message, /settings could not be read/)
    assert.ok(!error.message.includes(facts.home) && !error.message.includes(SECRET))
    return true
  })
})

test('a workspace quote without a sign-in never starts one and writes nothing', { skip: process.platform !== 'win32' }, async (t) => {
  const facts = await host(t)
  await saveSettings(facts.home, { 'wan-3.0': { enabled: true, route: 'krea' } })
  const kit = tools({ root: realRoot }, facts.host)
  await assert.rejects(kit.run('video_quote', { model: 'wan-3.0', route: 'krea', prompt: PROMPT }), /not signed in/)
  assert.deepEqual(await fs.readdir(facts.profile), [])
})

test('a workspace quote hands the prompt over standard input only and returns just the verified preflight', async (t) => {
  const facts = await host(t)
  const stub = await stubRoot(t, { settings: kreaEnabled, quote: { ...preflight, access_token: SECRET, job_id: 'job_1' } })
  const watch = spy()
  const kit = tools({ root: stub.root }, facts.host, watch)
  const quote = await kit.run('video_quote', { model: 'wan-3.0', route: 'krea', prompt: PROMPT })
  assert.deepEqual(quote, {
    model: 'wan-3.0', route: 'krea', kind: 'workspace-preflight', amount: 3.5, unit: 'workspace_compute_units',
    isEstimated: false, affordable: true, preset: { durationSeconds: 5, aspectRatio: '16:9', resolution: '720p', input: 'text' },
    contactedProvider: true, promptSent: true, note: quote.note,
  })
  assert.match(quote.note, /prompt was sent to Krea/)
  assert.ok(!JSON.stringify(quote).includes(SECRET))

  const [start] = watch.starts
  assert.equal(watch.starts.length, 1)
  assert.deepEqual(start.args, [runner, stub.root])
  assert.equal(start.options.shell, false)
  assert.equal(start.options.cwd, stub.root)
  assert.deepEqual(Object.keys(start.options.env).filter((name) => !ALLOWED_ENV.includes(name.toUpperCase())), [])
  assert.ok(!JSON.stringify([start.args, start.options.env]).includes(PROMPT))
  assert.ok(start.stdin.includes(PROMPT))

  const calls = await stub.calls()
  assert.deepEqual(calls.map((call) => call.args), [['settings'], ['quote', 'wan-3.0'], ['quote', 'wan-3.0', 'krea', '--prompt', PROMPT]])
  for (const call of calls) {
    assert.deepEqual(call.argv, [stub.root])
    const expected = process.platform === 'win32' ? [...ALLOWED_ENV, ...ADDED_BY_NODE_ON_WINDOWS] : ALLOWED_ENV
    assert.deepEqual(Object.keys(call.env).filter((name) => !expected.includes(name.toUpperCase())), [])
    assert.ok(!JSON.stringify(call.env).includes(SECRET) && !JSON.stringify(call.env).includes(PROMPT))
    assert.deepEqual(call.commandEnv, { DSHPROXY_HOME: facts.home })
    assert.equal(call.cwd, stub.root)
    assert.ok(call.fetchBlocked && call.globalFetchBlocked)
  }
})

test('the child refuses every request outside its exact shapes and never changes settings', async (t) => {
  const facts = await host(t)
  const stub = await stubRoot(t, { settings: kreaEnabled, quote: preflight })
  const kit = tools({ root: stub.root }, facts.host)
  await kit.run('video_options', {})
  await kit.run('video_quote', { model: 'wan-3.0', route: 'krea', prompt: PROMPT })
  const send = (request) => new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, stub.root], { env: { SystemRoot: process.env.SystemRoot }, stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('close', () => resolve(JSON.parse(out)))
    child.stdin.end(typeof request === 'string' ? request : JSON.stringify(request))
  })
  const before = (await stub.calls()).length
  const refused = { v: 1, ok: false, code: 'BAD_REQUEST' }
  const paid = { v: 1, op: 'submit', model: 'wan-3.0', route: 'krea', prompt: PROMPT, cap: '3.5' }
  const { cap: omitted, ...withoutCap } = paid
  assert.deepEqual(await send(withoutCap), refused)
  for (const cap of ['0', '0.0', '-1', '1e3', '3.1234567', ' 3.5', '', 3.5, null]) assert.deepEqual(await send({ ...paid, cap }), refused)
  assert.deepEqual(await send({ ...paid, key: SECRET }), refused)
  assert.deepEqual(await send({ ...paid, confirmCharge: true }), refused)
  assert.deepEqual(await send({ ...paid, maxUsd: '1' }), refused)
  assert.deepEqual(await send({ ...paid, route: 'videorouter' }), refused)
  assert.deepEqual(await send({ ...paid, prompt: '--max-units' }), refused)
  assert.deepEqual(await send({ ...paid, op: 'resubmit' }), refused)
  assert.deepEqual(await send({ v: 1, op: 'status', model: 'wan-3.0', route: 'krea', jobId: '../job' }), refused)
  assert.deepEqual(await send({ v: 1, op: 'status', model: 'wan-3.0', route: 'videorouter', jobId: 'job_1' }), refused)
  assert.deepEqual(await send({ v: 1, op: 'status', model: 'wan-3.0', route: 'krea', jobId: 'job_1', key: SECRET }), refused)
  assert.deepEqual(await send({ v: 1, op: 'login' }), refused)
  assert.deepEqual(await send({ v: 1, op: 'settings', set: ['wan-3.0', 'krea', 'enabled'] }), refused)
  assert.deepEqual(await send({ v: 1, op: 'quote', model: 'wan-3.0', route: 'krea', prompt: PROMPT, maxUnits: 5, confirmCharge: true }), refused)
  assert.deepEqual(await send({ v: 1, op: 'options', set: ['wan-3.0', 'krea', 'enabled'] }), refused)
  assert.deepEqual(await send({ v: 1, op: 'quote', model: 'wan-3.0', route: 'videorouter', prompt: PROMPT }), refused)
  // Valid apart from its size: only the size limit refuses it.
  assert.deepEqual(await send(JSON.stringify({ v: 1, op: 'options' }) + ' '.repeat(70000)), refused)
  assert.deepEqual(await send('not json'), refused)
  assert.equal((await stub.calls()).length, before)
  for (const call of await stub.calls()) {
    assert.ok(call.args[0] === 'settings' ? call.args.length === 1 : call.args[0] === 'quote')
  }
})

test('a provider answer that is not a complete preflight is refused, never read as zero', async (t) => {
  const facts = await host(t)
  const { compute_units: omitted, ...withoutAmount } = preflight
  const wrong = [
    withoutAmount,
    { ...preflight, compute_units: null },
    { ...preflight, compute_units: '3.5' },
    { ...preflight, compute_units: -1 },
    { ...preflight, affordable: 'yes' },
    { ...preflight, mode: 'job' },
    { ...preflight, model: 'seedance-2.5' },
    { ...preflight, route: 'videorouter' },
    { ...preflight, currency: 'USD' },
  ]
  for (const quote of wrong) {
    const stub = await stubRoot(t, { settings: kreaEnabled, quote })
    const kit = tools({ root: stub.root }, facts.host)
    await assert.rejects(kit.run('video_quote', { model: 'wan-3.0', route: 'krea', prompt: PROMPT }), /No quote was obtained/)
  }
  const usdRow = settingsRows([['wan-3.0', true, 'videorouter', ['videorouter', 'krea']]])
  const estimate = { model: 'wan-3.0', route: 'videorouter', resolution: '720p', durationSeconds: 5, aspectRatio: '16:9',
    verifiedOn: '2026-11-21', priceBasis: 'published', currency: 'USD', amount: 0.2, estimatedUsd: 0.2, sourceUrls: ['https://example.com/a'] }
  for (const quote of [{ ...estimate, amount: 0 }, { ...estimate, amount: undefined }, { ...estimate, sourceUrls: ['http://example.com/a'] }]) {
    const stub = await stubRoot(t, { settings: usdRow, quote })
    const kit = tools({ root: stub.root }, facts.host)
    await assert.rejects(kit.run('video_quote', { model: 'wan-3.0', route: 'videorouter' }), /No quote was obtained/)
  }
})

test('failures reach the model as fixed wording, without upstream text', async (t) => {
  const facts = await host(t)
  const leaky = `ECONNRESET Bearer ${SECRET} at C:\\Users\\someone\\secret.json`
  const cases = [
    [{ settings: kreaEnabled, quoteError: leaky }, /quote failed/],
    [{ settings: kreaEnabled, quoteError: 'Krea workspace sign-in required. Run the dedicated helper login explicitly.' }, /not signed in/],
    [{ settings: kreaEnabled, quoteError: 'Krea refused the request; the exact schema, budget, or workspace requirements were not met.' }, /did not accept/],
    [{ settings: kreaEnabled, quoteError: 'Krea helper did not return a verified result. For a submission the outcome may be unknown; check your workspace before trying again.' }, /verifiable preflight/],
    [{ settingsError: leaky }, /settings could not be read/],
    [{ settings: { models: SECRET } }, /settings could not be read/],
  ]
  for (const [behavior, expected] of cases) {
    const stub = await stubRoot(t, behavior)
    const kit = tools({ root: stub.root }, facts.host)
    await assert.rejects(kit.run('video_quote', { model: 'wan-3.0', route: 'krea', prompt: PROMPT }), (error) => {
      assert.match(error.message, expected)
      assert.ok(!error.message.includes(SECRET) && !error.message.includes('someone'))
      return true
    })
  }
})

test('malformed tool arguments are refused before any process starts', async (t) => {
  const facts = await host(t)
  const watch = spy()
  const kit = tools({ root: realRoot }, facts.host, watch)
  const bad = [
    {},
    { model: 'wan-3.0' },
    { model: 'wan-3.0', route: 'krea' },
    { model: 'wan-3.0', route: 'krea', prompt: '   ' },
    { model: 'wan-3.0', route: 'krea', prompt: '--confirm-charge' },
    { model: 'wan-3.0', route: 'krea', prompt: 'x'.repeat(16001) },
    { model: 'wan-3.0', route: 'krea', prompt: 'a\u0000b' },
    { model: 'wan-3.0', route: 'krea', prompt: 42 },
    { model: '../wan', route: 'krea', prompt: PROMPT },
    { model: 'wan-3.0', route: '--max-units', prompt: PROMPT },
    { model: 'wan-3.0', route: 'krea', prompt: PROMPT, confirmCharge: true },
    null,
  ]
  for (const args of bad) await assert.rejects(kit.run('video_quote', args), /video_quote takes/)
  await assert.rejects(kit.run('video_options', { route: 'krea' }), /video_options takes no arguments/)
  assert.equal(watch.starts.length, 0)
})

test('a quote that hangs is stopped at the time limit, and on cancellation', async (t) => {
  const facts = await host(t)
  const stub = await stubRoot(t, { settings: kreaEnabled, hang: true })
  // Children are tracked so that a missing time limit fails this test instead
  // of leaving a process behind that keeps the test run open.
  const children = []
  const spawnImpl = (...args) => { const child = spawn(...args); children.push(child); return child }
  const gone = (child) => child.exitCode !== null || child.signalCode !== null
  const within = (promise, ms) => {
    let timer
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('still waiting')), ms) })
    return Promise.race([promise, late]).finally(() => clearTimeout(timer))
  }
  try {
    const kit = tools({ root: stub.root, timeoutMs: 1500 }, facts.host, { spawnImpl })
    await assert.rejects(within(kit.run('video_quote', { model: 'wan-3.0', route: 'krea', prompt: PROMPT }), 8000),
      /timed out\. No quote was obtained\. The prompt may already have been sent to Krea/)
    assert.ok(gone(children[0]))
    const controller = new AbortController()
    const pending = kit.run('video_quote', { model: 'wan-3.0', route: 'krea', prompt: PROMPT }, controller.signal)
    setTimeout(() => controller.abort(), 300)
    await assert.rejects(within(pending, 8000), { name: 'AbortError' })
    assert.ok(gone(children[1]))
  } finally {
    // Before the temporary folders go: a live child holds its working folder.
    await Promise.all(children.filter((child) => !gone(child)).map((child) => new Promise((resolve) => {
      child.once('close', resolve)
      child.kill()
    })))
  }
})

test('an answer from the child that breaks the contract becomes the fixed failure message', async (t) => {
  const facts = await host(t)
  const leak = `Bearer ${SECRET}`
  const answers = [
    { v: 1, ok: false, code: leak },
    { v: 1, ok: false, code: 'FAILED', detail: leak },
    { v: 2, ok: true, data: { models: [] } },
    { v: 1, ok: true, data: [leak] },
    { v: 1, ok: true, data: { models: [{ model: leak, route: 'krea' }] } },
    { oversized: true },
    '',
  ]
  for (const reply of answers) {
    // The oversized answer is otherwise valid, so only the size limit refuses it.
    const output = reply.oversized
      ? `JSON.stringify({v:1,ok:true,data:{models:[],pad:'x'.repeat(70000)}})`
      : JSON.stringify(typeof reply === 'string' ? reply : JSON.stringify(reply))
    const script = `process.stderr.write(${JSON.stringify(leak)});process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${output}))`
    const spawnImpl = (file, _args, options) => spawn(file, ['-e', script], options)
    const kit = tools({ root: realRoot }, facts.host, { spawnImpl })
    await assert.rejects(kit.run('video_options', {}), (error) => {
      assert.match(error.message, /quote failed|settings could not be read/)
      assert.ok(!error.message.includes(SECRET))
      return true
    })
  }
  const exits = (file, _args, options) => spawn(file, ['-e', `console.log(JSON.stringify({v:1,ok:true,data:{models:[]}}));process.exitCode=3`], options)
  await assert.rejects(tools({ root: realRoot }, facts.host, { spawnImpl: exits }).run('video_options', {}), /quote failed/)

  // Each layer holds on its own: the bridge reduces an unknown code to FAILED,
  // and the tools print only their own wording for a code they do not know.
  const unknownCode = (file, _args, options) => spawn(file, ['-e', `console.log(JSON.stringify({v:1,ok:false,code:${JSON.stringify(leak)}}))`], options)
  const call = createBridge(resolveSettings({ root: realRoot }, facts.host), { spawnImpl: unknownCode })
  await assert.rejects(call({ op: 'options' }), (error) => error instanceof BridgeError && error.code === 'FAILED')
  const [options] = createTools(async () => { throw new BridgeError(leak) })
  await assert.rejects(options.execute({}, {}), (error) => !error.message.includes(SECRET) && /quote failed/.test(error.message))
})

test('only a DSHProxy folder is accepted as the root', async (t) => {
  const facts = await host(t)
  const other = await temporary(t, 'not-dshproxy')
  await fs.mkdir(path.join(other, 'src', 'video'), { recursive: true })
  await fs.writeFile(path.join(other, 'package.json'), JSON.stringify({ name: 'something-else' }))
  await fs.writeFile(path.join(other, 'src', 'video', 'command.js'), `require('node:fs').writeFileSync(require('node:path').join(__dirname, 'loaded'), '1'); exports.run = async () => {};`)
  await assert.rejects(tools({ root: other }, facts.host).run('video_options', {}), /not a DSHProxy/)
  await assert.rejects(fs.access(path.join(other, 'src', 'video', 'loaded')))
  assert.throws(() => build({ root: 'relative/path' }, facts.host), /absolute path/)
  assert.throws(() => build({ rootDir: realRoot }, facts.host), /unknown setting/)
  assert.throws(() => build({ timeoutMs: 5 }, facts.host), /timeoutMs/)
})

test('inside the Harness runtime a real Node is looked up and the runtime itself is never used', async (t) => {
  const facts = await host(t)
  const bin = await temporary(t, 'node-bin')
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  await fs.writeFile(path.join(bin, name), '')
  const electron = { ...facts.host, execPath: path.join(bin, 'DeepSeek Harness.exe'), versions: { node: '24.0.0', electron: '40.0.0' } }
  const found = resolveSettings({}, { ...electron, env: { ...electron.env, PATH: bin, ProgramFiles: undefined } })
  assert.equal(found.node, path.join(bin, name))
  const empty = await temporary(t, 'empty-bin')
  const missing = { ...electron, env: { ...electron.env, PATH: empty, ProgramFiles: empty } }
  assert.equal(resolveSettings({}, missing).node, null)
  const watch = spy()
  await assert.rejects(tools({ root: realRoot }, missing, watch).run('video_options', {}), /Node\.js 22 or later was not found/)
  assert.equal(watch.starts.length, 0)
  assert.equal(resolveSettings({}, facts.host).root, realRoot)
})

test('the package is a bundle whose patch inserts this plugin and nothing else', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(bundleDir, 'package.json'), 'utf8'))
  const patch = await fs.readFile(path.join(bundleDir, manifest.dsh.bundle.patch), 'utf8')
  assert.equal(manifest.exports['.'], './index.js')
  assert.deepEqual(patch.match(/name: .+/g), [`name: '${manifest.name}'`])
  const locale = JSON.parse(await fs.readFile(path.join(bundleDir, 'locale', 'en.json'), 'utf8'))
  assert.ok(locale.meta.title && locale.meta.description && locale.meta.detail === undefined)
  for (const file of ['index.js', 'runner.cjs', 'icon.svg', 'README.md']) await fs.access(path.join(bundleDir, file))
})
