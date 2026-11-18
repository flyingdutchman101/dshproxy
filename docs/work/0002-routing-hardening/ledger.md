# 0002 — Routing hardening: ledger

## 2026-11-18 — plan drafted
- State: spec + plan written; no code. Base `6e3d548`.
- Evidence gathered live (see spec E1–E10).
- Rulings: lean scope; 10 research items dropped as already built or unneeded.
- Next gate: stress test of the plan (adversarial review + targeted checks),
  then user approval.

## 2026-11-18 — stress test → plan v2
- Live probes: `reviewer` tool fails instantly (`pi-ai provider
  "dshproxy-compat" has no configured model "gemini-4-carbon-high"`) — E1
  confirmed. `list_subagent_models` returns "no LLM providers" in this web
  session although `allowedModels` is set — added to hotfix H checks.
- Backend docs (`config.example.yaml`): `request-retry` = extra credential
  rounds for 403/408/429/5xx, with `max-retry-interval: 30` s waits between
  rounds → up to 4 calls + 90 s hidden wait per request. Stored
  `settings.json` holds `requestRetry: 3` explicitly.
- Two fresh-context reviews (both Claude family — GPT out of quota, Google
  suspended; cross-family review not possible today). Findings adopted:
  S2 test could not be red; S4 rule broke `gateway.test.js:427`; GPT-first
  reviewer broke `catalog.test.js:14`; S5 window matching under-specified;
  S1 unverifiable before merge; S6 contradicted 3-strike rule → cut.
- Base suite: 241 pass (reviewer ran `node --test`).
- Live E2 probe (`architect` tool → `claude-fable-5-2`, exhausted): every
  DSH attempt took ~49 s (gateway sleeps 2+5+12+20 s on a bare 429), DSH
  repeated it ≥ 5× → ~4 min hang, ≥ 25 upstream calls, then failure.
  Log 2026-11-18T11:51–11:54Z. Strongest evidence for S4 + S5.
- Next gate (superseded by v3): user approval of v2 (H, S2, S8, S4, S5,
  S7; S3/S9/S10 need explicit OKs).

## 2026-11-18 13:15 — v3 consolidated re-review
- Inputs re-reviewed: routing/reliability/swarm/OSS research (4 workers),
  v2 stress test (2 reviewers), media research (3 workers), live checks:
  limits (Claude weekly 4 %, Fable 0 %, ChatGPT 0 % + 1 reset credit),
  backend multi-credential semantics, ffmpeg 9.0.2, gateway passthrough.
- Structural changes: S4+S5 merged (R-b); per-credential keying dropped
  (round 0 tries all credentials); A deferred to "built on demand"; media
  gets a fixture-recording spike before design freeze; account safety made
  an explicit user decision (Anthropic §3.7 / OpenAI terms).
- Review: self-review only (Claude weekly 4 %); cross-family review
  scheduled with GPT as builder / Claude as reviewer.
- Next gate: user decisions D1 (reset credit), D2 (media keys + cap),
  D3 (account safety), OKs for G-b/G-c; then Track 0.

## 2026-11-18 13:20 — user rulings + second Claude account
- D1 decided: no reset credits are used; Claude/ChatGPT reset on their own.
- User signed in a second Claude subscription (separate organisation).
  Live: account 2 weekly 86 %, Fable 99 % (reset 2026-11-22 20:00 local);
  account 1 weekly ~4 %, Fable 0 % (reset 2026-11-19 17:00).
- Live probe: `claude-fable-5-2` 200 (2.6 s), `lane-architect` 200 → Fable.
  Backend picked up the new credential without restart.
- Track 4 is now live, not hypothetical: backend renders `round-robin`, so
  requests alternate between the accounts and every pick of the exhausted
  account costs an extra upstream 429 before round 0 moves on.
- Note: forcing `limits?refresh=1` drew a 429 from account 1's usage
  endpoint — usage reads must stay on the 60 s cache (R-b already does).

## 2026-11-18 13:29 — quick fix applied (user: "make a quick fix")
Configuration only; no repository code changed.
- Lane: `lanes/replace` architect `gemini-4-argon-high` → `claude-opus-5-5`
  (HTTP 200). Preset now reads "Custom".
- Profiles (desktop + web), script `%TEMP%\cpa-eval\rewire-tools.js`, dry
  run then write, 11 edits each: three tool pins → `dshproxy-lanes/lane-*`;
  `allowedModels` −3 dead `dshproxy-compat/gemini-*`, +5 lanes. Backups
  `cordis.patch.yml.quickfix-20261118T122652435.bak`. `dsh verify`: ready.
- Account: original Claude account paused through control
  `accounts/disable` (measured before: 6 / 7 selections split, E20; after:
  6 of 6 on the new account). **To resume after Thu 19 Nov 17:00.**
- Live: lanes scout/architect/reviewer/main/builder and `claude-opus-5-5`
  all 200. DSH tools `scout`, `reviewer`, `architect` each answered "ok";
  log 12:27:55Z shows `lane scout` → Haiku and `lane reviewer` → Opus with
  41 tools, so DSH reloaded the profile without a restart (E22).
- Not fixed: `list_subagent_models` still empty (E23). GPT 429 on
  `lane-main` cost 4 upstream calls and a 6-hour cooldown (E24) — P1-b.

## 2026-11-18 13:30 — master plan v4
- `plan.md` rewritten as the master plan: Phase 0 done; Phase 1 reliability
  (P1-a..d + swarm gate S1); Phase 2 two accounts (primary by backend
  priority, live check first); Phase 3 hygiene; Phase 4 media.
- New versus v3: accounts moved from "on demand" to Phase 2 (live need);
  swarm question settled by a measured gate instead of an assumption;
  subagent model selection gets its own investigation slice; building can
  start on Claude today with merge gated on a GPT review.
- Review status: v4 is self-reviewed only. Phase 1 core (P1-a, P1-b, P1-c)
  carries the v2 stress-test fixes; P1-d, S1, Phase 2 and Phase 4 have not
  had an independent review.
- Open: D2 media keys + cap, D3 account safety, D4 primary account,
  D5 `AGENTS.md`, D6 push LICENSE + CI.

## 2026-11-18 14:20 — Phase 1 core, hygiene and review (user: "OK to edit everything")
Rulings: media keys not now (D2 deferred). Old Claude account is primary,
new one secondary; "use the one which has usage". Review with DeepSeek/Qwen.

Built on branch `hardening` (worktree `../DSHProxy-hardening`), each slice
red first, merged to local `main` by fast-forward. Not pushed.
- `1fdea80` P1-a lanes survive one used-up quota pool. Red: balanced/main
  and balanced/scout had no model left. Shipped ladders: main +Opus,
  architect +Opus, scout +`gpt-6-luna` (plan said `gpt-6.1-sol`; Luna is
  the light model, which fits a scout).
- `9e7f422` P1-b quota-aware failure. Backend `request-retry: 0`; setting
  `requestRetry` removed; cool-down `source`; provider cap 24 h;
  `limits.quotaReset` (Claude usage report, shared in-flight read); forced
  pick stops when the provider's reset lies beyond the pauses left. 15
  tests red on base. Two existing assertions changed on purpose
  (`catalog.test.js`, `backend.test.js`: the setting is gone, the value is 0).
  Cut: reading `resets_at` from a 429 body (ChatGPT sends Retry-After).
- `3395f11` P1-c `dsh verify` checks every `dshproxy-*` provider/model pair
  in a profile. Run against the pre-fix backup it reports the broken
  `tool-reviewer` pin and the three dead `allowedModels` entries.
- `ff2cad4` P3-a keep 10 own backups, sweep own stale `.tmp`. Cut: rename
  retry (not reachable through a public seam without mocking `fs`).
- `f9fc8ab` P3-c MIT LICENSE, `.github/workflows/ci.yml` (windows-latest,
  Node 22.x/24.x, actions pinned by SHA). Rehearsed from a clean checkout:
  `npm ci --ignore-scripts`, check, 264 tests pass.
- `951eff1` review fixes (below).
- P3-b `~/.dsh/AGENTS.md`: lane tools and "failover happens inside
  DSHProxy" replace the 10 `droidproxy-*` references. Backup
  `AGENTS.md.before-lanes-20261118.bak`. DSH reloaded it.

Independent review: `reviewer` tool, served by `deepseek/deepseek-v4-pro`
(gateway log; the author is Claude Fable, so a different model family).
No CRITICAL/HIGH. All five findings verified and fixed test-first:
1. MEDIUM performance preset reviewed with `gpt-6.1-terra` → DeepSeek; new
   test over every preset.
2. LOW slow usage lookup stretched the retry pause → the pause no longer
   waits for the lookup (the helper also had not passed `quotaLookupMs`).
3. LOW a late lookup could shorten a provider cool-down → the later end stands.
4. LOW `tidy` matched any `.dshproxy-*.bak` → only the stamp form.
5. LOW backup test depended on the calendar → fixture stamps in 2001.
Also from its residual risks: cool-downs are cleared when an account
changes or a limit is reset (a 24 h cool-down must not outlive a reset).
Not changed: usage reads share a promise without their own timeout (the
management call times out after 30 s; gateway lookups are capped at 4 s).

Gates on `main` (`951eff1`): `node scripts/check.js` 44 files OK;
`node --test` 269 pass, 0 fail, three runs. Identity scan clean; secret
scan hits only the two synthetic keys in `test/cli.test.js`.

Live after restart (14:15):
- backend config `request-retry: 0`.
- Forced `gpt-6-astra`: 429 in 0.9 s, log "out of quota until about
  19. 11. 2026. 07:08:41; not retrying". Before: ~39 s of pauses and 4
  upstream calls per attempt (E6, E24).
- Three requests that reach GPT (forced pick, `lane-main`, `lane-builder`)
  cost one upstream failure in total; GPT cools until Thu 07:08 (the real
  reset), not 6 hours.
- Preset re-selected: Balanced. All five lanes 200. `dsh verify` ready.
- S1 swarm gate: 8 then 16 requests at once on `lane-scout`: 24 x 200,
  0 upstream failures, median 0.8 s. No concurrency cap enters the plan.
  (Tiny requests; a real swarm sends larger ones.)

Open:
- Push to GitHub (7 commits ahead) — needs the user's OK; CI first runs then.
- P1-d subagent model selection (`list_subagent_models` empty).
- Phase 2 primary account. Until then the old Claude account stays paused
  and must be resumed after Thu 19 Nov 17:00.
- Phase 4 media: waiting for keys (D2). D3 account safety: open.
- Worktree `../DSHProxy-hardening` and branch `hardening` are merged and
  can be removed.

## 2026-11-18 14:50 — Pushed; Phase 2 (two accounts) built; P1-d cause found
User: "Ok push then go next." Pushed `6e3d548..b6c28a7` after an identity
and secret scan of the outgoing diff. First CI run: success (Node 22 and 24).

Phase 2, on `hardening`, merged to local `main`, NOT pushed:
- `a624156` P2-a primary account. Setting `primary: { <provider>: <auth
  file> }`; `src/primary.js` `applyPrimary`; `management.setPriority`
  (`PATCH /v0/management/auth-files/fields {name, priority}`); control route
  `POST accounts/primary`; `GET limits` adds `primary` and `siblings`; the
  Accounts page shows a Primary chip and Make primary. 6 tests, red first
  (module missing).
- `0055d61` P2-b a used-up primary steps aside. Priorities: primary 10,
  the provider's other accounts 5, an account whose 5-hour or weekly limit
  is at 100% gets none until its reset (`limits.usedUp`). Applied 5 s after
  start, on a change of account, after a refused model, and one minute
  after the reset. Two assertions of `a624156` changed with the rule
  ("others get 0" became "others get 5").
- `b666b3c` review fixes.
- P2-c README section "Two accounts with one provider", with the terms
  position.

Backend facts used (source `v8.0.76`, read by a scout, then checked live):
selection takes the available credential with the highest priority; a
credential that answers 429 is skipped inside the same request; a
conversation stays bound to the credential that served it; the backend
keeps the priority across a restart (after the restart only the second
account needed writing).

Live (old account resumed and made primary, as the user ruled):
- 3 Fable requests in 3 conversations: each asked the primary first (429,
  its Fable limit is used up), then the second account answered in the
  same request: 3 x 200.
- 3 Haiku requests: all served by the primary.
- 3 Fable requests in ONE conversation: 1 refused call, then the
  conversation stays on the second account.
- So a model-scoped limit costs one refused call per new conversation
  until Thu 19 Nov 17:00. An account-wide limit costs none after the first
  refusal (the account steps aside). Not done on purpose: moving an account
  aside for one model would leave its other models unused.
- Plan deviation: P2-b said "enable the backend's cooling for quota errors".
  Not done: backend cooling would answer a forced pick with a made-up 429
  for up to 30 minutes, which breaks "a forced model is really tried".
- Cut: `dshproxy accounts primary <file>` CLI (the app and the control API
  cover it). No way in the app to clear a choice; choose the other account.

Independent review 2: `reviewer` tool (lane-reviewer; the log shows
`deepseek/deepseek-v4-pro`). No CRITICAL/HIGH/MEDIUM. Two LOW, both real,
both fixed test-first or by reading:
1. Choosing a Claude primary made usage reads go to every provider (also
   true of P1-b's lookup). `limits.read` takes `provider`; a narrower report
   is cached apart and never replaces the full one. New test, red first.
2. The timer set after an account change was not cleared on stop.
Not changed: a paused account can be recorded as primary through the API
(the app hides the button); settings load/save is not atomic across
concurrent control calls (as before).

Gates on `main` (`b666b3c`): check 46 files OK; `node --test` 280 pass,
0 fail, three runs. Scans clean. Daemon wiring has no automated test
(none exists in this project); it was checked live.

P1-d subagent model selection — cause found, no code change:
`dsh-tool-subagent/src/model-selection-settings.ts:57-74` records the
allowed routes once, when a top-level Session is created; subagents take
their parent's. `list-models.ts:66-70` prints "(no LLM providers)" when
none of the recorded providers is registered. This session was created
when the profile still named `droidproxy-*`, so its recorded list names
providers that no longer exist. The profile itself is correct (verify:
ready). To confirm: open a NEW session and call `list_subagent_models`.

Open:
- Push 4 commits (`a624156`, `0055d61`, `b666b3c`, this ledger) — ask.
- Confirm P1-d in a new session.
- Phase 4 media: waiting for keys (D2). D3 account safety: open.
- Worktree `../DSHProxy-hardening`: merged, can be removed.

## 2026-11-18 15:00 — Rulings; what is left
User: media "hold off" (Phase 4 stays parked). Account safety (D3):
"definitely sub signins" — subscription sign-ins stay; no move to API keys.
Push of the Phase 2 commits and removal of the worktree: not answered, so
neither was done.

Plan items delivered differently or not at all (all reported to the user):
- P1-a scout rung is `gpt-6-luna`, not `gpt-6.1-sol`.
- P1-b no reading of `resets_at` from a 429 body (ChatGPT sends Retry-After).
- P1-c no separate warning for a paused or used-up account.
- P1-d cause found by reading DSH source; not confirmed in a new session.
- P2-a no `dshproxy accounts primary` CLI command; the app's button was
  compiled but not looked at on screen.
- P2-b by priority, not backend cooling; the step-aside has not happened
  live yet; a Fable-only limit costs one refused call per new conversation.
- P3-a no removal of the temp file when a rename fails.
- X1 two existing assertions were changed on purpose (`requestRetry`).
- Review was by DeepSeek (the user's choice), not GPT as the plan said.

## 2026-11-18 15:35 — "Go. Don't stop until everything is finished."
Pushed `b6c28a7..13d64bd` (scans clean). Then closed every open point from
the previous entry except Phase 4 (parked) and the worktree (no answer).

Closed:
- **Make primary on screen.** `DSHProxy.exe --preview-limits <sample.json>`
  (synthetic accounts), captured with PrintWindow: "Primary" chip on the
  primary, "Make primary" on the second account, neither on a provider with
  one account. Added "Not primary" (the only way to take a choice back in
  the app); that button compiles but was not captured again.
- **P1-d confirmed.** Session files are concatenated zstd frames of JSONL.
  Event 5 of each top-level session is `subagent/model-selection-policy`:
  five sessions started 12–16 Nov 10:47 hold `droidproxy-*`; the two started
  16 Nov 16:21 and 18 Nov 11:45 hold `dshproxy-*`. Subagents copy their
  parent's. This session is one of the old ones. `list_subagent_models`
  itself was not run in a new session.
- **Refused call per new Fable conversation: gone.** Backend source
  (`v8.0.76`, read by a scout): a credential's `excluded_models` (patterns,
  `*` wildcard) removes those models from that one credential at once, via
  `PATCH auth-files/fields`; it is kept in the credential file and is not
  reported by `GET auth-files`. `limits.usedUpModels` gives
  `claude-<family>-*` for a model-scoped limit at 100%.
- **Account order is a tested module** (`createAccountOrder` in
  `src/primary.js`): priorities, stepping aside, exclusions, the check a
  minute after a reset, shared runs, retry with back-off (1, 2, 4 … 60 min).
  The daemon only wires it. 20 tests with fake backend, usage report and
  timers. The daemon wiring itself still has no automated test.
- **CLI**: `dshproxy accounts primary <provider> <account|none>`; `accounts`
  marks the primary.
- **G1 remainder**: a failed profile rename leaves no `.tmp` (read-only
  profile test: red on base with the leftover file, green with the fix).

Commits (hardening → main, fast-forward): `c906b1c`, `cacbe04`, `84551d5`.

Independent reviews 3 and 4 (`reviewer` tool; log: `deepseek/deepseek-v4-pro`):
- Review 3 of `c906b1c`: 1 HIGH, 2 MEDIUM, 4 LOW — all real, all fixed in
  `cacbe04`. HIGH: a choice taken back from the CLI while the gateway was
  stopped was never applied, because the backend keeps priorities in the
  credential file. Fix: no one-shot reset; every run reconciles all active
  accounts (a provider without a choice wants priority 0 and no exclusion).
  MEDIUM: lost reset on a failed run (gone with the fix; failed runs retry);
  stale record after sign-out/sign-in under the same file name
  (`order.forget()` on every account change). LOW: masked rename error,
  coalescing gap, no retry timer, CLI provider aliases.
- Review 4 of `cacbe04`: all seven FIXED; 1 new MEDIUM (accounts changing
  during a run could leave a stale record) and a residual (endless
  one-minute retry). Both fixed test-first in `84551d5`. That last commit
  (2 tests, ~15 lines) has not had its own independent review.

Gates on `main` (`84551d5`): check 47 files OK; `node --test` 303 pass,
0 fail, three runs (280 before this round). Scans clean.

Live on `main` build (15:30):
- Start: "Claude (m***) is out of claude-fable-* and is not asked for it
  until 19. 11. 2026. 17:00".
- 6 Fable requests in new conversations across three restarts: all served
  by the second account, 0 refused calls (before: 1 each). Haiku: primary.
- CLI while stopped: `accounts primary claude none` → next start logs both
  accounts "has no place in an order now"; choosing the old account again →
  next start restores primary, second, and the Fable exclusion.
- All five lanes 200; forced `claude-fable-5-2` 200; 8 at once on
  `lane-scout`: 8 x 200. One refused call in the whole run: GPT, once,
  because a restart forgets cool-downs (then skipped until Thu 07:08).
- `dsh verify`: desktop ready, web ready.

Known limits, on purpose:
- Stepping aside (whole-account limit) and lifting an exclusion after a
  reset have not happened live yet; first chance Thu 19 Nov 17:00.
- If DSHProxy is not running when a limit resets, the exclusion stays in
  the credential file until the next start (5 s after start).
- Exclusions and order are only kept for Claude; other providers' usage
  reports are not interpreted.
- A gateway restart forgets cool-downs: one refused call per used-up
  provider after each restart.

Open: Phase 4 (parked, D2). Worktree `../DSHProxy-hardening` is merged and
can be removed (asked twice, no answer, left in place).
