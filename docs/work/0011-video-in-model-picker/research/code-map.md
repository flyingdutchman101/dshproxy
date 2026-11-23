# Code map: video in the model picker (read-only)

Worktree: `C:\Users\USER\Desktop\Development\DSHProxy\.agents\worktrees\video-picker`
Scope: read-only mapping. No builds, tests, network calls, subagents, or app/CLI starts. `~/.dshproxy` was not read.

Confidence notes: line numbers come from reads made in this session. Ranges marked **(partly read)** were only partly seen; re-check before quoting them in a spec.

---

## A. `src/video/`

| File | Lines | Exports | Notes |
|---|---|---|---|
| `catalog.js` | 45 | `models`, `quote`, `routesFor` | Four models: `seedance-2.5`, `seedance-2.0`, `minimax-h3`, `wan-3.0`. Each has `defaultRoute`, `resolution`, `routes`. `vr()`/`kov()` helpers at 4–9. Routes at 11–29. `quote(model, route)` at 32 hardcodes `durationSeconds: 5`, `aspectRatio: '16:9'`, `verifiedOn: '2026-11-21'`, `priceBasis: 'published'` (38). `routesFor` at 41 appends `'krea'`. Callirra entry uses `priceBasis: 'effective'`, `credits: 10`. |
| `command.js` | 102 | `run(args, out, {env, fetchImpl, workspace, readSecret, loadMasterKey})` at 32 | Help text 3–20 hardcodes the four models, route names, and "Five seconds, 16:9, text only" (17). `budgetMicros` 23. `settings` branch 37–48 (`settings.read/write`, `routesFor`). `key` branch 49–62. Krea branch 63–68 (`client.request`, `client.result`, `workspace || client.invoke`). Quote 69–76. Krea handoff text 77–82 hardcodes "5s", "16:9", and the Krea MCP doc URL. Submit/status 83–100: `--max-usd` / `--max-credits` check, `keys.resolve`, `transport.submit/status`. |
| `settings.js` | 163 | `read`, `write`, `offered`, `routes`, `file` | File `video-settings.json` (17). `WORKSPACE_ROUTE = 'krea'` (20). `routes(model)` at 47 returns compatibility `published-estimate` or `unverified`. `entry()` at 61 accepts only `enabled` (boolean) and `route`. `write(home, config, {io})` at 139 under `withLock`. `offered(home)` at 156 returns `{model, route}` for enabled models with a route. Imports `homeDir` from `../settings`. |
| `transport.js` | 74 | `submit`, `status` (74) | Body constants `vr` (4–8): resolution `'720p'`, `duration_secs: 5`, `aspect_ratio: '16:9'`. `providers` Map (9–19): videorouter (3 models), videorouter-replicate (wan), kovapi (`minimax-h3` body resolution `'768P'`, others `'720P'`, `duration: 5`, `size: '16:9'`), callirra (`minimax-h3` only, `resolution: '768P'`, `duration_seconds: 5`). `STATES` 21–25. `request()` 36: 30 s `AbortSignal.timeout`, `redirect: 'error'`, Bearer auth. Messages: "Video submission unconfirmed; do not retry until provider history is checked." and "Video job status could not be verified." `outputLink` 29. |
| `workspace.js` | 43 | `request`, `result`, `invoke` | `idPattern` 5, `statuses` 6. `request(args)` 8: quote needs `--prompt`; submit needs `--max-units COUNT --confirm-charge`; status needs a job id; prompt cap 16000 bytes. `result(req, data)` 16 (quote → `parseQuote`, currency `workspace_compute_units`, budgetFlag `--max-units`). `invoke(req)` 28: `spawn(process.execPath, [bin/dshproxy-krea.js])`, pipes, `shell:false`, `windowsHide`, env limited to SystemRoot, LOCALAPPDATA, TEMP, TMP, USERPROFILE. Timeout 90000 ms (35). Output cap 65536 bytes. stdin gets `JSON.stringify(req)+'\n'` (40). stderr `KREA_LOGIN_REQUIRED` and `KREA_REFUSED` map to messages; anything else becomes "did not return a verified result". |
| `krea-preset.js` | 79 | `prepare`, `parseQuote` | `presets` Map 3–8: seedance-2.5 → `video/bytedance/seedance-2-5` 720p; seedance-2.0 → `video/bytedance/seedance-2` 720p; minimax-h3 → `video/minimax/hailuo-3` 768p; wan-3.0 → `video/alibaba/wan-3.0` 720p. `prepare(model, prompt, discoveredIds, modelInputSchema)` at 58; input `{prompt, duration: 5, resolution, aspect_ratio: '16:9'}` at 62; schema `resolution` check at 66. `parseQuote` at 69 requires `mode, compute_units, is_estimated, available_compute_units, affordable`. |
| `keys.js` | 216 | `providers`, `list`, `set`, `remove`, `resolve`, `file` | File `video-keys.json`. PROVIDERS 24–28: videorouter (`VIDEOROUTER_API_KEY`, routes videorouter and videorouter-replicate), kovapi (`KOVAPI_API_KEY`), callirra (`CALLIRRA_API_KEY`). `resolve(home, route, {env, loadMasterKey})` at 204: env var wins, else decrypt saved entry. Uses `src/secrets.js` and `master.key`. **(partly read: 86–202)** |

Surprises in A:
- `quote()` (catalog.js:38), `command.js` help (17) and handoff (80), and transport bodies hardcode 5 s and 16:9. A per-resolution catalog needs these changed together.
- Resolution is one value per model in three places: `catalog.js` `resolution`, `krea-preset.js` `presets` (4–7), and the transport bodies. The helper's `modelIds` map duplicates the model ids (see B).
- `routesFor` (catalog.js:41) adds `krea` to every model, so the route set is not the four listed in `routes`.

---

## B. `src/krea-helper/` and `bin/dshproxy-krea.js`

**`src/krea-helper/mcp.js`** (134 lines), exports `{run}` (134).
- `ENDPOINT`, `VERSION = '2025-06-18'`, `MAX_BYTES = 1024*1024` (3). `modelIds` Map (4) duplicates the video preset ids.
- `WorkspaceError(code, message)` (7); `loginRequired()` (10); `accepts(schema, values)` (14) validates against the tool schema. Submit adds `preflight:false` (122).
- `readResponse` (29–44): JSON or single SSE frame, 1 MiB cap.
- `session(token, fetchImpl)` (45–64): 30 s discovery deadline (47); a `generate` call with `preflight===false` gets its own 30 s window (50–51). `redirect:'error'`. `MCP-Protocol-Version` header set after initialize (54). Any fetch failure becomes `KREA_REFUSED` "request failed ... No retry" (62).
- `toolResult` (65–77): accepts `structuredContent` or single text JSON block; refuses mixed evidence.
- `parseJob` (79–89): statuses `backlogged … cancelled`; completed jobs must have exactly one https output URL.
- `execute` (90–124): actions `quote | submit | status`. Discovery order: `initialize` → `notifications/initialized` → `tools/list` → `list_models` → `get_model_schema` → `generate` (preflight). Budget refusal at 121: `KREA_REFUSED` "Krea workspace budget or balance insufficient. No job submitted." Submit failure at 123–124 → `KREA_UNCERTAIN`.
- `run(request, token, options)` at 126 wraps errors (not re-read in full).

**Krea balance:** No balance endpoint is used. The helper learns affordability only from the preflight `generate` result (`available_compute_units`, `affordable`). A balance read would need a new action or a `list_*`/account tool; **no such tool was identified in the read code, and `docs/work/0011-video-in-model-picker/evidence/krea-live-shapes.md` is the place to check (section "Quotes" and "Not observed" were not read).**

**`src/krea-helper/oauth.js`** (113 lines), exports `{login, access, status, windowsStore}`.
- `resource = 'https://api.krea.ai/mcp'` (8). `trusted` origins (9): `https://api.krea.ai`, `https://krea.ai`, `https://www.krea.ai`.
- `endpoint()` (13); `jsonRequest` (18): 15 s, 128 KiB cap, `redirect:'error'`.
- `openLoopback(expectedState)` (24): 127.0.0.1 random port, `/callback`, state check, 180 s.
- `login({clientId, fetchImpl, openCallback, showUrl, store, now})` (44–70), **partly read**: discovery requires `S256` PKCE and `code` response type (52); token endpoint auth `none` if advertised (53); dynamic client registration when no `clientId` (57–60) with `grant_types: ['authorization_code']` and redirect URI; authorize URL carries `resource` (62); token exchange (65) with `code_verifier` and `resource`; `refresh_token` is discarded. No refresh grant exists.
- DPAPI wrapping through PowerShell (73–83): key is protected with DPAPI, payload AES-256-GCM.
- `windowsStore()` (84–98): file `%LOCALAPPDATA%\DSHProxy\KreaOAuth\session.v1`; `save`, `load`, `clear`.
- `usable(store, now)` (102) requires `resource`, token pattern, and `expiresAt > now()+30000`. `access()` (105) throws `KREA_LOGIN_REQUIRED`. `status()` (110) returns `{signedIn, expiresAt}`; never the token.

**`bin/dshproxy-krea.js`** (28 lines), exports `{main}`.
- Commands: `login [--client-id ID]`, `logout`, `status` (one JSON line), or one request JSON on stdin (`readRequest` line 7: max 65536 bytes, one line).
- `access(makeStore())` then `run`. Errors go to stderr as `KREA_LOGIN_REQUIRED` / `KREA_UNCERTAIN` / `KREA_REFUSED`, exit 1. Output is scanned so token-like keys never print.
- Imports `../src/krea-helper/oauth`.

Surprises in B:
- `mcp.js` requires `../video/krea-preset` (dependency runs helper → video). `bin` requires helper; `video/workspace.js` only spawns the bin. Keep this in mind when adding Flux 3 or a balance action.
- Discovery timeout 30 s (mcp.js:47) vs spawn timeout 90 s (workspace.js:35) vs loopback login 180 s (oauth.js:24).
- `oauth.js` header comment says it must never be imported from DSHProxy; only `bin` imports it, so that holds.

---

## C. DSH integration

**`src/dsh/profile.js`** (482 lines). Exports `{ROUTES, KEY_REF, MAX_REQUEST_IMAGES, MAX_REQUEST_IMAGE_BYTES, dshHome, apply, remove, state, verify, buildRoutes}`.
- `ROUTES` 36–41: four `dshproxy-*` routes (`dshproxy-lanes`→`lanes`, `dshproxy-claude`, `dshproxy-openai`, `dshproxy-compat`), each with `suffix`, `protocol`, `label`.
- `MANAGED_FIELDS` 47; `modelEntry(model, existing)` 58.
- `buildRoutes(models, origin, previous, keepModelPrefixes)` 76–90: filters `models` by `model.api === route.api`. Keeps prior entries whose id starts with a kept prefix (84). Route baseURL = `${origin}${suffix}`.
- `profiles`, `patchFile` (`profiles/<name>/cordis.patch.yml`), `readPatch`, `findEntry` (plugin id `llm-pi-ai` or name `@deepseek-ai/dsh-llm-pi-ai`), `backupPath`, `writeWhole`, `writePatch` (92–146).
- `hasRoutes`, `apply(models, origin, home, options)` (289–308): `onlyApplied` skips profiles without routes; all profiles read before any write; returns `credential`.
- `remove` (312–329).
- `applyToProfile` (about 230–284): `agent-default-model` repaired when missing (262–272).
- `verify({origin, lanes, models, home})` (about 370–456): checks `.credentials.yaml` ref `KEY_REF` (375–382); per profile checks baseURL, `apiKeyEnv`, image limits, models present; lanes need all lane ids; non-lane routes must not list models that are no longer offered (415–416); `danglingReferences` (336, 446). `ok` false on any problem.
- `state(origin, home)` (458–482) returns `{home, profiles:[{profile, routes, current, error}], applied}`.
- **Partly read:** lines 150–262 (`applyToProfile` internals), 336–372 (`danglingReferences`, verify preamble), 462–482.

**`src/catalog.js`** (267 lines). Exports `{ALL_EFFORTS, API_PROVIDERS, SUBSCRIPTION_MODELS, subscriptionModels, providerModels, providerRegion, providerRegionKey, regionForKey, findModel, laneModels, laneId, laneName}`.
- `subscription(id, name, account, api, extra)` (10): `api` names the DSH route.
- `SUBSCRIPTION_MODELS` 21–47; `API_PROVIDERS` starts about 52 (**not read**).
- `laneModels` about 235–251: lane entries use `api: "lanes"`; `input` from members; `contextWindow` minimum.
- Video models are not in this catalog.

**`src/models.js`** (229 lines). Exports `{CATALOG_URLS, parseCatalog, listModels, buildModels, suggestions, isCurrent, fetchCatalog, routeFor}`.
- `ROUTE` map 22 (claude→claude, codex→openai, antigravity→compat, kimi→compat); `routeFor` 26; `entryFrom` 49 keeps chat models; `fetchCatalog` 215 from `https://models.router-for.me/models.json` with raw GitHub fallback. Video is not in this list. **(partly read: 77–211)**

**`src/cli.js`** (610 lines).
- Help: `video help` at 46; `dsh apply/verify/status/remove` at 48–51.
- `video` dispatch at 331: `require("./video/command").run(argv.slice(1), out, { readSecret })`. This path runs in-process, not through the gateway.
- `dsh` switch 533–557: `apply` → `profile.apply(state.models, state.origin, profile.dshHome(), {dryRun, keepModelPrefixes: state.unreadable, lanes: state.settings.lanes})` (about 533–537); `remove` 538; `verify` 542 (exit 1 when not ok, prints "credentials: …"); `status` 553.
- `reportApply` 301; `status` text 247–252 reads `profile.state`.
- `models` command 527–531 lists `state.models` only (no video).
- `stop --when-idle` 397–443; `gateway.inFlight()` used in restart loop 120–130.

**`src/app.js`** (244 lines). Exports include `snapshot`, `offeredModels`, `readDiscovery`, `saveDiscovery`, `readProviders`, `saveProviderKey`, `readCustom`, `saveCustom`, `appendLog`. `snapshot(home)` (about 210) builds `models: [...lanes, ...real]` from `offeredModels` (207). Video models are not included. **(partly read: 97–226)**

**`src/daemon.js`** (594 lines).
- Imports `./dsh/profile` (20), `./gateway/server` (13), `./lanes` (15).
- `countRequests(server, counted, ended)` (53–72): prepends a `request` listener, so every request is counted from head read until response or socket close.
- `fingerprint(models)` (75–77): `[id, api, contextWindow, maxTokens, efforts, input]`. This is what changes trigger a DSH re-apply.
- `fetchDiscovery` (160–175): fetches catalog and `http://<host>:<backendPort>/v1/models`.
- `discover` (156–159) → `syncNow("model list changed")`.
- `syncNow` (about 195–214) calls `profile.apply(..., {keepModelPrefixes: state.unreadable, onlyApplied: true})`.
- Gateway creation about 466–468: `createGateway({upstream, resolve: createResolver({lanes, isAvailable}), …})`.
- `inFlight = countRequests(gateway, (req) => !ownRequest(req), …)` about 496; `ownRequest` about 495 excludes `GET /dshproxy/status` and control prefix.
- `status()` about 243 includes `inFlight`; `stopWhenIdle` about 562–575; control routes about 377–401.

Surprises in C:
- DSH sees only what `profile.apply` writes. Video models never reach `snapshot().models` or the chat picker. Adding "Seedance 2.5 - 720p - Krea" entries needs a new input path from video settings to `buildRoutes`, plus a fingerprint change so a re-apply fires.
- `verify` (`stale` check, profile.js ~415) would flag a video-model entry that is not in `offered`, unless `offered` is extended.
- `integrations/dsh-video` is the DSH-side path for video today: tools `video_options`, `video_quote`, `video_submit`, `video_status`. It is not a chat-picker entry. See D2 below.

---

## D. `src/gateway/` and the seam

**`src/gateway/server.js`** (441 lines). `createGateway({upstream, resolve, describe, failover, sessions, log, status, control, supportsImages, accountOf, retryDelays, quotaReset, quotaLookupMs, maxBodyBytes})` at 137.
- Constants: `HOP_BY_HOP` 14, `STATUS_PATH = "/dshproxy/status"` 15, `MAX_BODY_BYTES` 256 MiB (20), `MAX_JUDGED_BYTES` 64 KiB. Account breaker 128–133; quota recheck 133.
- `describeRequest` 85–100 and `describeShape` 104–125: log-only structure summaries.
- `usedUpUntil` 141–151; `accountCooling` 156; `noteAccountStrike` 165.
- Forwarding and ladder logic: 166–403, **partly read** (not seen: 166–395).
- Request handler `http.createServer((req, res) => …)` at 405:
  - 407 `res.on("error", …)`;
  - 408–411 `GET /dshproxy/status` → `status()`;
  - 412–415 control prefix → `control(req, res)`;
  - the chat forwarding path follows after 415 (not read; 416–441 unread).
- `STATUS_PATH` and `createGateway` exported at 441.

**`src/gateway/failover.js`** (121 lines). `createFailover({now, cooldownMs, maxCooldownMs, threshold})` at 34. `CAPACITY` {402,429,503,529}, `TRANSIENT` {0,500,502,504}, `REJECTION` {400,404,413,422} (22–24). `TOO_LONG` (26), `UNAVAILABLE` (27) regexes. Cooldown map `cooling`, strike map `strikes`. Read 1–60 only.

**`src/gateway/request.js`** (48 lines). Exports `{EFFORT_ORDER, nearestEffort, clampEffort, prepareBody}`. `prepareBody(raw, model, {efforts, upstream})` at 39 rewrites `body.model`, clamps reasoning effort, returns original bytes when unchanged.

**`src/gateway/content.js`** (28 lines). `{carriesImage, filterForImages}`; `IMAGE_TYPES`.

**`src/gateway/sessions.js`** (55 lines). `createSessions` → `{keyFor(lane, headers, body), get, set}`; headers `x-session-id`, `x-claude-code-session-id`, `session_id`.

**`src/lanes.js`** (34 lines). Exports `{availability, createResolver, describe}`. `createResolver({lanes, isAvailable})` at 20 returns `(id) => {lane, ladder}`; any non-lane id passes through as `{lane:null, ladder:[id]}`. `describe(id)` at 29.

**`src/control.js`** (93 lines). `PREFIX = "/dshproxy/control/"` (12). Refuses requests with `Origin` (403) or wrong `x-dshproxy-token` (401). Token file `~/.dshproxy/control.token` (from comment; not read).

### The seam for a locally answered model id

Proposed seam: in `createGateway`'s handler (server.js:405), after the `STATUS_PATH` and control checks (408–415) and before the chat forwarding path, add a branch that matches a video model id for the protocol and answers locally. Points that matter:
- `prepareBody` (request.js:39) rewrites `body.model`; a local answer must run before any `resolve()` call (daemon.js ~466) so the ladder never sees the id.
- `countRequests` (daemon.js:53) counts every request not excluded by `ownRequest` (~495). A local answer would be counted as in flight unless excluded there. That affects `stop --when-idle`.
- Per-protocol shapes (OpenAI `/v1/chat/completions`, Claude `/v1/messages`, models list `/v1/models`) are not confirmed here; the `/v1/models` path is read by `daemon.js` fetchDiscovery (171), so a local answer must also appear in that list or in the picker source.
- There is no auth on model requests; only control has the token check.
- Note: `failover.js` `UNAVAILABLE` and `REJECTION` logic would not apply to a local answer.

### D2. `integrations/dsh-video` (DSH plugin)

Files: `index.js`, `runner.cjs`, `lib/bridge.js`, `lib/config.js`, `lib/tools.js`, `lib/submit.js`, `cordis.patch.yml`, `package.json`, `README.md` (10235 bytes), `locale/en.json`, `icon.svg`, `test/dsh-video.test.mjs` (18 tests), `test/submit.test.mjs` (22 tests), `testing/support.mjs`.
- `index.js` exports `{name, inject, build, apply}`. `build(config, host, deps)` makes the four tools: `video_options`, `video_quote` (`lib/tools.js`), `video_submit`, `video_status` (`lib/submit.js`).
- `lib/bridge.js`: `createBridge(settings, {spawnImpl})` spawns `node runner.cjs <root>` per request; JSON one line each way; 65536-byte cap; `CODES` set (line 9). `commit` flag makes failures after spawn `UNCERTAIN`.
- `lib/config.js`: `resolveSettings(config, host)`; keys `root`, `node`, `home`, `timeoutMs` (default 100000); env allowlist SystemRoot, LOCALAPPDATA, TEMP, TMP, USERPROFILE.
- `runner.cjs`: requires `src/video/command.js` from the DSHProxy root (line 81), runs `run(args, …, {env, fetchImpl: noNetwork})` (96). It builds only `settings`, `quote`, `status`, and one `submit` for the krea route. Its `offered()` reads `settings` (112–123). Krea quote runs a listed offline `quote <model>` first, then a preflight (185–187). Submit at 196 with `--max-units`, `--confirm-charge`.
- `lib/submit.js`: `video_submit` asks the user through `ctx.get('userQuestions')` (index.js 41); approval options "Generate once" / "Do not generate"; refuses subagents and nested calls.
- `cordis.patch.yml`: inserts plugin entry `dshproxy-video`, name `@local/dshproxy-video`, `config: {}`.

Surprises in D2:
- The bundle is a plugin that **spawns** DSHProxy's `video` command; it does not use the gateway or the chat picker. This is the existing decision in `docs/decisions/0002`.
- `runner.cjs` validates the DSHProxy root by `package.json` name `dshproxy` and requires `src/video/command.js` by absolute path, so any change to `command.js` `run` signature or output shape breaks the bundle silently.
- `bridge.js` `CODES` set and `tools.js` `MESSAGES` must be updated together with any new command error.

---

## E. C# app (`app/DSHProxyApp.cs`, `app/Skin.cs`)

Scope: DSHProxyApp.cs is 297501 bytes; Skin.cs is 99033 bytes. Grep covered both files.

**`VideoSettings` class** (`DSHProxyApp.cs` about 4370–4533): holds the parsed view of `dshproxy video settings`.
- `Model` (about 4370–4443): `Id`, `Enabled`, `Route`, `HasRoute`, `Routes`.
- `Parse`/`Read`/`Failure` (4449–4473).
- `RouteLabel` 4475–4486: switch on `krea`, `videorouter`, `videorouter-replicate`, `kovapi`, `callirra`, default = route name. **Every video route name appears here.**
- `RouteName` 4489–4493.
- `CompanyLogos` 4496: `{"alibaba","minimax","bytedance"}`.
- `Company(model, out logo)` 4502–4509: hardcoded `wan-3.0` → Alibaba, `minimax-h3` → MiniMax, `seedance-*` → ByteDance (prefix match). **Every video model appears here.**
- `Units(route)` 4512–4523: krea → "workspace compute units"; callirra → "plan credits"; videorouter, videorouter-replicate, kovapi → "US dollars"; default "units not known to this app".
- `Sample` 4528–4532: preview JSON with `wan-3.0`, `minimax-h3`, `seedance-2.0`, `seedance-2.5` and their route lists (includes krea).

Other C# references:
- `DSHProxyApp.cs` 3156–3158: Krea row in accounts list; `VideoSettings.RouteName("krea")`, `Units("krea")`.
- 3190 and 3204: `VideoLogos(..., VideoSettings.CompanyLogos)`.
- 3199, 3210: fixed copy: "new models start switched off", "nothing is generated or charged here".
- 3305–3358 `FillVideo()`: model list columns are model id, company, route cell, units, state; lanes list same with "Choose a billing route".
- 3403–3407 `VideoRouteCell`.
- 3456–3466 reads settings; `VideoSettings.Sample` used in preview.
- 3000, 2990–3003: video page state fields (`videoModels`, `videoModelsList`).
- 5261: `VideoSettings.Failure` for a non-zero exit.
- 5490–5519 `Ask(...)` dialog: "Charge {model} to:" with a combo of routes and "billed in" text.
- 4721–4722: `VideoKeys` provider list (kovapi, callirra shown; videorouter above).
- 635, 652, 1300–1303, 1360–1361: logos for provider and model lists (`deepseek`, `moonshot`, `zai`, `qwen`, `minimax`, `mistral`, `openrouter`).
- 394–411: `KreaScript` path `bin/dshproxy-krea.js`; `RunKrea`, `StartKrea`.
- `app/logos/`: `krea.png`, `alibaba`, `minimax`, `bytedance` logos used by `CompanyLogos`. `logos/SOURCE.md` line 24 says VideoRouter, KovAPI and Callirra are text only. No logo file for "Flux" or other companies.

**Answer for E:** Yes, C# changes are needed for:
1. A 5th model (for example `flux-3`): `Company()` (DSHProxyApp.cs:4502–4509) returns "" unless the id is added; a new company needs a logo in `app/logos` plus `CompanyLogos` (4496). `Sample` (4528) optional.
2. A per-resolution entry, for example "Seedance 2.5 - 720p - Krea": `VideoSettings.Model.Id` and the list columns (3329) show the raw id. Text of the form "Model - Res - Route" is not produced anywhere in C#; the id format from `dshproxy video settings` would have to carry resolution, or the C# list would need a new column. `Company()` uses prefix matching, so `seedance-` ids still resolve.
3. A new route name: `RouteLabel` (4477–4485) and `Units` (4514–4522) need a case; otherwise the route shows raw and units show "units not known to this app".
4. A Krea balance: no balance UI exists; the Krea row (3158) has a fixed "Not read yet" state.

**Skin.cs:** no video-model or route names (grep matched only layout comments, lines 715, 1647, 1652, 1743). No C# change needed in `Skin.cs` for new models.

---

## F. Tests, fixtures, and checks

Test files (count of `test(`/`it(` calls, from grep):
- `test/video-catalog.test.js` 5 (no fixture reads)
- `test/video-command.test.js` 24
- `test/video-concurrency.test.js` 13
- `test/video-keys.test.js` 23
- `test/video-krea-preset.test.js` 3 (no fixture reads)
- `test/video-settings.test.js` 29
- `test/video-transport.test.js` 6
- `test/krea-mcp.test.js` 11 (inline fixture at line 12; response shapes built in code)
- `test/krea-oauth.test.js` 12 (inline fixture at line 7; synthetic token strings)
- `test/profile.test.js` 40 (no fixture reads)
- `test/daemon.test.js` 47
- `test/gateway.test.js` 39
- `test/catalog.test.js` 14; `test/models.test.js` 16; `test/cli.test.js` 7; `test/failover.test.js` 18; `test/lane-coverage.test.js` 3; others.
- `integrations/dsh-video/test/dsh-video.test.mjs` 18; `submit.test.mjs` 22; `testing/support.mjs` (helpers, 0 tests).

Fixtures: No `test/fixtures` directory was found. Tests build fixtures inline (for example `krea-mcp.test.js` 12–19, `krea-oauth.test.js` 7–9). The Krea live shapes evidence file `docs/work/0011-video-in-model-picker/evidence/krea-live-shapes.md` (10912 bytes) holds observed interface data; it is not read by tests.

Checks:
- `package.json`: `"test": "node --test"`, `"check": "node scripts/check.js"`, `engines.node >=22`, `os: win32`.
- `scripts/check.js` (17 lines): runs `node --check` on every `.js` under `bin`, `src`, `scripts`, `test`. **`integrations/` is not walked.** It has no line-length rule.
- `.github/workflows/ci.yml`: Windows, Node 22.x and 24.x; `npm ci --ignore-scripts`, `node scripts/check.js`, `node --test`.
- `node --test` with no args picks up test files recursively, so the `.mjs` tests under `integrations/dsh-video/test/` are likely included (not verified by running).

Surprises in F:
- `scripts/check.js` does not syntax-check `integrations/dsh-video/**` (`.cjs`, `.mjs`, `.js` files). `runner.cjs` is not checked by it.
- Krea tests rely on inline synthetic responses; a fixture for a balance response would be new.

---

## G. Docs that would go stale

- **`AGENTS.md` and `GLOSSARY.md` do not exist in this worktree** (checked at the root, `git ls-files`, and the parent folder). No rule numbers or headings to update. The user-wide `~/.dsh/AGENTS.md` is a different file.
- `README.md` (25353 bytes, root): not read in this session. Likely has video, Krea, and DSH sections; re-check any statement about models, routes, price, or the 5 s / 16:9 limit.
- `integrations/dsh-video/README.md` (10235 bytes): describes the four tools and settings. Stale if tools, route list, or models change. Not read in this session.
- `docs/decisions/0002-video-command-boundary.md`: says no video through the chat gateway, no credential persistence, no new listener. Adding a locally answered gateway model id changes "chat gateway" boundary: a new decision is likely needed.
- `docs/decisions/0003-krea-workspace-companion.md`: says the routing CLI does not ingest workspace tokens and that a helper is a single-send process. A balance action must keep these.
- `docs/decisions/0004-video-credentials-in-app.md`: says "paid generation from DeepSeek Harness stays on the Krea route until a separate decision covers API routes." Publishing API-route video models to the chat picker conflicts with this and needs a new decision.
- `docs/decisions/0001-run-stock-cliproxyapi.md`: relevant if the local answer changes the forwarding model.
- `docs/work/0003-video-routing/` and `docs/work/0005-video-credentials/` specs: record current four-model catalog and route set.
- `app/logos/SOURCE.md` line 24: states text-only for VideoRouter, KovAPI, Callirra and that Alibaba and ByteDance marks identify companies; becomes stale if a new company logo is added.
- `docs/work/0011-video-in-model-picker/evidence/krea-live-shapes.md`: the live-shape evidence file; keep it consistent with any preset or resolution change.

---

## Surprises (summary)

1. Video models are invisible to DSH's chat picker: `snapshot().models` (app.js ~207) and `profile.apply` take only lanes and chat models, so a new picker entry needs a new input path.
2. The gateway's request handler (server.js 405–415) has a clean insertion point, and `countRequests` already counts every request, so local answers would count as in flight unless `ownRequest` excludes them.
3. `resolution` is a per-model constant in three places (catalog.js 11–29, krea-preset.js 4–7, transport.js bodies); the 5 s / 16:9 values are also hardcoded in `quote()` (catalog.js:38), command help (command.js:17) and handoff (command.js:80).
4. `krea-helper/mcp.js` duplicates the model-id map (line 4) and imports `video/krea-preset` (reverse dependency).
5. No Krea balance endpoint is used. Affordability only comes from a preflight `generate` call (`mcp.js` 119–121).
6. The DSH bundle `integrations/dsh-video` is a second, parallel surface: `runner.cjs` requires `src/video/command.js` by absolute path, so `command.js` output shape is a contract.
7. `scripts/check.js` does not syntax-check `integrations/`.
8. `AGENTS.md` and `GLOSSARY.md` are absent from this worktree.
9. C# hardcodes every model and route (`VideoSettings.Company` 4502–4509, `RouteLabel` 4477–4485, `Units` 4514–4522). A fifth model with a new company needs a logo and mapping change; a resolution suffix in the id needs no logo change but changes how the list reads.
10. Decision 0004 keeps DSH paid generation on the Krea route; publishing API-route models to the chat picker needs a new decision.

## Not read or not verified (for the next step)

- `src/gateway/server.js` 166–395 and 416–441; `src/gateway/failover.js` 61–121.
- `src/dsh/profile.js` 150–262 and 336–372 and 462–482; `src/catalog.js` 52–238; `src/models.js` 77–211; `src/app.js` 97–226.
- `src/krea-helper/mcp.js` 125–134 (`run`), `src/krea-helper/oauth.js` 1–50 partly.
- `README.md` (root), `integrations/dsh-video/README.md`, `test/video-*.test.js` bodies.
- `krea-live-shapes.md` sections "Quotes", "Model input schemas" and "Not observed" (needed to answer the balance question).
- Whether `node --test` globs pick up `integrations/dsh-video/test/*.mjs` (not run).
