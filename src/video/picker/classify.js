'use strict';
// Reads a request body (Anthropic messages shape) and says what it is, as far
// as buying is concerned. Pure, and total: whatever the body is, classify()
// returns one of the kinds below and never throws.
//
//   malformed       not a request this route can read
//   attachment      a message after the last assistant turn holds something
//                   that is not text (a tool round, an image, a document)
//   silent          nothing typed after the last assistant turn
//   confirm         exactly one typed reply, a confirming word, directly after
//                   an assistant turn of text only whose last line names a
//                   quote: { quoteId, answer }. Whether that turn really is
//                   the stored quote is checked against the store, not here.
//   stray-confirm   a confirming word that is not such a reply; `afterTurn`
//                   says whether it was the one reply after an assistant turn
//   prompt          anything else: { prompt } is the last typed text, trimmed
//
// Only the rows of the design's table that one purchase per quote needs are
// here. Titles, compaction, goals, schedules, refusals, status questions and
// near-confirmations are told apart in the next slice.
const { ID_PATTERN } = require('./store');

const QUOTE_LINE = new RegExp(`^Quote (${ID_PATTERN})$`);
const CONFIRM = new Set(['yes', 'da', 'confirm', 'potvrdi', 'potvrđujem', 'potvrdujem']);
// Messages DeepSeek Harness adds in the user's role next to the typed one.
const INJECTED = ['<system-reminder>', 'Time sampled while preparing turn '];
const MAX_PROMPT_BYTES = 16000;
// A quote answer is the prompt plus a few lines; anything much longer is not one.
const MAX_ANSWER_LENGTH = 4 * MAX_PROMPT_BYTES;
// Only line breaks and tabs: other control, invisible and text-direction
// characters could make the quote show something else than is sent.
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The form in which a quote answer is hashed, when it is written and when a
// request brings it back.
function normalise(text) {
  return text.normalize('NFC').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

// A whole message that is one confirming word: any letter case, one optional
// final "." or "!". NFC, not NFKC: look-alike letters do not match.
function confirms(text) {
  if (text.length > 64) return false;
  const bare = text.normalize('NFC').trim().replace(/[.!]$/, '').toLowerCase();
  return CONFIRM.has(bare);
}

function injected(text) {
  const start = text.trimStart();
  return INJECTED.some((frame) => start.startsWith(frame));
}

function textBlock(block) {
  return record(block) && block.type === 'text' && typeof block.text === 'string';
}

// The text of an assistant turn made of text only, or null.
function turnText(message) {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  let text = '';
  for (const block of content) {
    if (!textBlock(block)) return null;
    text += block.text;
  }
  return text;
}

function read(body) {
  if (!record(body) || !Array.isArray(body.messages)) return { kind: 'malformed' };
  const { messages } = body;
  let last = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!record(message) || (message.role !== 'user' && message.role !== 'assistant')) return { kind: 'malformed' };
    if (message.role === 'assistant') last = index;
  }

  // Units: a message whose content is a string is one; in a list every text
  // block is one; any other block is a tool round or an attachment.
  const typed = [];
  for (let index = last + 1; index < messages.length; index += 1) {
    const { content } = messages[index];
    const units = typeof content === 'string' ? [content] : null;
    if (units === null) {
      if (!Array.isArray(content)) return { kind: 'malformed' };
      for (const block of content) {
        if (!textBlock(block)) return { kind: 'attachment' };
        if (!injected(block.text)) typed.push(block.text);
      }
    } else if (!injected(content)) typed.push(content);
  }
  if (typed.length === 0) return { kind: 'silent' };

  const reply = typed[typed.length - 1];
  if (!confirms(reply)) return { kind: 'prompt', prompt: reply.trim() };
  if (typed.length !== 1 || last < 0) return { kind: 'stray-confirm', afterTurn: false };
  const text = turnText(messages[last]);
  if (text === null || text.length > MAX_ANSWER_LENGTH) return { kind: 'stray-confirm', afterTurn: true };
  const answer = normalise(text);
  const named = QUOTE_LINE.exec(answer.slice(answer.lastIndexOf('\n') + 1));
  if (named === null) return { kind: 'stray-confirm', afterTurn: true };
  return { kind: 'confirm', quoteId: named[1], answer };
}

function classify(body) {
  try {
    return read(body);
  } catch {
    return { kind: 'malformed' };
  }
}

// Why a typed text cannot be quoted as a prompt, or null. What is shown in a
// quote must be exactly what is sent.
function promptProblem(prompt) {
  if (typeof prompt !== 'string' || prompt === '') return 'empty';
  if (prompt.length > MAX_PROMPT_BYTES || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return 'long';
  if (prompt.startsWith('--')) return 'dashes';
  if (HIDDEN.test(prompt)) return 'hidden';
  return null;
}

module.exports = { classify, normalise, promptProblem, confirms, MAX_PROMPT_BYTES };
