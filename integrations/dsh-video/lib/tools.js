// The two read-only model-facing tools, video_options and video_quote, and the
// helpers they share with the paid tool in submit.js. They are plain tool
// definitions (name, description, JSON Schema parameters, output, execute), so
// this file checks its own arguments and needs nothing from the Harness to load.
import { BridgeError } from './bridge.js'

export const WORKSPACE_ROUTE = 'krea'
export const MAX_PROMPT_BYTES = 16_000
export const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/
export const ROUTE = /^[a-z][a-z0-9-]{0,63}$/
const UNITS = { USD: 'USD', credits: 'plan_credits' }

const NO_QUOTE = 'No quote was obtained.'
// Everything a failed call can say. Upstream wording never reaches the model.
export const MESSAGES = {
  NODE_MISSING: 'Node.js 22 or later was not found for DSHProxy. The user can set "node" in this plugin\'s settings.',
  RUNTIME: 'The executable configured for DSHProxy is not Node.js 22 or later.',
  ROOT_INVALID: 'The folder configured for this plugin is not a DSHProxy folder.',
  SETTINGS_UNAVAILABLE: 'The DSHProxy video settings could not be read. The user can check them in the DSHProxy app.',
  NOT_OFFERED: 'That model is not enabled on that route in DSHProxy. Call video_options for the current list.',
  SIGN_IN_REQUIRED: `The Krea workspace is not signed in, or its sign-in expired. Only the user can sign in, as a separate step outside this tool. ${NO_QUOTE}`,
  WORKSPACE_REFUSED: `Krea did not accept this exact preset for the model in this workspace. ${NO_QUOTE}`,
  WORKSPACE_UNVERIFIED: `Krea did not return a verifiable preflight; do not assume a price. ${NO_QUOTE}`,
  BAD_REQUEST: `DSHProxy did not accept the request. ${NO_QUOTE}`,
  TIMEOUT: `The request timed out. ${NO_QUOTE}`,
  TIMEOUT_AFTER_SEND: `The request timed out. ${NO_QUOTE} The prompt may already have been sent to Krea. Nothing was generated or charged.`,
  FAILED: `The DSHProxy video quote failed. ${NO_QUOTE}`,
}

const ESTIMATE_NOTE = 'Dated published estimate for one clip, not a live price and not a charge. No provider was contacted and the prompt was not sent. Nothing was generated.'
const PREFLIGHT_NOTE = 'Workspace preflight in compute units, not US dollars and not a charge. The prompt was sent to Krea to obtain it. The final debit can differ. Nothing was generated.'
const OPTIONS_NOTE = 'Models the user enabled in DSHProxy, each on the one billing route chosen for it. video_quote never charges. video_submit works on the krea route only and sends nothing until the user approves that one job; no tool here can sign in.'

export const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export const only = (value, keys) => record(value) && Object.keys(value).every((key) => keys.includes(key))
const amount = (value, least) => typeof value === 'number' && Number.isFinite(value) && (least === 'positive' ? value > 0 : value >= 0)

// Runs one read-only request and turns a failure into its fixed wording.
export async function relay(call, request, signal) {
  try {
    return await call(request, signal)
  } catch (error) {
    if (error instanceof BridgeError) {
      const code = error.code === 'TIMEOUT' && request.route === WORKSPACE_ROUTE ? 'TIMEOUT_AFTER_SEND' : error.code
      throw new Error(MESSAGES[code] ?? MESSAGES.FAILED)
    }
    throw error
  }
}

function unverified() {
  return new Error(MESSAGES.WORKSPACE_UNVERIFIED)
}

// Each field is checked and copied by name. A missing or malformed amount is a
// refusal, never a zero; fields this file does not name are left behind.
// The clip a quote is for, or null when any part of it is missing or malformed.
function clipPreset(data) {
  if (!record(data)) return null
  const preset = { durationSeconds: data.durationSeconds, aspectRatio: data.aspectRatio, resolution: data.resolution, input: 'text' }
  return Number.isInteger(preset.durationSeconds) && preset.durationSeconds >= 1 && preset.durationSeconds <= 600
    && typeof preset.aspectRatio === 'string' && /^\d{1,2}:\d{1,2}$/.test(preset.aspectRatio)
    && typeof preset.resolution === 'string' && (/^\d{3,4}p$/.test(preset.resolution) || preset.resolution === 'fixed tier (resolution unspecified)') ? preset : null
}

function estimate(data, model, route) {
  const unit = UNITS[data.currency]
  const preset = clipPreset(data)
  if (data.model !== model || data.route !== route || !unit || preset === null
      || !amount(data.amount, 'positive') || !amount(data.estimatedUsd, 'positive')
      || !['published', 'effective'].includes(data.priceBasis)
      || typeof data.verifiedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.verifiedOn)
      || (data.assumption !== undefined && (typeof data.assumption !== 'string' || data.assumption.length > 300))
      || !Array.isArray(data.sourceUrls) || data.sourceUrls.length > 8
      || !data.sourceUrls.every((url) => typeof url === 'string' && url.length <= 300 && /^https:\/\/[^\s"<>\\]+$/.test(url))) {
    throw new Error(MESSAGES.FAILED)
  }
  return {
    model, route, kind: 'published-estimate', amount: data.amount, unit, estimatedUsd: data.estimatedUsd,
    priceBasis: data.priceBasis, ...(data.assumption === undefined ? {} : { assumption: data.assumption }),
    preset, estimateDate: data.verifiedOn, sources: [...data.sourceUrls],
    contactedProvider: false, promptSent: false, note: ESTIMATE_NOTE,
  }
}

export function preflight(data, model) {
  const preset = clipPreset(data.preset)
  if (preset === null || data.model !== model || data.route !== WORKSPACE_ROUTE || data.mode !== 'preflight'
      || data.currency !== 'workspace_compute_units' || !amount(data.compute_units)
      || typeof data.is_estimated !== 'boolean' || typeof data.affordable !== 'boolean') throw unverified()
  return {
    model, route: WORKSPACE_ROUTE, kind: 'workspace-preflight', amount: data.compute_units, unit: 'workspace_compute_units',
    isEstimated: data.is_estimated, affordable: data.affordable, preset,
    contactedProvider: true, promptSent: true, note: PREFLIGHT_NOTE,
  }
}

function quoteArguments(args) {
  const fail = () => new Error('video_quote takes "model" and "route" exactly as video_options returned them, and for the krea route a "prompt" of at most 16,000 bytes that does not start with "--".')
  if (!only(args, ['model', 'route', 'prompt']) || typeof args.model !== 'string' || !MODEL.test(args.model)
      || typeof args.route !== 'string' || !ROUTE.test(args.route)) throw fail()
  if (args.prompt !== undefined && typeof args.prompt !== 'string') throw fail()
  if (args.route !== WORKSPACE_ROUTE) return { op: 'quote', model: args.model, route: args.route }
  const prompt = args.prompt
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.startsWith('--') || prompt.includes('\0')
      || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw fail()
  return { op: 'quote', model: args.model, route: args.route, prompt }
}

export const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
export const text = { type: 'string' }
export const flag = { type: 'boolean' }

export function createTools(call) {
  const options = {
    name: 'video_options',
    description: 'List the video models the user enabled in DSHProxy, each with the one billing route chosen for it, and whether video_submit can start a job on that route. Reads local settings only and contacts no provider. Video is offered here as an action for the user, not as a chat model.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['models', 'note'],
        properties: {
          models: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['model', 'route', 'quoteSendsPrompt', 'canSubmit'],
              properties: { model: text, route: text, quoteSendsPrompt: flag, canSubmit: flag },
            },
          },
          note: text,
        },
      },
      render,
    },
    async execute(args, exec) {
      if (args !== undefined && !(record(args) && Object.keys(args).length === 0)) throw new Error('video_options takes no arguments.')
      const data = await relay(call, { op: 'options' }, exec?.signal)
      if (!Array.isArray(data.models) || data.models.length > 64
          || !data.models.every((row) => record(row) && typeof row.model === 'string' && MODEL.test(row.model)
            && typeof row.route === 'string' && ROUTE.test(row.route))) throw new Error(MESSAGES.SETTINGS_UNAVAILABLE)
      return {
        models: data.models.map((row) => ({
          model: row.model, route: row.route, quoteSendsPrompt: row.route === WORKSPACE_ROUTE, canSubmit: row.route === WORKSPACE_ROUTE,
        })),
        note: OPTIONS_NOTE,
      }
    },
  }

  const quote = {
    name: 'video_quote',
    description: 'Quote one five-second, 16:9, text-only clip for a model on its configured route; never generates or charges. On an API route this returns a dated published estimate without contacting anyone. On the krea route it sends the prompt off this machine to the user\'s signed-in Krea workspace for a compute-unit preflight, so use that route only when the user asked for this quote. It never starts a sign-in.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['model', 'route'],
      properties: {
        model: { type: 'string', description: 'A model name returned by video_options.' },
        route: { type: 'string', description: 'The route video_options returned for that model. Any other route is refused.' },
        prompt: { type: 'string', description: 'The clip prompt, at most 16,000 bytes. Required for the krea route, where it is sent to Krea. Ignored and not sent for other routes.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['model', 'route', 'kind', 'amount', 'unit', 'contactedProvider', 'promptSent', 'note'],
        properties: {
          model: text,
          route: text,
          kind: { type: 'string', enum: ['published-estimate', 'workspace-preflight'] },
          amount: { type: 'number' },
          unit: { type: 'string', enum: ['USD', 'plan_credits', 'workspace_compute_units'] },
          estimatedUsd: { type: 'number' },
          priceBasis: { type: 'string', enum: ['published', 'effective'] },
          assumption: text,
          preset: {
            type: 'object',
            additionalProperties: false,
            required: ['durationSeconds', 'aspectRatio', 'resolution', 'input'],
            properties: { durationSeconds: { type: 'integer' }, aspectRatio: text, resolution: text, input: text },
          },
          estimateDate: text,
          sources: { type: 'array', items: text },
          isEstimated: flag,
          affordable: flag,
          contactedProvider: flag,
          promptSent: flag,
          note: text,
        },
      },
      render,
    },
    async execute(args, exec) {
      const request = quoteArguments(args)
      const data = await relay(call, request, exec?.signal)
      return request.route === WORKSPACE_ROUTE ? preflight(data, request.model) : estimate(data, request.model, request.route)
    },
  }

  return [options, quote]
}
