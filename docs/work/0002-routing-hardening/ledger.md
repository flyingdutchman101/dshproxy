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

## 2026-11-18 14:45 — Phase 1 core, hygiene and review (user: "OK to edit everything")
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

Live after restart (14:40):
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
