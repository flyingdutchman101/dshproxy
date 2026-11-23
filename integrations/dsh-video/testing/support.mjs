// Shared by the test files: temporary folders, a host environment holding
// secrets the child must never receive, a spy on child processes, and a
// stand-in DSHProxy folder with canned answers. Nothing here uses a network,
// an account or the real profile.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from '../index.js'

// On macOS: a throwaway keychain for these tests and their children, never a
// login Keychain (docs/work/0014-macos-port).
createRequire(import.meta.url)('../../../test/support/keychain.js')
const MAC = process.platform === 'darwin'

export const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const realRoot = path.resolve(bundleDir, '..', '..')
export const runner = path.join(bundleDir, 'runner.cjs')
export const SECRET = 'synthetic-secret-value-9f2c'
export const PROMPT = 'A paper boat crossing a rain puddle, slow dolly-in'
export const ALLOWED_ENV = MAC ? ['HOME', 'TMPDIR', 'DSHPROXY_KEYCHAIN', 'DSHPROXY_HOME'] : ['SYSTEMROOT', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE', 'DSHPROXY_HOME']
// On Windows, Node copies these from the parent into every child whatever
// environment was asked for. They name the machine and user, not credentials.
export const ADDED_BY_NODE_ON_WINDOWS = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'WINDIR']
// On macOS, the system adds this one to every process: the user's text
// encoding, no credential.
export const ADDED_BY_MACOS = ['__CF_USER_TEXT_ENCODING']
// The variables a child is started with on this system, for a profile folder.
export const systemEnv = (profile) => (MAC
  ? { HOME: profile, TMPDIR: profile, DSHPROXY_KEYCHAIN: process.env.DSHPROXY_KEYCHAIN }
  : { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: profile, USERPROFILE: profile, TEMP: profile, TMP: profile })

export async function temporary(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `dsh-video-${label}-`))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

// A host environment that holds secrets the child must never receive.
export async function host(t, extra = {}) {
  const profile = await temporary(t, 'profile')
  const home = await temporary(t, 'home')
  return {
    home,
    profile,
    host: {
      bundleDir,
      execPath: process.execPath,
      versions: { node: process.versions.node },
      platform: process.platform,
      env: {
        ...systemEnv(profile),
        PATH: process.env.PATH,
        DSHPROXY_HOME: home,
        VIDEOROUTER_API_KEY: SECRET,
        KOVAPI_API_KEY: SECRET,
        CALLIRRA_API_KEY: SECRET,
        KREA_ACCESS_TOKEN: SECRET,
        ...extra,
      },
    },
  }
}

export async function saveSettings(home, models) {
  await fs.writeFile(path.join(home, 'video-settings.json'), JSON.stringify({ models }))
}

// Records what the bundle hands to the operating system for each child.
export function spy() {
  const starts = []
  const spawnImpl = (file, args, options) => {
    const child = spawn(file, args, options)
    const record = { file, args, options, stdin: '' }
    const end = child.stdin.end.bind(child.stdin)
    child.stdin.end = (text) => { record.stdin += text ?? ''; return end(text) }
    starts.push(record)
    return child
  }
  return { starts, spawnImpl }
}

export function tools(config, hostFacts, deps) {
  const list = build(config, hostFacts, deps)
  const byName = Object.fromEntries(list.map((tool) => [tool.name, tool]))
  const run = (name, args, signal = new AbortController().signal) => byName[name].execute(args, { signal })
  return { list, byName, run }
}

// A stand-in DSHProxy folder: the same `run(args, out, options)` seam, canned
// answers, and a log of every call it received.
export async function stubRoot(t, behavior) {
  const root = await temporary(t, 'stub-root')
  await fs.mkdir(path.join(root, 'src', 'video'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'dshproxy' }))
  await fs.writeFile(path.join(root, 'behavior.json'), JSON.stringify(behavior))
  await fs.writeFile(path.join(root, 'src', 'video', 'command.js'), `
    const fs = require('node:fs'), path = require('node:path');
    const dir = path.join(__dirname, '..', '..');
    const behavior = JSON.parse(fs.readFileSync(path.join(dir, 'behavior.json'), 'utf8'));
    exports.run = async (args, out, options) => {
      let fetchBlocked = false, globalFetchBlocked = false;
      try { options.fetchImpl('https://example.invalid'); } catch { fetchBlocked = true; }
      try { globalThis.fetch('https://example.invalid'); } catch { globalFetchBlocked = true; }
      fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, argv: process.argv.slice(2),
        env: process.env, commandEnv: options.env, cwd: process.cwd(), fetchBlocked, globalFetchBlocked }) + '\\n');
      if (args[0] === 'settings') {
        if (behavior.settingsError) throw new Error(behavior.settingsError);
        return out(JSON.stringify(behavior.settings));
      }
      const hang = () => new Promise(() => setInterval(() => {}, 1000));
      const print = (value) => out(typeof value === 'string' ? value : JSON.stringify(value));
      if (args[0] === 'quote' && args.length === 2) {
        if (behavior.catalogError) throw new Error(behavior.catalogError);
        return print(behavior.catalog ?? { model: args[1], route: 'videorouter', resolution: '720p', durationSeconds: 5, aspectRatio: '16:9' });
      }
      if (args[0] === 'quote') {
        if (behavior.hang) await hang();
        if (behavior.quoteError) throw new Error(behavior.quoteError);
        return print(behavior.quote);
      }
      if (args[0] === 'submit') {
        if (behavior.submitHang) await hang();
        if (behavior.submitCrash) process.exit(3);
        if (behavior.submitError) throw new Error(behavior.submitError);
        return print(behavior.submit);
      }
      if (args[0] === 'status') {
        if (behavior.statusError) throw new Error(behavior.statusError);
        return print(behavior.status);
      }
      throw new Error('unexpected command');
    };`)
  const calls = async () => {
    const text = await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8').catch(() => '')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }
  const change = (next) => fs.writeFile(path.join(root, 'behavior.json'), JSON.stringify({ ...behavior, ...next }))
  return { root, calls, change }
}

export const settingsRows = (rows) => ({ models: rows.map(([model, enabled, route, routes]) => ({ model, enabled, route, routes })) })
export const kreaEnabled = settingsRows([['wan-3.0', true, 'krea', ['videorouter', 'kovapi', 'krea']]])
export const preflight = { model: 'wan-3.0', route: 'krea', mode: 'preflight', compute_units: 3.5, is_estimated: false,
  available_compute_units: 120, affordable: true, currency: 'workspace_compute_units', budgetFlag: '--max-units' }
