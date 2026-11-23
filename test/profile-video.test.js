const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const YAML = require("yaml");

// Nothing here may reach the real DeepSeek Harness home or the real DSHProxy
// data folder. Every call names a throwaway home; the defaults of this process
// point at two more throwaway folders, which must stay empty.
const guards = ["DSH_HOME", "DSHPROXY_HOME"].map((name) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-profile-video-guard-"));
  process.env[name] = folder;
  return folder;
});
test.after(() => {
  try {
    for (const folder of guards) assert.deepEqual(fs.readdirSync(folder), []);
  } finally {
    for (const folder of guards) fs.rmSync(folder, { recursive: true, force: true });
  }
});

const profile = require("../src/dsh/profile");

const ORIGIN = "http://127.0.0.1:8417";
const VIDEO = "dshproxy-video";
const CHAT_ROUTES = ["dshproxy-lanes", "dshproxy-claude", "dshproxy-openai", "dshproxy-compat"];
const LANES = { main: ["gemini-4-carbon-high"] };

const model = (id, api, extra = {}) => ({ id, name: id, api, contextWindow: 200000, maxTokens: 64000, efforts: ["low", "high"], ...extra });
const MODELS = [
  model("lane-main", "lanes"),
  model("claude-fable-5-2", "claude"),
  model("gpt-6-astra", "openai"),
  model("gemini-4-carbon-high", "compat", { efforts: ["high"] }),
  model("mistral/codestral-2508", "compat", { efforts: [] })
];
// A video entry as the caller passes it.
const video = (id, name) => ({ id, name, api: "video", input: ["text"], contextWindow: 1000000, maxTokens: 4096, efforts: [] });
const SEEDANCE = video("seedance-2.5/720p/krea", "Seedance 2.5 - 720p - Krea");
const WAN = video("wan-3.0/1080p/krea", "Wan 3.0 - 1080p - Krea");
const FLUX = video("flux-3/720p/krea", "Flux 3 - 720p - Krea");

function tempHome(t, names = ["desktop"]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-profile-video-"));
  for (const name of names) fs.mkdirSync(path.join(home, "profiles", name), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const patchPath = (home, name = "desktop") => path.join(home, "profiles", name, "cordis.patch.yml");
const read = (home, name) => fs.readFileSync(patchPath(home, name), "utf8");
const entries = (home, name) => YAML.parse(read(home, name));
const providers = (home, name) => entries(home, name).find((item) => item.id === "llm-pi-ai").config.providers;
const ids = (route) => route.models.map((entry) => entry.id);
const defaultModel = (home) => entries(home).find((item) => item.id === "agent-default-model").config;
const offered = (list) => list.map((entry) => ({ id: entry.id, api: entry.api }));
const verify = (home, list) => profile.verify({ origin: ORIGIN, lanes: LANES, models: offered(list), home });
const problems = (home, list) => verify(home, list).profiles[0].problems;

// Every file under a folder, with its bytes.
function snapshot(folder) {
  const found = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const name = path.relative(folder, full);
      if (entry.isDirectory()) {
        found[`${name}${path.sep}`] = "folder";
        walk(full);
      } else found[name] = fs.readFileSync(full).toString("base64");
    }
  };
  walk(folder);
  return found;
}

// A profile with another gateway's route, the subagent model list, a pinned
// tool and a default model, as a user and other programs leave it.
const BEFORE = [
  "# Your patch layer for this dsh profile.",
  "- id: ui-chat",
  "  config:",
  "    transcriptView: standard",
  "# VeryCuteDroidProxy: written by the app.",
  "- id: llm-pi-ai",
  "  name: \"@deepseek-ai/dsh-llm-pi-ai\"",
  "  config:",
  "    providers:",
  "      my-gateway:",
  "        api: openai-completions",
  "        baseURL: https://gateway.example/v1",
  "        models:",
  "          - id: my-model",
  "- id: subagent-model-selection-settings",
  "  name: \"@deepseek-ai/dsh-subagent-model-selection\"",
  "  config:",
  "    enabled: true",
  "    allowedModels:",
  "      - { provider: dshproxy-lanes, model: lane-main }",
  "      - { provider: dshproxy-claude, model: claude-fable-5-2 }",
  "- insert:",
  "    - id: tool-reviewer",
  "      name: \"@deepseek-ai/dsh-tool-subagent\"",
  "      config:",
  "        toolName: reviewer",
  "        agentOptions:",
  "          provider: dshproxy-lanes",
  "          model: lane-main",
  "- id: agent-default-model",
  "  config:",
  "    model: gpt-6-astra",
  ""
].join("\n");

// What the module wrote for BEFORE, MODELS and LANES at commit e21520a, before
// it knew the video route. Produced by running that code; not written by hand.
const AFTER_WITHOUT_VIDEO = [
  "# Your patch layer for this dsh profile.",
  "- id: ui-chat",
  "  config:",
  "    transcriptView: standard",
  "# VeryCuteDroidProxy: written by the app.",
  "- id: llm-pi-ai",
  "  name: \"@deepseek-ai/dsh-llm-pi-ai\"",
  "  config:",
  "    providers:",
  "      my-gateway:",
  "        api: openai-completions",
  "        baseURL: https://gateway.example/v1",
  "        models:",
  "          - id: my-model",
  "      dshproxy-lanes:",
  "        displayName: DSHProxy · Lanes (automatic failover)",
  "        apiKeyEnv: DSHPROXY_API_KEY",
  "        api: anthropic-messages",
  "        baseURL: http://127.0.0.1:8417",
  "        maxRequestImages: 12",
  "        maxRequestImageBytes: 8388608",
  "        models:",
  "          - id: lane-main",
  "            name: lane-main",
  "            input: [ text, image ]",
  "            contextWindow: 200000",
  "            maxTokens: 64000",
  "            reasoningEfforts:",
  "              low: low",
  "              high: high",
  "      dshproxy-claude:",
  "        displayName: DSHProxy · Claude",
  "        apiKeyEnv: DSHPROXY_API_KEY",
  "        api: anthropic-messages",
  "        baseURL: http://127.0.0.1:8417",
  "        maxRequestImages: 12",
  "        maxRequestImageBytes: 8388608",
  "        models:",
  "          - id: claude-fable-5-2",
  "            name: claude-fable-5-2",
  "            input: [ text, image ]",
  "            contextWindow: 200000",
  "            maxTokens: 64000",
  "            reasoningEfforts:",
  "              low: low",
  "              high: high",
  "      dshproxy-openai:",
  "        displayName: DSHProxy · GPT",
  "        apiKeyEnv: DSHPROXY_API_KEY",
  "        api: openai-responses",
  "        baseURL: http://127.0.0.1:8417/v1",
  "        maxRequestImages: 12",
  "        maxRequestImageBytes: 8388608",
  "        models:",
  "          - id: gpt-6-astra",
  "            name: gpt-6-astra",
  "            input: [ text, image ]",
  "            contextWindow: 200000",
  "            maxTokens: 64000",
  "            reasoningEfforts:",
  "              low: low",
  "              high: high",
  "      dshproxy-compat:",
  "        displayName: DSHProxy · Gemini, Kimi and API keys",
  "        apiKeyEnv: DSHPROXY_API_KEY",
  "        api: openai-completions",
  "        baseURL: http://127.0.0.1:8417/v1",
  "        maxRequestImages: 12",
  "        maxRequestImageBytes: 8388608",
  "        models:",
  "          - id: gemini-4-carbon-high",
  "            name: gemini-4-carbon-high",
  "            input: [ text, image ]",
  "            contextWindow: 200000",
  "            maxTokens: 64000",
  "            reasoningEfforts:",
  "              high: high",
  "          - id: mistral/codestral-2508",
  "            name: mistral/codestral-2508",
  "            input: [ text, image ]",
  "            contextWindow: 200000",
  "            maxTokens: 64000",
  "            reasoningEfforts: false",
  "- id: subagent-model-selection-settings",
  "  name: \"@deepseek-ai/dsh-subagent-model-selection\"",
  "  config:",
  "    enabled: true",
  "    allowedModels:",
  "      - { provider: dshproxy-lanes, model: lane-main }",
  "      - { provider: dshproxy-claude, model: claude-fable-5-2 }",
  "- insert:",
  "    - id: tool-reviewer",
  "      name: \"@deepseek-ai/dsh-tool-subagent\"",
  "      config:",
  "        toolName: reviewer",
  "        agentOptions:",
  "          provider: dshproxy-lanes",
  "          model: lane-main",
  "- id: agent-default-model",
  "  name: \"@deepseek-ai/dsh-agent-default-model\"",
  "  config:",
  "    provider: dshproxy-lanes",
  "    model: lane-main",
  ""
].join("\n");

// A home whose one profile is BEFORE with the chat routes and these video
// entries applied.
function applied(t, videoEntries = [SEEDANCE]) {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), BEFORE);
  profile.apply([...MODELS, ...videoEntries], ORIGIN, home, { lanes: LANES });
  return home;
}

// Rewrites the profile through a YAML document, keeping the rest as it is.
function edit(home, change) {
  const doc = YAML.parseDocument(read(home));
  change(doc);
  fs.writeFileSync(patchPath(home), doc.toString({ lineWidth: 0 }));
}

// The places a profile can name a provider and model for agents outside its
// provider list. Each changes an applied profile so that it names the video
// route there. The default model is apart (decision 0008): DeepSeek Harness
// writes the model a person picks in a chat there.
const PAIR = `{ provider: ${VIDEO}, model: ${SEEDANCE.id} }`;
const EXPOSURES = [
  {
    place: "the allowed subagent models",
    where: /subagent-model-selection-settings at config\.allowedModels\[2\]/,
    expose: (home) => fs.writeFileSync(patchPath(home), read(home).replace("      - { provider: dshproxy-claude, model: claude-fable-5-2 }\n", `      - { provider: dshproxy-claude, model: claude-fable-5-2 }\n      - ${PAIR}\n`))
  },
  {
    place: "a tool's agent options",
    where: /tool-reviewer at config\.agentOptions/,
    expose: (home) => fs.writeFileSync(patchPath(home), read(home).replace("          provider: dshproxy-lanes\n          model: lane-main\n", `          provider: ${VIDEO}\n          model: ${SEEDANCE.id}\n`))
  },

  {
    place: "any other entry",
    where: /session-presets at config\.presets\[0\]\.agent/,
    expose: (home) => fs.appendFileSync(patchPath(home), `- id: session-presets\n  config:\n    presets:\n      - name: clips\n        agent: ${PAIR}\n`)
  }
];
const SENTENCE = /the paid video route must not be selectable for agents\. Remove it there\.$/;
const pickAsDefault = (home, id = SEEDANCE.id) => fs.writeFileSync(patchPath(home), read(home).replace("    provider: dshproxy-lanes\n    model: lane-main\n", `    provider: ${VIDEO}\n    model: ${id}\n`));

test("a profile without video entries is written byte for byte as before the video route existed", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), BEFORE);
  const result = profile.apply(MODELS, ORIGIN, home, { lanes: LANES });
  assert.equal(read(home), AFTER_WITHOUT_VIDEO);
  assert.deepEqual(result.profiles[0].routes, { "dshproxy-lanes": 1, "dshproxy-claude": 1, "dshproxy-openai": 1, "dshproxy-compat": 2 });
  // And the same input again is no change at all.
  assert.equal(profile.apply(MODELS, ORIGIN, home, { lanes: LANES }).profiles[0].changed, false);
  assert.equal(read(home), AFTER_WITHOUT_VIDEO);
});

test("the video route is written with its address, its options and the passed entries", (t) => {
  const home = applied(t, [SEEDANCE, WAN]);
  assert.deepEqual(providers(home)[VIDEO], {
    displayName: "DSHProxy · Video (paid)",
    apiKeyEnv: "DSHPROXY_API_KEY",
    api: "anthropic-messages",
    baseURL: "http://127.0.0.1:8417/dshproxy/video",
    maxRequestImages: profile.MAX_REQUEST_IMAGES,
    maxRequestImageBytes: profile.MAX_REQUEST_IMAGE_BYTES,
    streamIdleTimeoutMs: 900000,
    retryPolicy: { mode: "normal", maxRetries: 0 },
    models: [
      { id: "seedance-2.5/720p/krea", name: "Seedance 2.5 - 720p - Krea", input: ["text"], contextWindow: 1000000, maxTokens: 4096, reasoningEfforts: false },
      { id: "wan-3.0/1080p/krea", name: "Wan 3.0 - 1080p - Krea", input: ["text"], contextWindow: 1000000, maxTokens: 4096, reasoningEfforts: false }
    ]
  });
  assert.equal(profile.ROUTES[VIDEO].protocol, "anthropic-messages");
});

test("a freshly applied profile with video entries verifies as ready", (t) => {
  const home = applied(t, [SEEDANCE, WAN]);
  const report = verify(home, [...MODELS, SEEDANCE, WAN]);
  assert.deepEqual(report.profiles[0].problems, []);
  assert.equal(report.ok, true);
  assert.equal(profile.state(ORIGIN, home).applied, true);
});

test("video entries go to the video route only and leave the four chat routes as they were", (t) => {
  const withVideo = applied(t, [SEEDANCE, WAN]);
  const without = applied(t, []);
  const routes = providers(withVideo);
  for (const key of CHAT_ROUTES) {
    assert.deepEqual(routes[key], providers(without)[key], `${key} changed`);
    for (const id of ids(routes[key])) assert.doesNotMatch(id, /krea/);
  }
  // Taking the video route out of the written text leaves the document the
  // unchanged code wrote.
  const text = read(withVideo);
  const start = text.indexOf(`      ${VIDEO}:\n`);
  const end = text.indexOf("- id: subagent-model-selection-settings");
  assert.ok(start > 0 && end > start);
  assert.equal(text.slice(0, start) + text.slice(end), AFTER_WITHOUT_VIDEO);
  assert.deepEqual(profile.apply([...MODELS, SEEDANCE, WAN], ORIGIN, tempHome(t), { lanes: LANES }).profiles[0].routes, { "dshproxy-lanes": 1, "dshproxy-claude": 1, "dshproxy-openai": 1, "dshproxy-compat": 2, [VIDEO]: 2 });
});

test("verify reports entries that were added, removed or reordered, and apply picks each change up", (t) => {
  const home = applied(t, [SEEDANCE, WAN]);

  const added = problems(home, [...MODELS, SEEDANCE, WAN, FLUX]);
  assert.equal(added.length, 1);
  assert.match(added[0], /dshproxy-video/);
  assert.match(added[0], /flux-3\/720p\/krea/);
  assert.doesNotMatch(added[0], /seedance|wan-3/);
  assert.match(added[0], /dshproxy dsh apply/);
  profile.apply([...MODELS, SEEDANCE, WAN, FLUX], ORIGIN, home, { lanes: LANES });
  assert.deepEqual(ids(providers(home)[VIDEO]), [SEEDANCE.id, WAN.id, FLUX.id]);
  assert.deepEqual(problems(home, [...MODELS, SEEDANCE, WAN, FLUX]), []);

  const removed = problems(home, [...MODELS, SEEDANCE, FLUX]);
  assert.equal(removed.length, 1);
  assert.match(removed[0], /wan-3\.0\/1080p\/krea/);
  assert.doesNotMatch(removed[0], /seedance|flux/);
  assert.match(removed[0], /dshproxy dsh apply/);
  profile.apply([...MODELS, SEEDANCE, FLUX], ORIGIN, home, { lanes: LANES });
  assert.deepEqual(ids(providers(home)[VIDEO]), [SEEDANCE.id, FLUX.id]);
  assert.deepEqual(problems(home, [...MODELS, SEEDANCE, FLUX]), []);

  const reordered = problems(home, [...MODELS, FLUX, SEEDANCE]);
  assert.equal(reordered.length, 1);
  assert.match(reordered[0], /dshproxy-video/);
  assert.match(reordered[0], /order/);
  assert.match(reordered[0], /dshproxy dsh apply/);
  profile.apply([...MODELS, FLUX, SEEDANCE], ORIGIN, home, { lanes: LANES });
  assert.deepEqual(ids(providers(home)[VIDEO]), [FLUX.id, SEEDANCE.id]);
  assert.deepEqual(problems(home, [...MODELS, FLUX, SEEDANCE]), []);
});

test("verify reports a profile that lacks the video route while entries are offered, and one that keeps it when none is", (t) => {
  const without = applied(t, []);
  assert.deepEqual(problems(without, MODELS), []);
  const missing = problems(without, [...MODELS, SEEDANCE]);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /dshproxy-video is missing/);
  assert.match(missing[0], /seedance-2\.5\/720p\/krea/);
  assert.match(missing[0], /dshproxy dsh apply/);

  const withVideo = applied(t, [SEEDANCE]);
  const left = problems(withVideo, MODELS);
  assert.equal(left.length, 1);
  assert.match(left[0], /dshproxy-video/);
  assert.match(left[0], /seedance-2\.5\/720p\/krea/);
  assert.match(left[0], /dshproxy dsh apply/);
});

test("a video entry listed on a chat route is reported as not offered there", (t) => {
  const home = applied(t, [SEEDANCE]);
  edit(home, (doc) => doc.addIn([1, "config", "providers", "dshproxy-claude", "models"], doc.createNode({ id: SEEDANCE.id })));
  const stale = problems(home, [...MODELS, SEEDANCE]);
  assert.deepEqual(stale, [`dshproxy-claude lists models that are no longer offered: ${SEEDANCE.id}`]);
});

test("applying without video entries removes the video route and changes nothing else", (t) => {
  const home = applied(t, [SEEDANCE, WAN]);
  assert.ok(providers(home)[VIDEO]);
  const result = profile.apply(MODELS, ORIGIN, home, { lanes: LANES });
  assert.equal(result.profiles[0].changed, true);
  assert.equal(result.profiles[0].routes[VIDEO], undefined);
  assert.equal(read(home), AFTER_WITHOUT_VIDEO);
  assert.deepEqual(problems(home, MODELS), []);
});

test("a video entry that is no longer passed is never kept, whatever is kept on the chat routes", (t) => {
  const home = applied(t, [SEEDANCE, WAN]);
  profile.apply([...MODELS, SEEDANCE], ORIGIN, home, { lanes: LANES, keepModelPrefixes: ["wan-3.0"] });
  assert.deepEqual(ids(providers(home)[VIDEO]), [SEEDANCE.id]);
});

test("video entries alone are not models to apply: nothing is written", (t) => {
  const home = applied(t, []);
  const before = snapshot(home);
  assert.throws(() => profile.apply([SEEDANCE], ORIGIN, home, { lanes: LANES }), /No models are available yet/);
  assert.deepEqual(snapshot(home), before);
});

test("a default model on the video route is repaired to a lane", (t) => {
  const home = applied(t, [SEEDANCE]);
  pickAsDefault(home);
  assert.deepEqual(defaultModel(home), { provider: VIDEO, model: SEEDANCE.id });
  const result = profile.apply([...MODELS, SEEDANCE], ORIGIN, home, { lanes: LANES });
  assert.equal(result.profiles[0].repairedDefault, true);
  assert.equal(result.profiles[0].changed, true);
  assert.deepEqual(defaultModel(home), { provider: "dshproxy-lanes", model: "lane-main" });
  assert.ok(providers(home)[VIDEO], "the route itself stays");
  assert.deepEqual(problems(home, [...MODELS, SEEDANCE]), []);
});

test("a default model that names a video entry on a chat route is repaired too", (t) => {
  const home = applied(t, [SEEDANCE]);
  fs.writeFileSync(patchPath(home), read(home).replace("    provider: dshproxy-lanes\n    model: lane-main\n", `    provider: dshproxy-claude\n    model: ${SEEDANCE.id}\n`));
  assert.deepEqual(problems(home, [...MODELS, SEEDANCE]), [`agent-default-model names model ${SEEDANCE.id}, which is not offered`]);
  const result = profile.apply([...MODELS, SEEDANCE], ORIGIN, home, { lanes: LANES });
  assert.equal(result.profiles[0].repairedDefault, true);
  assert.deepEqual(defaultModel(home), { provider: "dshproxy-lanes", model: "lane-main" });
});

test("applying never names the video route in the allowed models or in a tool", (t) => {
  const home = tempHome(t);
  // Every chat route is already listed for agents.
  const listed = BEFORE.replace(
    "      - { provider: dshproxy-claude, model: claude-fable-5-2 }\n",
    "      - { provider: dshproxy-claude, model: claude-fable-5-2 }\n      - { provider: dshproxy-openai, model: gpt-6-astra }\n      - { provider: dshproxy-compat, model: gemini-4-carbon-high }\n"
  );
  fs.writeFileSync(patchPath(home), listed);
  profile.apply([...MODELS, SEEDANCE, WAN], ORIGIN, home, { lanes: LANES });
  profile.apply([...MODELS, WAN, SEEDANCE, FLUX], ORIGIN, home, { lanes: LANES });

  assert.deepEqual(ids(providers(home)[VIDEO]), [WAN.id, SEEDANCE.id, FLUX.id]);
  const before = YAML.parse(listed);
  const after = entries(home);
  assert.deepEqual(after[2], before[2], "the allowed models changed");
  assert.deepEqual(after[3], before[3], "the tool row changed");
  assert.deepEqual(after[4].config, { provider: "dshproxy-lanes", model: "lane-main" });
  // The route's own name in the provider list is the only mention of it.
  assert.equal(read(home).split(VIDEO).length - 1, 1);
  assert.equal(profile.videoExposed(home), false);
  assert.deepEqual(problems(home, [...MODELS, WAN, SEEDANCE, FLUX]), []);
});

test("verify reports each place that names the video route, separately", (t) => {
  const home = applied(t, [SEEDANCE]);
  for (const exposure of EXPOSURES) exposure.expose(home);
  const report = verify(home, [...MODELS, SEEDANCE]);
  assert.equal(report.ok, false);
  const found = report.profiles[0].problems;
  assert.equal(found.length, EXPOSURES.length, found.join("\n"));
  for (const exposure of EXPOSURES) {
    const mine = found.filter((problem) => exposure.where.test(problem));
    assert.equal(mine.length, 1, `${exposure.place}: ${found.join("\n")}`);
    assert.match(mine[0], SENTENCE);
    assert.match(mine[0], /dshproxy-video\/seedance-2\.5\/720p\/krea/);
  }
});

for (const exposure of EXPOSURES) {
  test(`the video route named in ${exposure.place} is reported by verify and counts as exposed`, (t) => {
    const home = applied(t, [SEEDANCE]);
    assert.equal(profile.videoExposed(home), false);
    exposure.expose(home);
    const found = problems(home, [...MODELS, SEEDANCE]);
    assert.equal(found.length, 1, found.join("\n"));
    assert.match(found[0], exposure.where);
    assert.match(found[0], SENTENCE);
    assert.equal(profile.videoExposed(home), true);
  });
}

test("a video entry that is the default model is what picking it in a chat leaves: not reported, not exposed", (t) => {
  const home = applied(t, [SEEDANCE]);
  pickAsDefault(home);
  assert.deepEqual(defaultModel(home), { provider: VIDEO, model: SEEDANCE.id });
  assert.deepEqual(problems(home, [...MODELS, SEEDANCE]), []);
  assert.equal(profile.videoExposed(home), false);

  // Beside a place that is for agents, that place alone is reported.
  EXPOSURES[0].expose(home);
  const found = problems(home, [...MODELS, SEEDANCE]);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], EXPOSURES[0].where);
  assert.equal(profile.videoExposed(home), true);
});

test("a default model that names a video entry which is not offered is reported", (t) => {
  const home = applied(t, [SEEDANCE]);
  pickAsDefault(home, WAN.id);
  assert.deepEqual(problems(home, [...MODELS, SEEDANCE]), [`agent-default-model names model ${WAN.id}, which is not offered`]);
  assert.equal(profile.videoExposed(home), false);
});

test("the video route is exposed when it is named for agents although the profile no longer has the route", (t) => {
  const home = applied(t, []);
  EXPOSURES[0].expose(home);
  assert.equal(profile.videoExposed(home), true);
  const found = problems(home, MODELS);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], SENTENCE);
});

test("a pair that is written once and reused by reference is found where it is used", (t) => {
  const home = applied(t, [SEEDANCE]);
  // The pair sits inside the provider list, which is not searched; the tool
  // row refers to it.
  let text = read(home).replace("          - id: my-model\n", `          - id: my-model\n            note: &paid ${PAIR}\n`);
  text = text.replace("        agentOptions:\n          provider: dshproxy-lanes\n          model: lane-main\n", "        agentOptions: *paid\n");
  fs.writeFileSync(patchPath(home), text);
  assert.deepEqual(entries(home)[3].insert[0].config.agentOptions, { provider: VIDEO, model: SEEDANCE.id });
  assert.equal(profile.videoExposed(home), true);
  const found = problems(home, [...MODELS, SEEDANCE]);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], /tool-reviewer at config\.agentOptions/);
});

test("the provider list and the tool bundle's own entry are not exposure", (t) => {
  const home = applied(t, [SEEDANCE, WAN]);
  // src/dsh/bundle.js writes an entry with this ID; it names no provider.
  fs.appendFileSync(patchPath(home), `- id: ${VIDEO}\n  disabled: true\n`);
  assert.equal(profile.videoExposed(home), false);
  assert.deepEqual(problems(home, [...MODELS, SEEDANCE, WAN]), []);
});

test("verify reports a video route that would be sent again automatically", (t) => {
  const home = applied(t, [SEEDANCE]);
  fs.writeFileSync(patchPath(home), read(home).replace(/maxRetries: 0/, "maxRetries: 5"));
  assert.equal(providers(home)[VIDEO].retryPolicy.maxRetries, 5);
  const raised = problems(home, [...MODELS, SEEDANCE]);
  assert.equal(raised.length, 1, raised.join("\n"));
  assert.match(raised[0], /dshproxy-video\.retryPolicy\.maxRetries is 5/);
  assert.match(raised[0], /dshproxy dsh apply/);

  // Without the setting DeepSeek Harness retries five times.
  edit(home, (doc) => doc.deleteIn([1, "config", "providers", VIDEO, "retryPolicy"]));
  assert.equal(providers(home)[VIDEO].retryPolicy, undefined);
  const unset = problems(home, [...MODELS, SEEDANCE]);
  assert.equal(unset.length, 1, unset.join("\n"));
  assert.match(unset[0], /dshproxy-video\.retryPolicy\.maxRetries is not set/);

  profile.apply([...MODELS, SEEDANCE], ORIGIN, home, { lanes: LANES });
  assert.deepEqual(providers(home)[VIDEO].retryPolicy, { mode: "normal", maxRetries: 0 });
  assert.deepEqual(problems(home, [...MODELS, SEEDANCE]), []);
});

test("a dry run reports the video route and writes nothing", (t) => {
  const home = applied(t, []);
  const before = snapshot(home);
  const adding = profile.apply([...MODELS, SEEDANCE, WAN], ORIGIN, home, { lanes: LANES, dryRun: true });
  assert.equal(adding.profiles[0].changed, true);
  assert.equal(adding.profiles[0].routes[VIDEO], 2);
  assert.match(adding.profiles[0].text, /dshproxy-video:/);
  assert.deepEqual(snapshot(home), before);

  const withVideo = applied(t, [SEEDANCE]);
  const written = snapshot(withVideo);
  const removing = profile.apply(MODELS, ORIGIN, withVideo, { lanes: LANES, dryRun: true });
  assert.equal(removing.profiles[0].changed, true);
  assert.equal(removing.profiles[0].routes[VIDEO], undefined);
  assert.doesNotMatch(removing.profiles[0].text, /dshproxy-video/);
  assert.deepEqual(snapshot(withVideo), written);

  const same = profile.apply([...MODELS, SEEDANCE], ORIGIN, withVideo, { lanes: LANES, dryRun: true });
  assert.equal(same.profiles[0].changed, false);
});

test("removing takes out the video route with the other four", (t) => {
  const home = applied(t, [SEEDANCE, WAN]);
  const dry = profile.remove(home, { dryRun: true });
  assert.deepEqual([...dry[0].removed].sort(), [...CHAT_ROUTES, VIDEO].sort());
  assert.ok(providers(home)[VIDEO]);
  const results = profile.remove(home);
  assert.deepEqual([...results[0].removed].sort(), [...CHAT_ROUTES, VIDEO].sort());
  assert.deepEqual(Object.keys(providers(home)), ["my-gateway"]);
  assert.doesNotMatch(read(home), /dshproxy-video/);
});

test("removing a profile that holds only the video route leaves the file as it was", (t) => {
  const home = tempHome(t);
  const own = "# Your patch layer.\n- id: ui-chat\n  config:\n    transcriptView: standard\n";
  fs.writeFileSync(patchPath(home), own);
  profile.apply([...MODELS, SEEDANCE], ORIGIN, home);
  edit(home, (doc) => {
    for (const key of CHAT_ROUTES) doc.deleteIn([1, "config", "providers", key]);
  });
  assert.deepEqual(Object.keys(providers(home)), [VIDEO]);
  assert.deepEqual(profile.remove(home)[0].removed, [VIDEO]);
  assert.equal(read(home), own);
});

test("another program's route with a similar name is left alone", (t) => {
  const home = tempHome(t);
  const mine = { api: "openai-completions", baseURL: "https://clips.example/v1", models: [{ id: "my-clips" }] };
  fs.writeFileSync(patchPath(home), YAML.stringify([{ id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: { "dshgate-video": mine } } }]));
  profile.apply([...MODELS, SEEDANCE], ORIGIN, home);
  assert.deepEqual(providers(home)["dshgate-video"], mine);
  profile.remove(home);
  assert.deepEqual(providers(home), { "dshgate-video": mine });
});

test("a clean profile is not exposed, and asking writes nothing", (t) => {
  const home = applied(t, [SEEDANCE, WAN]);
  fs.mkdirSync(path.join(home, "profiles", "web"));
  fs.mkdirSync(path.join(home, "profiles", "empty"));
  fs.writeFileSync(patchPath(home, "web"), BEFORE);
  const before = snapshot(home);
  assert.equal(profile.videoExposed(home), false);
  assert.deepEqual(snapshot(home), before);

  // Exposed in any one profile is exposed.
  fs.appendFileSync(patchPath(home, "web"), `- id: tool-clips\n  config:\n    agentOptions: ${PAIR}\n`);
  const exposed = snapshot(home);
  assert.equal(profile.videoExposed(home), true);
  assert.deepEqual(snapshot(home), exposed);
});

test("a home without profiles is not exposed, and asking creates nothing", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-profile-video-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(profile.videoExposed(home), false);
  assert.deepEqual(fs.readdirSync(home), []);
});

const UNREADABLE = [
  { what: "has YAML errors", make: (file) => fs.writeFileSync(file, "- id: llm-pi-ai\n  config: [unclosed\n") },
  { what: "is not a list of entries", make: (file) => fs.writeFileSync(file, "providers:\n  some: thing\n") },
  { what: "cannot be opened as a file", make: (file) => fs.mkdirSync(file) }
];
for (const { what, make } of UNREADABLE) {
  test(`a profile that ${what} counts as exposed, and asking writes nothing`, (t) => {
    const home = applied(t, [SEEDANCE]);
    fs.mkdirSync(path.join(home, "profiles", "web"));
    make(patchPath(home, "web"));
    const before = snapshot(home);
    assert.equal(profile.videoExposed(home), true);
    assert.deepEqual(snapshot(home), before);
  });
}

test("a profile that is a link to a folder elsewhere is searched too", (t) => {
  const home = applied(t, [SEEDANCE]);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-profile-video-linked-"));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.symlinkSync(elsewhere, path.join(home, "profiles", "linked"), "junction");
  // The link is removed first, so clearing the home never reaches the folder behind it.
  t.after(() => fs.rmSync(path.join(home, "profiles", "linked"), { force: true }));
  assert.equal(profile.videoExposed(home), false);
  fs.writeFileSync(path.join(elsewhere, "cordis.patch.yml"), `- id: tool-clips\n  config:\n    agentOptions: ${PAIR}\n`);
  assert.equal(profile.videoExposed(home), true);
});

test("a profiles folder that cannot be listed counts as exposed", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-profile-video-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // A file where the folder should be: listing it fails, and not because it is absent.
  fs.writeFileSync(path.join(home, "profiles"), "not a folder");
  assert.equal(profile.videoExposed(home), true);
  assert.deepEqual(fs.readdirSync(home), ["profiles"]);
});
