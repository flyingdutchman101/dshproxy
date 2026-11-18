# 0002 — DSHProxy hardening + media: spec (v4)

Status: v4, 2026-11-18 13:30. Quick fix applied (configuration only); no
code written. The plan is `plan.md` (master plan v4). History in `ledger.md`.

## Outcome

1. Every route DeepSeek Harness calls through DSHProxy answers, or fails fast
   with the provider's own reason — no hangs, no retry storms, no silently
   broken wiring.
2. DSHProxy behaves like a well-mannered client: one attempt per request
   upstream, no bursts, no account pooling — the patterns providers ban.
3. DSH can generate images, video and web-ready animation through API keys,
   with a spend cap.

## Evidence (observed, not assumed)

| # | Observation | Source |
|---|---|---|
| E1 | `reviewer` tool fails instantly: `pi-ai provider "dshproxy-compat" has no configured model "gemini-4-carbon-high"` | live tool call; both profiles' `tool-reviewer` pin |
| E2 | `architect` tool → `claude-fable-5-2` (Fable weekly 0 % until 2026-11-19 17:00): one call hung ~4 min, ≥ 25 upstream calls, then failed | live call; gateway log 2026-11-18T11:51–11:54Z |
| E3 | `lane-architect` 429 while Claude Opus/Sonnet healthy: live rungs Fable + Terra both exhausted (separate quota buckets) | live probe |
| E4 | `~/.dsh/AGENTS.md` names deleted `droidproxy-*` routes 10× | grep |
| E5 | Backend `request-retry: 3` = up to 4 calls/request + up to 30 s wait between rounds (`max-retry-interval`); stacked under gateway (4) and DSH (5) retries | `config.example.yaml`; `settings.js:30`; stored `settings.json` |
| E6 | Codex 429 carries `retry-after: 66163` + `resets_at`; gateway caps cooldown at 6 h and a forced pick still sleeps 39 s | probe; `failover.js:30,47`; `server.js:334` |
| E7 | Claude quota 429 carries no reset; reset times ARE known from the usage endpoint (`limits.js`), only displayed | probe; Accounts tab |
| E9 | 247 profile backups, never pruned; orphaned `.tmp` | listing; `profile.js:121-145` |
| E10 | Public repo: no LICENSE, no CI | GitHub |
| E11 | Subagent model selection in the web session: "no LLM providers" although `allowedModels` is set (3 entries name the deleted route) | `list_subagent_models` |
| E12 | Consumer terms: Anthropic §3.7 bars automated access "except … via an Anthropic API Key"; OpenAI bars programmatic extraction of Output; Google already suspended this user for proxy use | [Anthropic](https://www.anthropic.com/legal/consumer-terms), [OpenAI](https://openai.com/policies/row-terms-of-use/), backend log 2026-11-16 |
| E13 | Gateway already relays any non-model request unchanged (multipart, polling GETs, binary) | `server.js:217-224` |
| E14 | DSH has no image/video/audio generation tool; its LLM seam is chat-only | DSH package inventory |
| E15 | Sora 2 + OpenAI `/v1/videos` shut down 2026-09-24; no Lottie-generation API exists; OpenAI SIWC lists image generation as unsupported | OpenAI deprecations/SIWC docs; research 2026-11-18 |
| E16 | Backend `round 0` already tries every eligible credential of a provider; strategy today `round-robin` + affinity 2 h | `config.example.yaml`; `backend/config.js:17-19` |
| E17 | Live quota 13:08: Claude weekly **4 %** (reset 2026-11-19 17:00), Fable 0 %; ChatGPT weekly 0 % (reset 07:08), **1 reset credit** available | control API `limits` |
| E18 | ffmpeg 9.0.2 installed | `ffmpeg -version` |
| E19 | Second Claude account signed in 2026-11-18 13:19 (weekly 86 %, Fable 99 %, resets 2026-11-22 20:00); picked up without restart | control API `limits`; live probes 200 |
| E20 | With two active Claude accounts the backend alternated: 6 / 7 selections in 10 minutes, 1 failed call on the exhausted one | backend log 13:17–13:27 |
| E21 | Forcing a usage refresh drew HTTP 429 from the exhausted account's usage endpoint | control API `limits?refresh=1` |
| E22 | After the quick fix the DSH tools go through lanes without a DSH restart: `lane scout` → Haiku, `lane reviewer` → Opus (requests with 41 tools) | gateway log 12:27:55Z |
| E23 | `list_subagent_models` still empty after `allowedModels` was cleaned: the dead entries were not the cause of E11 | tool call 13:28 |
| E24 | One GPT 429 on `lane-main` cost 4 upstream calls and a 6-hour cooldown against a reset 18 hours away | backend log 13:27 (`4x 429 codex gpt-6-astra`, "skipped until about 19:27") |
| E25 | Backend supports a per-account priority and a management route to set fields (`AuthFilePriorityAttribute`, `auth-files/fields`, `FillFirstSelector`); semantics not yet tested | strings in `cli-proxy-api.exe` 8.0.76; leads: CLIProxyAPI issues [#2924](https://github.com/router-for-me/CLIProxyAPI/issues/2924), [#6089](https://github.com/router-for-me/CLIProxyAPI/issues/6089) |

## Already done — out of scope (verified in code)

Per-(lane, session) pinning; failover only before first byte; fail-open when
every rung cools; context-too-long failover without cooling; Retry-After
honoured; media passthrough (E13); ChatGPT reset credits list/use; quota
windows with reset times per account.

## Rejected (with reason)

| Idea | Why not |
|---|---|
| Gateway concurrency queue / priority | DSH caps subagent parallelism; no observed overload; revisit with evidence |
| Usage/cost ledger for chat | subscription quota, no per-token bill (media spend cap is separate, see M) |
| Header rate budgeting | superseded by Q (provider resets) |
| Latency scoring, complexity routing, canary, hedging | no need shown; hedging doubles quota burn |
| Upstream idle timeout | no observed hang; client disconnect already aborts; would cut long non-streamed answers |
| Jitter | single client, no herd |
| Account rotation to stretch limits | the ban pattern (user's own category 4); one primary account at a time instead |
| Midjourney, Suno, Sora | no API / forbidden / shut down |
| Subscription sign-ins for media | E12, E15 |
| Live voice (realtime/WebSocket) | not requested |
| Swarm skill, bridge plugin, SECURITY.md/CHANGELOG | AGENTS.md covers swarms; no outside users yet |

## Acceptance criteria

H1 Live: `scout`, `architect`, `reviewer` each answer "ok"; `dsh verify` ready.
   **MET 2026-11-18 13:29** (E22).
H2 Live: `list_subagent_models` lists providers, or the cause is found and
   recorded as a DSH limitation. **MET 2026-11-18** (cause found): DSH records
   the allowed routes once per top-level session
   (`dsh-tool-subagent/src/model-selection-settings.ts:57-74`). The session
   records show it: sessions started 12–16 Nov hold `droidproxy-*`, the two
   started after the profile changed (16 Nov 16:21, 18 Nov 11:45) hold
   `dshproxy-*`. Not a DSHProxy defect; a new session has the right list.
S1 Swarm load test: 8 then 16 parallel `scout` calls produce no 429 and no
   failed upstream call. A failure adds a per-lane concurrency cap to the
   plan; a pass keeps it out. **MET 2026-11-18**: 24 x 200, 0 failures.
R1 For `balanced` and `performance`, every role lane resolves ≥ 1 rung when
   (a) only Claude is available and Fable cools, (b) only GPT is available
   (reviewer and `cheap`: (a) only; `google` exempt). Red on base.
R2 Live: one request id appears once in the backend log per upstream 429.
R3 A forced pick whose provider gave a reset (Retry-After, `resets_at`, or an
   allowlisted usage window exhausted on every enabled account) beyond the
   retry budget returns the provider's error after one upstream call:
   < 1 s (header), < 5 s (usage window). A bare 429 with no known reset still
   retries (`gateway.test.js:427` stays green). **MET 2026-11-18**: forced
   `gpt-6-astra` answered 429 in 0.9 s after one call. `resets_at` in a 429
   body is not read (cut: ChatGPT sends Retry-After).
R4 Usage-window cooling lasts min(reset, 1 h) and re-checks; unknown windows
   ignored; other families unaffected. **MET** (tests).
R5 `dsh verify` flags a tool pin / `allowedModels` entry on a missing
   `dshproxy-*` route or absent model as not ready. (A paused or signed-out
   account removes its models from the route, so it shows the same way.)
   **MET 2026-11-18**: flags the pre-fix profile backup, passes the current one.
G1 ≤ 10 own backups per profile file, newest by name stamp; foreign untouched;
   failed rename leaves no `.tmp`. **MET 2026-11-18**: 10 own backups in each
   profile; read-only-profile test red on base, green with the fix.
G2 AGENTS.md names only existing routes (user-approved). **MET 2026-11-18.**
G3 MIT LICENSE + Windows CI (check + tests) green on GitHub (user-approved push).
M1 Spike: one image (OpenRouter), one image edit (OpenAI if keyed), one 4 s
   video draft — request/response shapes recorded as fixtures; cost < $1.
M2 From DSH: `generate_image`, `edit_image` save files + provenance sidecar
   into the workspace.
M3 From DSH: `generate_video` returns a job; `await_video` delivers MP4;
   `web_video` emits muted loop WebM + MP4 + poster within a size budget.
M4 Spend guard: a call that would exceed the daily cap is refused before any
   upstream request; expensive tiers need explicit `quality: "final"`.
A1 With two active accounts of one provider that both have quota, every
   selection in the backend log is on the user-chosen primary. When the
   primary is exhausted the second takes over with at most one failed
   upstream call per cooldown period. Auth files are never edited by hand.
   README states the terms-of-service position. **MET 2026-11-18**: Haiku on
   the primary; with its Fable limit used up, Fable goes to the second
   account with 0 refused calls (was 1 per new conversation).
A2 An account out of one model family is told not to serve it
   (`excluded_models`) while another active account still has it, and only
   then; a model nobody else has is never excluded. An account out of quota
   altogether steps aside. Both are lifted a minute after the reset, on a
   change of accounts, and when the choice is taken back — also from the
   command line while the gateway is stopped. **MET 2026-11-18** (tests and
   live), except "steps aside" and "lifted after the reset", which are
   covered by tests only: neither has happened live yet.
X1 All existing tests pass unmodified; each new behaviour has a test that
   failed on base for the expected reason (config constants verified live).
   **MET with two stated exceptions**: `catalog.test.js` and
   `backend.test.js` each had one assertion changed because the
   `requestRetry` setting was removed (criterion R2 asks for that).
M1–M4 are parked with Phase 4 (user: "hold off").
