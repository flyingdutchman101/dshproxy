// DeepSeek Harness Host plugin: offers DSHProxy's video models as agent tools.
// video_options and video_quote never charge. video_submit starts one paid job
// on the Krea workspace route after the user approved that job; video_status
// looks one job up.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridge } from './lib/bridge.js'
import { resolveSettings } from './lib/config.js'
import { createSubmitTools } from './lib/submit.js'
import { createTools } from './lib/tools.js'
import { createForeplayTools } from './lib/foreplay.js'
import { foreplayAllowed, foreplayHome } from './lib/foreplay-policy.js'

export const name = 'dshproxy-video'
export const inject = ['tools']

function hostFacts() {
  return {
    // Resolved through links, so a linked installation still finds DSHProxy.
    bundleDir: fs.realpathSync(path.dirname(fileURLToPath(import.meta.url))),
    execPath: process.execPath,
    versions: process.versions,
    platform: process.platform,
    env: process.env,
  }
}

// `deps.spawnImpl` replaces the process launcher in tests; `deps.questions`
// supplies the service that asks the user.
export function build(config, host = hostFacts(), deps = {}) {
  const settings = resolveSettings(config, host)
  const home = foreplayHome(settings, host)
  const allowed = () => foreplayAllowed(home, config?.foreplayEnabled === true)
  const call = createBridge(settings, deps)
  const tools = [...createTools(call), ...createSubmitTools(call, deps)]
  if (allowed()) {
    const env = { ...settings.env, DSHPROXY_HOME: home, DSHPROXY_FOREPLAY_LEGACY_OPT_IN: config?.foreplayEnabled === true ? '1' : '0' }
    const research = createBridge({ ...settings, env }, deps)
    tools.push(...createForeplayTools(research, { ...deps, allowed }))
  }
  return tools
}

// The plugin owns its registrations as one effect: unloading removes both
// tools, and a registration that fails removes the ones made before it. The
// installed tool registry already ties each registration to the calling
// plugin; this does not rely on that, and removing a tool twice is harmless.
export function apply(ctx, config) {
  // Looked up when a job is requested, so the quote tools load in a deployment
  // that has no way to ask the user; video_submit then refuses.
  const tools = build(config, hostFacts(), { questions: () => ctx.get('userQuestions') })
  ctx.effect(() => {
    const registered = []
    const remove = () => { for (const dispose of registered.splice(0).reverse()) dispose() }
    try {
      for (const tool of tools) {
        const dispose = ctx.tools.register(tool)
        if (typeof dispose === 'function') registered.push(dispose)
      }
    } catch (error) {
      remove()
      throw error
    }
    return remove
  })
}
