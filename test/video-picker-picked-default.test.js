'use strict';
// Decision 0008. DeepSeek Harness saves the model a person picks in a chat as
// the default model of the profile, so a picked video entry is always named
// there. That one place does not stop a purchase; every other place that names
// the video route still does. A subagent says what it is in the Harness's own
// session reminder, and gets neither a quote nor a purchase.
//
// Everything runs against fakes: no provider, no network, no credential.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = require('../src/dsh/profile');
const { classify } = require('../src/video/picker/classify');
const { ENTRY, PROMPT, world, ask, request, quoted, confirming } = require('./video-picker-world');

const VIDEO = 'dshproxy-video';
const DEFAULT_ON_VIDEO = `- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: ${VIDEO}\n    model: ${ENTRY}\n`;
const ROUTES = `- id: llm-pi-ai\n  config:\n    providers:\n      ${VIDEO}:\n        models:\n          - id: ${ENTRY}\n`;
const ALLOWED = `- id: subagent-model-selection-settings\n  config:\n    allowedModels:\n      - { provider: ${VIDEO}, model: ${ENTRY} }\n`;

// A DeepSeek Harness home with one profile made of the given text.
function harnessHome(t, text) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-picked-default-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), text);
  return home;
}

const calls = (w) => ({ quote: w.calls.quote.length, submit: w.calls.submit.length });

test('a video entry picked in a chat, which the Harness saves as the default model, does not stop the purchase', async (t) => {
  const home = harnessHome(t, ROUTES + DEFAULT_ON_VIDEO);
  assert.equal(profile.videoExposed(home), false);

  // The picker with the real guard reading that profile, as the gateway wires it.
  const w = world(t);
  w.exposed = profile.videoExposed(home);
  const quote = await quoted(w);
  assert.match(await ask(w, confirming(quote)), /^Buying one clip: /);
  assert.deepEqual(calls(w), { quote: 1, submit: 1 });
});

test('the video route named for agents stops the purchase, with or without a picked default', async (t) => {
  for (const text of [ROUTES + ALLOWED, ROUTES + DEFAULT_ON_VIDEO + ALLOWED]) {
    const home = harnessHome(t, text);
    assert.equal(profile.videoExposed(home), true);
    const w = world(t);
    w.exposed = profile.videoExposed(home);
    const quote = await quoted(w);
    assert.match(await ask(w, confirming(quote)), /^Nothing was bought: a DeepSeek Harness profile lets agents pick the paid video route\./);
    assert.deepEqual(calls(w), { quote: 1, submit: 0 });
  }
});

test('only the default model itself is let through: the route named anywhere else in that entry still counts', (t) => {
  const deeper = `- id: agent-default-model\n  config:\n    provider: dshproxy-lanes\n    model: lane-main\n    fallback: { provider: ${VIDEO}, model: ${ENTRY} }\n`;
  assert.equal(profile.videoExposed(harnessHome(t, ROUTES + deeper)), true);
  const list = `- id: agent-default-model\n  config:\n    - { provider: ${VIDEO}, model: ${ENTRY} }\n`;
  assert.equal(profile.videoExposed(harnessHome(t, ROUTES + list)), true);
});

// What the Harness puts in a subagent's conversation (dsh-tool-subagent,
// `subagent:identity`), and in a root session's.
const reminder = (identity) => `<system-reminder>\nThe following information describes your current session:\n\nCurrent working directory: "C:\\\\work\\\\project".\n\n${identity}\n</system-reminder>`;
const CHILD = reminder('You are a subagent delegated by agent "lead".\nYour name is "agent-3".\nThe root agent of your collaboration tree is "lead".');
const ROOT = reminder('You are the root agent. Your name is "lead".');
const SENTENCE = 'This entry makes a video from a prompt a person types. A subagent gets no quote and buys nothing here. Nothing was quoted or bought.';

test('a subagent that lands on a video entry gets one sentence: no quote is asked for and nothing is bought', async (t) => {
  const w = world(t);
  const quote = await quoted(w);
  const before = calls(w);
  const bodies = [
    // Its delegated prompt, in either order with the reminder.
    request(ENTRY, [['user', CHILD], ['user', PROMPT]]),
    request(ENTRY, [['user', PROMPT], ['user', CHILD]]),
    // A bare `yes` after a quote, in a conversation that began as a subagent's.
    request(ENTRY, [['user', CHILD], ...quote.turns, ['user', 'yes']]),
    // A later reminder that replaces the first does not undo it.
    request(ENTRY, [['user', CHILD], ...quote.turns, ['user', ROOT], ['user', 'yes']])
  ];
  for (const body of bodies) {
    assert.equal(classify(body).kind, 'delegated');
    assert.equal(await ask(w, body), SENTENCE);
  }
  assert.deepEqual(calls(w), before);
});

test('a root session, and a person who only quotes the subagent wording, are answered as before', async (t) => {
  const w = world(t);
  const typed = `${PROMPT}. A sign reads: You are a subagent delegated by agent "lead".`;
  assert.equal(classify(request(ENTRY, [['user', ROOT], ['user', PROMPT]])).kind, 'prompt');
  assert.equal(classify(request(ENTRY, [['user', typed]])).prompt, typed);
  // A report an agent wrote that names the wording is not the Harness's reminder.
  const report = `Background subagent agent-10 finished. Its closing message: Child: \`You are a subagent delegated by agent \${JSON.stringify(names.parent)}.\``;
  assert.equal(classify(request(ENTRY, [['user', report], ['assistant', 'Noted.'], ['user', PROMPT]])).kind, 'prompt');

  const quote = await quoted(w, PROMPT, ENTRY, [['user', ROOT]]);
  assert.match(await ask(w, confirming(quote)), /^Buying one clip: /);
});

test('an entry called agent-default-model that sits inside another entry is not the default model', (t) => {
  const inTool = `- id: tool-reviewer\n  config:\n    agentOptions:\n      id: agent-default-model\n      config: { provider: ${VIDEO}, model: ${ENTRY} }\n`;
  assert.equal(profile.videoExposed(harnessHome(t, ROUTES + inTool)), true);
  const inList = `- id: subagent-model-selection-settings\n  config:\n    allowedModels:\n      - { id: agent-default-model, config: { provider: ${VIDEO}, model: ${ENTRY} } }\n`;
  assert.equal(profile.videoExposed(harnessHome(t, ROUTES + inList)), true);
  // The pair of the real default, reused by a tool row: the tool row counts.
  const shared = `- id: agent-default-model\n  config: &picked { provider: ${VIDEO}, model: ${ENTRY} }\n- id: tool-clips\n  config:\n    agentOptions: *picked\n`;
  assert.equal(profile.videoExposed(harnessHome(t, ROUTES + shared)), true);
  // The real default written as a reference to a pair kept in the provider list is still the default.
  const referred = `${ROUTES}            note: &kept { provider: ${VIDEO}, model: ${ENTRY} }\n- id: agent-default-model\n  config: *kept\n`;
  assert.equal(profile.videoExposed(harnessHome(t, referred)), false);
});

test('a subagent is recognised when its reminder is split over text blocks or has text before it', () => {
  const user = (...texts) => ({ role: 'user', content: texts.map((text) => ({ type: 'text', text })) });
  const cut = CHILD.indexOf('You are a subagent');
  assert.equal(classify({ model: ENTRY, messages: [user(CHILD.slice(0, cut), CHILD.slice(cut), PROMPT)] }).kind, 'delegated');
  assert.equal(classify({ model: ENTRY, messages: [user(`Context follows.\n${CHILD}`), user(PROMPT)] }).kind, 'delegated');
  assert.equal(classify({ model: ENTRY, messages: [{ role: 'user', content: `${CHILD.replace(/\n/g, '\r\n')}` }, user(PROMPT)] }).kind, 'delegated');
});

test('a report that names the reminder tag and quotes the subagent wording is not a subagent', () => {
  // As a reviewing agent wrote it, delivered to a person's session in the user role.
  const report = 'Delegated detection requires the same unit to both `trimStart().startsWith(\'<system-reminder>\')` and `includes(\'You are a subagent delegated by agent "\')`.';
  assert.equal(classify(request(ENTRY, [['user', report], ['assistant', 'Noted.'], ['user', ROOT], ['user', PROMPT]])).kind, 'prompt');
  // The tag on a line of its own, without the reminder's first line.
  const example = 'Example of the format:\n<system-reminder>\nsome session facts\nYou are a subagent delegated by agent "lead".';
  assert.equal(classify(request(ENTRY, [['user', example], ['assistant', 'Noted.'], ['user', PROMPT]])).kind, 'prompt');
  // A root reminder and, in the same message after it has closed, the wording.
  const typed = `${PROMPT}. He says: You are a subagent delegated by agent "lead".`;
  assert.equal(classify({ model: ENTRY, messages: [{ role: 'user', content: [{ type: 'text', text: ROOT }, { type: 'text', text: typed }] }] }).prompt, typed);
  // A root reminder followed, in a later message, by the wording.
  assert.equal(classify(request(ENTRY, [['user', ROOT], ['user', `${PROMPT}. He says: You are a subagent delegated by agent "lead".`]])).kind, 'prompt');
});
