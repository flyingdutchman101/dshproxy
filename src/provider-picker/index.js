'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const settings = require('./settings');
const classify = require('../video/picker/classify');
const { newId, ID_PATTERN } = require('../video/picker/store');
const { runPaid } = require('./foreplay-child');
const TTL = 600000;
const MAX_RECORDS = 100;
const cleanupTimers = new Map();

function create({ home, exposed = () => true, context = {} }) {
  const folder = path.resolve(home, 'provider-picker-requests');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // Paths are restricted to generated IDs inside this exact private directory.
  function cleanup() {
    const names = fs.readdirSync(folder).filter(name => new RegExp(`^${ID_PATTERN}\\.json$`).test(name));
    const live = [];
    for (const name of names) {
      const file = path.join(folder, name);
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Number.isFinite(record.expires) || record.expires <= Date.now()) {
          fs.unlinkSync(file);
          try { fs.unlinkSync(file + '.claimed'); } catch { /* Already absent. */ }
        }
        else live.push({ file, expires: record.expires });
      } catch {
        // Malformed records must not retain plaintext indefinitely.
        try { fs.unlinkSync(file); } catch { /* Fail closed if inaccessible. */ }
      }
    }
    for (const name of fs.readdirSync(folder)) {
      if (!new RegExp(`^${ID_PATTERN}\\.json\\.claimed$`).test(name)) continue;
      const file = path.join(folder, name);
      if (!fs.existsSync(file.slice(0, -8))) {
        try { fs.unlinkSync(file); } catch { /* Another cleanup may have won. */ }
      }
    }
    live.sort((a, b) => a.expires - b.expires);
    while (live.length >= MAX_RECORDS) {
      const file = live.shift().file;
      fs.unlinkSync(file);
      try { fs.unlinkSync(file + '.claimed'); } catch { /* Already absent. */ }
    }
  }
  cleanup();
  if (!cleanupTimers.has(folder)) {
    const timer = setInterval(() => { try { cleanup(); } catch { /* Retry cleanup next interval, never provider work. */ } }, 60000);
    timer.unref();
    cleanupTimers.set(folder, timer);
  }
  return {
    async answer(body, write, options = {}) {
      try {
        cleanup();
        if (options.signal?.aborted) return write('Request cancelled. No request sent.');
        if (!settings.enabled(home) || exposed() !== false || body?.model !== settings.ID) {
          return write('Foreplay picker is disabled or exposed to automation. No request sent.');
        }
        const request = classify.classify(body);
        if ((request.kind === 'confirm' || request.kind === 'refusal') && request.turn) {
          const file = path.join(folder, request.turn.quoteId + '.json');
          let saved;
          try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
          catch { return write('No matching Foreplay request.'); }
          if (saved.used) return write('This request has already been used. No retry made.');
          const assistant = body.messages.findLast(message => message.role === 'assistant');
          const raw = typeof assistant.content === 'string' ? assistant.content : assistant.content.map(block => block.text).join('');
          if (saved.id !== request.turn.quoteId || saved.answer !== raw || saved.model !== body.model || Date.now() >= saved.expires) {
            return write('Confirmation does not match the exact request or has expired.');
          }
          // Synchronous replacement consumes both approvals and declines before any await.
          // Atomic rename is needed for cross-process exclusion: the exclusive claim wins once.
          try { fs.writeFileSync(file + '.claimed', '', { flag: 'wx', mode: 0o600 }); }
          catch { return write('This request has already been used. No retry made.'); }
          fs.writeFileSync(file, JSON.stringify({ used: true, expires: saved.expires }), { mode: 0o600 });
          if (request.kind === 'refusal') return write('Foreplay request declined. No request sent.');
          if (options.signal?.aborted) return write('Request cancelled. No request sent.');
          const result = await (context.runPaid || runPaid)({ home, operation: saved.operation, query: saved.query }, { signal: options.signal, env: context.env });
          if (options.signal?.aborted) return write('Request cancelled. Credits may have been consumed; no retry made.');
          if (!Array.isArray(result?.items)) throw new Error('Invalid result');
          const items = result.items.slice(0, 10).map(item => {
            if (typeof item.label !== 'string' || typeof item.id !== 'string') throw new Error('Invalid item');
            return { label: item.label.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300), id: item.id.slice(0, 512) };
          });
          return write(items.length ? JSON.stringify({ items }) : 'No Foreplay results. No retry made.');
        }
        if (request.kind !== 'prompt' || request.unfit) return write('Type search TEXT or boards yourself; automation and attachments are not supported.');
        const query = request.prompt.startsWith('search ') ? request.prompt.slice(7) : undefined;
        const operation = request.prompt === 'boards' ? 'boards' : 'search';
        if (operation === 'search' && (!query?.trim() || query.length > 1024 || classify.promptProblem(query))) return write('Use search TEXT or boards.');
        const args = operation === 'boards' ? ['boards'] : ['search', '--query', query];
        const id = newId(n => crypto.randomBytes(n));
        const answer = `Foreplay request: ${JSON.stringify(args)}\nSearch costs up to 10 credits; boards costs 1 credit per successful nonempty call. The exact search query is sent to Foreplay. One request, up to 10 results, no pagination or retries. Reply yes to confirm or no to decline within 10 minutes.\nQuote ${id}`;
        fs.writeFileSync(path.join(folder, id + '.json'), JSON.stringify({ id, operation, query, answer, model: body.model, expires: Date.now() + TTL }), { flag: 'wx', mode: 0o600 });
        write(answer);
      } catch {
        write('Foreplay request could not complete. No retry made; credits may have been consumed.');
      }
    }
  };
}
module.exports = { create };
