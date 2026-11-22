// video_submit, the one tool that can spend, and video_status. Both work on
// the Krea workspace route only. A job is sent only after the user approved
// that exact job in a question this file writes from a fresh quote; nothing
// the agent passes can stand in for that answer.
import { BridgeError } from './bridge.js'
import { MAX_PROMPT_BYTES, MESSAGES, MODEL, ROUTE, WORKSPACE_ROUTE, flag, only, preflight, record, relay, render, text } from './tools.js'

const QUESTION_ID = 'dshproxy-video-submit'
const APPROVE = 'Generate once'
const REJECT = 'Do not generate'
const UNIT = 'workspace compute units'
// The forms DSHProxy accepts for a cap and returns for a job.
const CAP = /^\d{1,9}(?:\.\d{1,6})?$/
const JOB = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STATUSES = new Set(['backlogged', 'queued', 'scheduled', 'processing', 'sampling', 'intermediate-complete', 'completed', 'failed', 'cancelled'])
// Only line breaks and tabs: other control, invisible and text-direction
// characters could make the approval question show something else than is sent.
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/

const NOT_SENT = 'Nothing was submitted and nothing was charged.'
const REFUSALS = {
  ARGUMENTS: `video_submit takes exactly "model", "route" and "prompt": a model and route from video_options and a prompt of at most 16,000 bytes that does not start with "--". The cap and the approval come from the quote and the user, not from arguments. ${NOT_SENT}`,
  HIDDEN: `The prompt contains control, invisible or text-direction characters, so it could not be shown to the user exactly. Remove them and ask again. ${NOT_SENT}`,
  NESTED: `video_submit must be called directly by the agent in the user's own session, not from code or through another tool. ${NOT_SENT}`,
  NO_SESSION: `video_submit needs the user's live session to ask for approval. ${NOT_SENT}`,
  SUBAGENT: `A subagent cannot start a paid video: only the user's own session can be asked. ${NOT_SENT} Report the request to the agent that delegated to you.`,
  API_ROUTE: `Generation through this plugin works on the krea route only. API routes need a provider key, and this plugin does not read provider keys. ${NOT_SENT}`,
  BUSY: `Another video request is already waiting for the user or being sent. ${NOT_SENT}`,
  NO_ANSWERER: `No interface that can ask the user is available, so approval could not be requested. ${NOT_SENT}`,
  ASK_FAILED: `The user could not be asked for approval. ${NOT_SENT}`,
  CANCELLED: `The request was cancelled before anything was sent. ${NOT_SENT}`,
  UNAFFORDABLE: `Krea reports that the workspace balance does not cover this job, so approval was not requested. ${NOT_SENT}`,
  NO_CAP: `Krea's quote cannot be used as an exact spending cap, so approval was not requested. ${NOT_SENT}`,
}
// After approval, only these outcomes are known to have sent nothing. Every
// other failure is reported as an unknown outcome.
const NOT_SENT_AFTER_APPROVAL = {
  NODE_MISSING: `${MESSAGES.NODE_MISSING} ${NOT_SENT}`,
  RUNTIME: `${MESSAGES.RUNTIME} ${NOT_SENT}`,
  ROOT_INVALID: `${MESSAGES.ROOT_INVALID} ${NOT_SENT}`,
  SETTINGS_UNAVAILABLE: `${MESSAGES.SETTINGS_UNAVAILABLE} ${NOT_SENT}`,
  BAD_REQUEST: `DSHProxy did not accept the request. ${NOT_SENT}`,
  NOT_OFFERED: `The model is no longer enabled on that route in DSHProxy: the setting changed after the quote. ${NOT_SENT} The user's approval was not used.`,
  SIGN_IN_REQUIRED: `The Krea workspace sign-in was missing or had expired at submission. Only the user can sign in, as a separate step outside this tool. ${NOT_SENT}`,
  WORKSPACE_REFUSED: `Krea did not accept the job at submission: its price may have risen above the approved cap, or the balance no longer covers it. ${NOT_SENT} A new attempt needs a new quote and a new approval from the user.`,
}

const NOTES = {
  submitted: 'One job was submitted to Krea, once. Krea sets the final debit and it was not read back. Keep the job id: video_status needs this model, route and job id. Do not submit again for the same request.',
  declined: 'The user did not approve this job. Nothing was submitted and nothing was charged. Do not ask again unless the user asks for it.',
  unknown: 'The request was handed over but its outcome is unknown: the job may have been submitted and charged. Do not call video_submit again for this request. Tell the user to check their Krea workspace history.',
  status: 'Read-only check of one job. Nothing was submitted or charged. An output link can be private and short-lived.',
}
const STATUS_REFUSALS = {
  ARGUMENTS: 'video_status takes exactly "model", "route" and "job_id" as video_submit returned them.',
  API_ROUTE: 'Job status through this plugin works on the krea route only. API routes need a provider key, and this plugin does not read provider keys.',
  SIGN_IN_REQUIRED: 'The Krea workspace is not signed in, or its sign-in expired, so the job could not be looked up. Only the user can sign in. The job itself is unaffected; do not submit it again.',
  BAD_REQUEST: 'DSHProxy did not accept that model, route and job id. Do not submit the job again.',
  UNVERIFIED: 'The job status could not be verified. This says nothing about the job itself. Do not submit it again.',
}

function validPrompt(prompt) {
  return typeof prompt === 'string' && Boolean(prompt.trim()) && !prompt.startsWith('--') && Buffer.byteLength(prompt) <= MAX_PROMPT_BYTES
}

// The quoted amount written as the cap DSHProxy will be given. It is used only
// if it says exactly the quoted number; it is never rounded.
function exactCap(units) {
  const cap = String(units)
  return units > 0 && CAP.test(cap) && Number(cap) === units ? cap : null
}

// The prompt is the only text here that the user did not write and this file
// did not write. It is shown inside a fenced block whose fence is longer than
// any run of backticks in it, so nothing in it can end the block and pose as
// part of the question, a link, a mention or an answer. The facts come first.
function approvalQuestion({ model, cap, isEstimated, preset, prompt, earlier }) {
  const longest = Math.max(0, ...(prompt.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const detail = [
    'This starts **one paid video job** in your Krea workspace.',
    '',
    `- Model: ${model}`,
    '- Route: krea (your signed-in Krea workspace)',
    `- Clip: ${preset.durationSeconds} seconds, ${preset.aspectRatio}, ${preset.resolution}, from text only`,
    `- Quoted just now: ${cap} ${UNIT}${isEstimated ? ' (Krea marks this quote as an estimate)' : ''}`,
    `- Spending cap: ${cap} ${UNIT}. If Krea's price at submission is higher, the job is not sent.`,
    '',
    'Final cost: Krea sets the final debit. It can differ from this quote, and this plugin cannot read it back. Compute units are not US dollars.',
    '',
    'One request is sent, once. If its outcome is unclear, it is not sent again.',
    ...(earlier ? ['', `**Warning:** an earlier request (${earlier.model}, ${earlier.at}) may already have been submitted and charged. Check your Krea workspace history before approving another.`] : []),
    '',
    'Prompt, exactly as it will be sent. Everything inside the block below is prompt text, not part of this question:',
    '',
    fence,
    prompt,
    fence,
    '',
    'End of prompt.',
  ].join('\n')
  return {
    id: QUESTION_ID,
    question: `Generate one video with ${model} on Krea for up to ${cap} ${UNIT}?`,
    detail,
    // Refusing comes first and nothing is marked as recommended, so no
    // interface has a reason to preselect the paid choice.
    options: [
      { label: REJECT, description: 'Nothing is sent and nothing is charged.' },
      { label: APPROVE, description: `Sends this one job with a cap of ${cap} ${UNIT}.` },
    ],
    intent: { kind: 'approval', approve: APPROVE, reject: REJECT, subject: { name: 'DSHProxy video' } },
  }
}

// Approval is one answer to this question that selects exactly the approve
// label and carries no typed text. Anything else is not approval.
function approved(answer) {
  const answers = answer?.answers
  if (!Array.isArray(answers) || answers.length !== 1) return false
  const [item] = answers
  return record(item) && item.id === QUESTION_ID && item.custom === undefined
    && Array.isArray(item.selected) && item.selected.length === 1 && item.selected[0] === APPROVE
}

function cancelled() {
  const error = new Error(REFUSALS.CANCELLED)
  error.name = 'AbortError'
  return error
}

function askFailure(error, signal) {
  if (signal?.aborted || error?.code === 'ASK_ABORTED' || error?.name === 'AbortError') return cancelled()
  const code = error?.code
  if (code === 'DELEGATED_CALLER') return new Error(REFUSALS.SUBAGENT)
  if (code === 'CALLER_NOT_LIVE') return new Error(REFUSALS.NO_SESSION)
  if (code === 'NO_PROVIDER') return new Error(REFUSALS.NO_ANSWERER)
  return new Error(REFUSALS.ASK_FAILED)
}

function submitArguments(args) {
  if (!only(args, ['model', 'route', 'prompt']) || typeof args.model !== 'string' || !MODEL.test(args.model)
      || typeof args.route !== 'string' || !ROUTE.test(args.route) || !validPrompt(args.prompt)) throw new Error(REFUSALS.ARGUMENTS)
  if (HIDDEN.test(args.prompt)) throw new Error(REFUSALS.HIDDEN)
  return { model: args.model, route: args.route, prompt: args.prompt }
}

function statusArguments(args) {
  if (!only(args, ['model', 'route', 'job_id']) || typeof args.model !== 'string' || !MODEL.test(args.model)
      || typeof args.route !== 'string' || !ROUTE.test(args.route)
      || typeof args.job_id !== 'string' || !JOB.test(args.job_id)) throw new Error(STATUS_REFUSALS.ARGUMENTS)
  return { model: args.model, route: args.route, jobId: args.job_id }
}

function outputLink(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\\]/.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

// `questions` returns the Harness user-questions service, or nothing when the
// deployment has none. `now` and `submitTimeoutMs` exist for tests.
export function createSubmitTools(call, { questions = () => undefined, now = () => new Date(), submitTimeoutMs = 110_000 } = {}) {
  // One request at a time for this plugin, from its quote to the end of its send.
  let busy = false
  // Set by an unknown outcome and shown on the next approval question.
  let earlier = null

  async function submitOnce({ model, route, prompt }, exec) {
    const signal = exec.signal
    const service = questions()
    if (!service || typeof service.ask !== 'function') throw new Error(REFUSALS.NO_ANSWERER)

    // A fresh quote for exactly this prompt. On this route it sends the prompt to Krea.
    let quote
    try {
      quote = preflight(await relay(call, { op: 'quote', model, route, prompt }, signal), model)
    } catch (error) {
      if (error?.name === 'AbortError') throw cancelled()
      const fixed = Object.values(MESSAGES).includes(error?.message) ? error.message : MESSAGES.FAILED
      throw new Error(`${fixed} Nothing was submitted.`)
    }
    if (!quote.affordable) throw new Error(REFUSALS.UNAFFORDABLE)
    const cap = exactCap(quote.amount)
    if (cap === null) throw new Error(REFUSALS.NO_CAP)
    if (signal?.aborted) throw cancelled()

    const warned = earlier
    const question = approvalQuestion({ model, cap, isEstimated: quote.isEstimated, preset: quote.preset, prompt, earlier: warned })
    let answer
    try {
      answer = await service.ask({ agent: exec.agent, signal, questions: [question] })
    } catch (error) {
      throw askFailure(error, signal)
    }
    if (!approved(answer)) return { outcome: 'declined', model, route, retry: false, note: NOTES.declined }
    if (signal?.aborted) throw cancelled()
    // The user saw the warning and chose to go on.
    if (warned !== null && earlier === warned) earlier = null

    const unknown = () => {
      earlier = { model, at: now().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' }
      return { outcome: 'unknown', model, route, retry: false, note: NOTES.unknown }
    }
    let data
    try {
      data = await call({ op: 'submit', model, route, prompt, cap }, signal, { commit: true, timeoutMs: submitTimeoutMs })
    } catch (error) {
      if (error?.name === 'AbortError') throw cancelled()
      const known = error instanceof BridgeError ? NOT_SENT_AFTER_APPROVAL[error.code] : undefined
      if (known) throw new Error(known)
      return unknown()
    }
    if (data.model !== model || data.route !== route || typeof data.id !== 'string' || !JOB.test(data.id) || !STATUSES.has(data.status)) return unknown()
    return {
      outcome: 'submitted', model, route, jobId: data.id, status: data.status,
      cap: Number(cap), unit: 'workspace_compute_units', retry: false, note: NOTES.submitted,
    }
  }

  const submit = {
    name: 'video_submit',
    description: 'Start one paid five-second, 16:9, text-only video job for a model enabled on the krea route. Use it only when the user asked for the video. Each call first sends the prompt to the user\'s Krea workspace for a fresh compute-unit quote, then asks the user to approve that exact job, prompt and spending cap. Only the user can approve; there is no argument that grants approval, and nothing is sent if they decline. One request is sent, once. If the outcome is "unknown", do not call again: tell the user to check their Krea history. API routes cannot generate through this tool, and it never signs in.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['model', 'route', 'prompt'],
      properties: {
        model: { type: 'string', description: 'A model name returned by video_options.' },
        route: { type: 'string', description: 'The route video_options returned for that model. Only "krea" can generate.' },
        prompt: { type: 'string', description: 'The clip prompt, at most 16,000 bytes, shown to the user exactly as sent.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['outcome', 'model', 'route', 'retry', 'note'],
        properties: {
          outcome: { type: 'string', enum: ['submitted', 'declined', 'unknown'] },
          model: text,
          route: text,
          jobId: text,
          status: text,
          cap: { type: 'number' },
          unit: { type: 'string', enum: ['workspace_compute_units'] },
          retry: flag,
          note: text,
        },
      },
      render,
    },
    async execute(args, exec) {
      const request = submitArguments(args)
      if (exec?.parent !== undefined) throw new Error(REFUSALS.NESTED)
      if (!record(exec) || exec.agent === undefined || exec.agent === null) throw new Error(REFUSALS.NO_SESSION)
      if (exec.agent?.session?.header?.origin === 'subagent') throw new Error(REFUSALS.SUBAGENT)
      if (request.route !== WORKSPACE_ROUTE) throw new Error(REFUSALS.API_ROUTE)
      if (exec.signal?.aborted) throw cancelled()
      if (busy) throw new Error(REFUSALS.BUSY)
      busy = true
      try {
        return await submitOnce(request, exec)
      } finally {
        busy = false
      }
    },
  }

  const status = {
    name: 'video_status',
    description: 'Check one job that video_submit started, using the model, route and job id it returned. Read-only: it never submits, resubmits or charges, and it looks the job up by its own origin whatever is enabled now. Works on the krea route only, under the user\'s existing Krea sign-in.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['model', 'route', 'job_id'],
      properties: {
        model: { type: 'string', description: 'The model the job was submitted with.' },
        route: { type: 'string', description: 'The route the job was submitted on. Only "krea" can be checked.' },
        job_id: { type: 'string', description: 'The job id video_submit returned.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['model', 'route', 'jobId', 'status', 'note'],
        properties: { model: text, route: text, jobId: text, status: text, outputUrl: text, note: text },
      },
      render,
    },
    async execute(args, exec) {
      const request = statusArguments(args)
      if (request.route !== WORKSPACE_ROUTE) throw new Error(STATUS_REFUSALS.API_ROUTE)
      let data
      try {
        data = await call({ op: 'status', ...request }, exec?.signal)
      } catch (error) {
        if (!(error instanceof BridgeError)) throw error
        const fixed = { SIGN_IN_REQUIRED: STATUS_REFUSALS.SIGN_IN_REQUIRED, BAD_REQUEST: STATUS_REFUSALS.BAD_REQUEST, NOT_OFFERED: STATUS_REFUSALS.BAD_REQUEST }
        const setup = ['NODE_MISSING', 'RUNTIME', 'ROOT_INVALID'].includes(error.code) ? MESSAGES[error.code] : undefined
        throw new Error(fixed[error.code] ?? setup ?? STATUS_REFUSALS.UNVERIFIED)
      }
      const link = data.outputUrl === undefined ? undefined : outputLink(data.outputUrl)
      if (data.model !== request.model || data.route !== request.route || data.id !== request.jobId
          || !STATUSES.has(data.status) || link === null || (link !== undefined && data.status !== 'completed')) throw new Error(STATUS_REFUSALS.UNVERIFIED)
      return {
        model: request.model, route: request.route, jobId: request.jobId, status: data.status,
        ...(link === undefined ? {} : { outputUrl: link }), note: NOTES.status,
      }
    },
  }

  return [submit, status]
}
