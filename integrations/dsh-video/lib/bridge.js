// Starts the fixed runner once per request and exchanges one bounded JSON
// message each way over standard input and output. The request never appears
// in a command line or an environment variable.
import { spawn } from 'node:child_process'

const MAX_BYTES = 65_536
// The complete set of codes the runner may answer with; anything else is
// FAILED, or UNCERTAIN for a request that may have spent.
export const CODES = new Set([
  'BAD_REQUEST', 'RUNTIME', 'ROOT_INVALID', 'SETTINGS_UNAVAILABLE', 'NOT_OFFERED',
  'SIGN_IN_REQUIRED', 'WORKSPACE_REFUSED', 'WORKSPACE_UNVERIFIED', 'FAILED',
  'SUBMIT_UNCERTAIN', 'STATUS_UNVERIFIED',
])

export class BridgeError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function aborted(signal) {
  const reason = signal.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const error = new Error('The video request was cancelled.')
  error.name = 'AbortError'
  return error
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function answer(bytes, broken) {
  let message
  try {
    message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw broken()
  }
  if (!record(message) || message.v !== 1) throw broken()
  if (message.ok === true && record(message.data)) return message.data
  if (message.ok === false && CODES.has(message.code)) throw new BridgeError(message.code)
  throw broken()
}

export function createBridge(settings, { spawnImpl = spawn } = {}) {
  // `commit` marks the one request that can spend. Once its child has started,
  // every failure this file cannot explain is UNCERTAIN, never "not sent", and
  // a cancellation no longer stops the child: stopping could not take a send
  // back, and would only lose the answer.
  return function call(request, signal, { commit = false, timeoutMs = settings.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!settings.node) return reject(new BridgeError('NODE_MISSING'))
      if (signal?.aborted) return reject(aborted(signal))
      const input = JSON.stringify({ v: 1, ...request })
      if (Buffer.byteLength(input) > MAX_BYTES) return reject(new BridgeError('BAD_REQUEST'))

      let child
      try {
        child = spawnImpl(settings.node, [settings.runner, settings.root], {
          cwd: settings.root,
          env: { ...settings.env },
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        return reject(new BridgeError('NODE_MISSING'))
      }

      const broken = (code = 'FAILED') => new BridgeError(commit ? 'UNCERTAIN' : code)
      const chunks = []
      let size = 0
      let failure = null
      let settled = false
      let giveUp
      const settle = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        clearTimeout(giveUp)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(value)
      }
      // The call settles once the child is gone, or shortly after if it will not go.
      const stop = (error) => {
        if (failure || settled) return
        failure = error
        child.kill()
        giveUp = setTimeout(() => settle(failure), 3000)
      }
      const onAbort = () => {
        if (commit) settle(new BridgeError('UNCERTAIN'))
        else stop(aborted(signal))
      }
      const deadline = setTimeout(() => stop(broken('TIMEOUT')), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })

      // Without a process id the child never started, so nothing was sent.
      child.once('error', () => settle(failure ?? (child.pid === undefined ? new BridgeError('NODE_MISSING') : broken())))
      child.stdin.on('error', () => stop(broken()))
      child.stdout.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BYTES) stop(broken())
        else chunks.push(chunk)
      })
      // Nothing the child writes to standard error is read or passed on.
      child.stderr.resume()
      child.once('close', (code) => {
        if (failure) return settle(failure)
        if (code !== 0) return settle(broken())
        try {
          settle(null, answer(Buffer.concat(chunks), broken))
        } catch (error) {
          settle(error)
        }
      })
      // The signal may have fired while the child was being started, before the
      // listener above existed. Nothing has been written yet, so the child has
      // no request: it is stopped, and this is a plain cancellation even for a
      // request that can spend.
      if (signal?.aborted) {
        stop(aborted(signal))
        child.stdin.destroy()
        return
      }
      child.stdin.end(input)
    })
  }
}
