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
