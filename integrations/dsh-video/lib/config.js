// Turns the plugin row's `config` and the host process facts into the fixed
// launch settings of the child: which Node, which DSHProxy folder, which
// environment. Nothing here comes from a tool call.
import fs from 'node:fs'
import path from 'node:path'

const KEYS = ['root', 'node', 'home', 'timeoutMs']
// The same names DSHProxy hands to its own Krea helper. Provider keys, tokens
// and every other variable of the host stay behind.
const ENVIRONMENT = ['SystemRoot', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE']
const DEFAULT_TIMEOUT_MS = 100_000

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`dshproxy-video: "${label}" must be an absolute path.`)
  }
  return path.normalize(value)
}

// The Harness desktop runtime is not Node: started with a script it opens the
// application. Look for node the way the DSHProxy app does, PATH first.
function findNode(env, platform) {
  const name = platform === 'win32' ? 'node.exe' : 'node'
  const folders = String(env.PATH ?? env.Path ?? '').split(path.delimiter).map((part) => part.trim()).filter(Boolean)
  if (platform === 'win32' && env.ProgramFiles) folders.push(path.join(env.ProgramFiles, 'nodejs'))
  for (const folder of folders) {
    const candidate = path.join(folder, name)
    try {
      if (path.isAbsolute(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch {
      // not there
    }
  }
  return null
}

export function resolveSettings(config, host) {
  const given = config ?? {}
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error('dshproxy-video: the settings must be a mapping.')
  const unknown = Object.keys(given).filter((key) => !KEYS.includes(key))
  if (unknown.length) throw new Error(`dshproxy-video: unknown setting "${unknown[0]}". Known: ${KEYS.join(', ')}.`)

  const timeoutMs = given.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new Error('dshproxy-video: "timeoutMs" must be a whole number from 1000 to 120000.')
  }

  const env = {}
  for (const name of ENVIRONMENT) if (typeof host.env[name] === 'string' && host.env[name]) env[name] = host.env[name]
  const home = given.home !== undefined ? absolute(given.home, 'home') : host.env.DSHPROXY_HOME
  if (typeof home === 'string' && home) env.DSHPROXY_HOME = home

  let node
  if (given.node !== undefined) node = absolute(given.node, 'node')
  else node = host.versions.electron ? findNode(host.env, host.platform) : host.execPath

  return {
    // This bundle lives in DSHProxy at integrations/dsh-video.
    root: absolute(given.root ?? path.resolve(host.bundleDir, '..', '..'), 'root'),
    node,
    runner: path.join(host.bundleDir, 'runner.cjs'),
    env,
    timeoutMs,
  }
}
