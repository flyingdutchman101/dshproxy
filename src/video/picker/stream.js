'use strict';
// The answer of a video entry on the Anthropic messages protocol: plain text
// and nothing else. Either an event stream (`open`), whose text deltas reach
// the application as they are written and keep its idle timer from running
// out, or one whole message (`message`) for a request that asked for no
// stream.
//
// There is never a tool call and never a thinking block. Text is escaped by
// JSON.stringify only, so no text can end an event or start another.
const crypto = require('node:crypto');

// The application counts reported use against the model's context window.
// These figures only need to be small.
const INPUT_TOKENS = 1;
const MAX_OUTPUT_TOKENS = 4096;

function outputTokens(characters) {
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Math.ceil(characters / 4)));
}

function messageId() {
  return `msg_${crypto.randomBytes(12).toString('hex')}`;
}

// A piece of an answer as text. Text stays as it is, a number or true/false is
// written out, and anything else is nothing: a piece is never an object that
// could be mistaken for an event.
function asText(piece) {
  if (typeof piece === 'string') return piece;
  if (typeof piece === 'number' || typeof piece === 'boolean' || typeof piece === 'bigint') return String(piece);
  return '';
}

function modelName(model) {
  return typeof model === 'string' ? model.slice(0, 200) : 'video';
}

function gone(res) {
  return res.destroyed || res.writableEnded || (res.socket ? res.socket.destroyed : false);
}

// Starts the stream on `res`: status 200, the headers, `message_start` and
// `content_block_start`. This is the one step that can throw (when the
// response cannot take headers any more); nothing after it does.
//
// Returns { text(piece), close(), closed }:
//   text(piece)  one `content_block_delta` per piece that has any text. True
//                when it was handed to the connection, false when it was
//                dropped: the client has gone, or the stream is closed.
//   close()      `content_block_stop`, `message_delta` (end_turn) and
//                `message_stop`, then the end of the response. Once.
function open(res, { model } = {}) {
  let closed = false;
  let characters = 0;
  const send = (event, data) => {
    if (gone(res)) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  send('message_start', { type: 'message_start', message: { id: messageId(), type: 'message', role: 'assistant', model: modelName(model),
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: INPUT_TOKENS, output_tokens: 1 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

  return {
    text(piece) {
      if (closed) return false;
      const text = asText(piece);
      if (!text) return false;
      characters += text.length;
      return send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    },
    close() {
      if (closed) return;
      closed = true;
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens(characters) } });
      send('message_stop', { type: 'message_stop' });
      try {
        if (!res.writableEnded && !res.destroyed) res.end();
      } catch {
        // The client has gone; there is nobody left to end the answer for.
      }
    },
    get closed() {
      return closed;
    },
  };
}

// The same answer as one message, for a request that did not ask for a stream.
function message(text, { model } = {}) {
  const content = asText(text);
  return {
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model: modelName(model),
    content: [{ type: 'text', text: content }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: INPUT_TOKENS, output_tokens: outputTokens(content.length) },
  };
}

module.exports = { open, message, asText };
