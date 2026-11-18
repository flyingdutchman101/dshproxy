# 0002 — DSHProxy master plan (v4)

Written 2026-11-18 13:30, after the quick fix. Replaces v1–v3 (history in
`ledger.md`). Evidence and acceptance criteria are in `spec.md`; this file
says what gets built, in what order, and how each step is proven.

## Goal

1. Every model route DeepSeek Harness uses answers, or fails within seconds
   with the provider's own reason. No hangs, no retry storms, no wiring that
   breaks silently.
2. DSHProxy is a well-behaved client: one upstream call per request, one
   account at a time per provider, no bursts.
3. DSH can make images, video and web-ready animation through API keys,
   under a spending cap.

## Rules every slice follows

- A forced model pick is never substituted. Lanes fail over.
- One layer owns retries (the gateway). The backend tries each request once.
- When the provider says when quota returns, stop asking until then.
- One account per provider serves at a time; the next takes over only when
  the first is exhausted. No rotation.
- Media goes through API keys only.
- Nothing is built without observed evidence that it is needed.
- Every code slice: failing test first, then the fix, one commit per slice.
- Nothing is pushed, and `AGENTS.md` is not edited, without the user's OK.

## Phase 0 — Quick fix (DONE 2026-11-18 13:29)

| Change | Proof |
|---|---|
| `scout`, `architect`, `reviewer` tools point at `lane-scout`, `lane-architect`, `lane-reviewer` in both DSH profiles | all three tools answered "ok"; `reviewer` used to fail instantly |
| `allowedModels`: 3 dead Google entries removed, 5 lanes added | `dsh verify`: desktop ready, web ready |
| Architect lane: dead Google rung replaced by `claude-opus-5-5` | `lane-architect` 200 |
| Original Claude account paused; the new one serves alone | log: 6 of 6 selections on the new account (was 6 / 7 split) |

Rollback: profile backups `cordis.patch.yml.quickfix-20261118T122652435.bak`;
lane via `lanes/replace`; account via Accounts → Resume.

Left open by the quick fix:
- ~~Resume the original Claude account~~ — done 2026-11-18: resumed and made
  primary (Phase 2).
- ~~`list_subagent_models` returns "no LLM providers"~~ — explained
  2026-11-18 (P1-d): true only for sessions created before the profile
  changed.
- ~~The preset shows "Custom"~~ — Balanced re-selected 2026-11-18.

## Phase 1 — Reliability core

Status 2026-11-18 14:20: P1-a, P1-b, P1-c and gate S1 are DONE, reviewed by
DeepSeek and running live (commits `1fdea80`..`951eff1` on local `main`).
P1-d: DONE — cause found and confirmed from the session records (a session
keeps the routes it was created with); no code change. Details and
evidence: `ledger.md`.

### P1-a  Lanes survive one exhausted quota pool (~1 h)
- Test (fails today): for `balanced` and `performance`, every role lane
  still has a rung when (a) only Claude is available and Fable is cooling,
  (b) only GPT is available. `cheap` and `reviewer` check (a) only: both
  leave GPT out on purpose (`settings.js:10-12`, `catalog.test.js:14`).
- Fix: add the missing rungs to the shipped ladders (architect
  `+claude-opus-5-5`, scout `+gpt-6.1-sol`). User re-selects the preset once.

### P1-b  Quota-aware failure (~0.5 day)
Fixes the 4-minute hang (E2), the 4 backend calls per GPT 429 seen again
today (E5), and the 6-hour cap on a 18-hour reset (E6).
1. Backend always renders `request-retry: 0`; the `requestRetry` setting is
   removed. The backend still tries every account of a provider within its
   single round (E16).
2. Each cooldown records where its end time came from: the provider
   (Retry-After header, Codex `resets_at`, a usage window) or the 10-minute
   default.
3. Usage windows: read from the 60-second cache, only when a 429 arrives.
   Counted: account-wide `5-hour`, `Weekly`, `Weekly (OAuth apps)`, and
   family windows matched by whole word (`Fable`, `Opus`, `Sonnet`,
   `Haiku`). A model cools only when the window is fully used on every
   active account, until min(reset, 1 hour), then re-checked.
4. A forced pick stops retrying only when the end time came from the
   provider and lies beyond the retry budget. A bare 429 keeps the existing
   2/5/12/20 s retries (`gateway.test.js:427` stays green).
5. Provider-given cooldown cap: 6 h → 24 h.
- New seams: `createGateway({ now, quotaReset })`; `source` on failover
  verdicts. Tests use a fake management call and an injected clock, with a
  captured, scrubbed usage payload as fixture.

### P1-c  `dsh verify` checks tool wiring (~1 h)
Reads `insert[].config.agentOptions` and `allowedModels` in any order. A
pin or entry on a missing `dshproxy-*` route or absent model is "not ready";
an account that is paused or out of quota is a warning. This would have
caught today's broken `reviewer`.

### P1-d  Subagent model selection (~1 h, investigate first)
`list_subagent_models` returns nothing and explicit `provider`/`model`
subagents are refused, although `allowedModels` is valid. Read the DSH
plugin's config schema (`dsh-doc`), retest after a DSH restart, then fix the
profile or record it as a DSH limitation. Matters because a review by a
different model family needs an explicit route.

### Gate S1 — swarm load test (30 min)
8 parallel `scout` calls, then 16, each reading one file. Record 429s,
failed upstream calls and latency from the gateway log. Passes when there
are no 429s and no failed calls. If it fails, a per-lane concurrency cap
enters the plan with that evidence; otherwise it stays out.

## Phase 2 — Two accounts with one provider

Status 2026-11-18 14:50: P2-a, P2-b and P2-c are DONE, reviewed by DeepSeek
and running live (`a624156`..`b666b3c` on local `main`). P2-b was solved
differently from the text below: a used-up account steps aside by priority;
an account out of one model family is told not to serve it; backend cooling
stays off. Final state `84551d5` (15:35), three DeepSeek reviews. See
`ledger.md`.

**Everything in Phases 0–3 is done and pushed. Phase 4 is parked (user:
"hold off").**

Live since today: two Claude accounts.

- **P2-a Primary account.** The backend reads a per-account `priority`
  (binary: `AuthFilePriorityAttribute`, route `auth-files/fields`). First
  step is a 15-minute check against the running backend: set priority on one
  account through the management API, confirm with `GET auth-files`, confirm
  in the log that selections go to it. Then: "Make primary" in the Accounts
  tab and `dshproxy accounts primary <file>`. The auth files are never
  edited by hand.
- **P2-b Exhausted primary.** With backend cooling switched off (as today),
  an exhausted primary costs one failed call per request before the second
  account answers. Measure it; if present, enable the backend's per-account
  cooling for quota errors only. P1-b's "every active account" rule already
  holds.
- **P2-c README.** Several plans the user owns are supported; one serves at
  a time; Google stays off. States the terms-of-service position (E12).
- Done when: with both accounts active and healthy, the log shows every
  selection on the primary; when it is exhausted, the second takes over
  with at most one failed call per cooldown period.

## Phase 3 — Hygiene

Status 2026-11-18 14:20: P3-a, P3-b and P3-c are DONE locally. Pushing P3-c
(LICENSE + CI) to GitHub waits for the user's OK.

- **P3-a Backups.** Keep the newest 10 of DSHProxy's own backups per profile
  file (sorted by the stamp in the name), leave foreign ones alone, remove
  the temp file when a rename fails. 249 backups exist today.
- **P3-b `AGENTS.md`** (needs OK). Replace the deleted `droidproxy-*` routes
  with the lane tools; drop the manual failover steps. Diff shown first.
- **P3-c LICENSE + CI** (needs OK to push). MIT. `windows-latest`, Node 22
  and 24, `npm ci --ignore-scripts`, `scripts/check.js`, `node --test`.

## Phase 4 — Media for the web (~2.5 days, needs keys)

- **P4-0 Spike** (30 min, under $1). Record real request/response pairs as
  test fixtures: OpenRouter image, OpenRouter video job (create, poll,
  download; a 4-second draft), OpenAI image edit if keyed. Settles whether
  image requests go through the backend or straight from the gateway.
- **P4-1 Gateway** (~1 day). Image flag for custom-endpoint models; fix the
  false `dshproxy_no_image_rung` on JSON image edits; video job adapter
  (keys stay inside DSHProxy, job state survives a restart); spend guard
  (price table, daily cap checked before any upstream call, `draft` by
  default and `final` only on request).
- **P4-2 DSH media tool** (~1 day). A small MCP server in this repo:
  `generate_image`, `edit_image`, `vectorize`, `generate_video`,
  `await_video`, `web_video` (ffmpeg: muted looping WebM + MP4 + poster
  within a size budget). Files land in `<workspace>/assets/generated/` with
  a sidecar recording prompt, model and cost.
- **P4-3 Web animation guide** (~2 h). When to use code animation (SVG +
  CSS, GSAP, Lottie JSON written by the chat model) and when a video loop.

## Order

```
Phase 0  done
Phase 1  P1-a → P1-b → P1-c → P1-d → S1        can start now
Phase 2  P2-a → P2-b → P2-c                    after P1-b
Phase 3  P3-a any time; P3-b, P3-c on OK
Phase 4  P4-0 → P4-1 → P4-2 → P4-3             after keys (D2)
```

Building: Claude (new account, 86 % weekly) can start Phase 1 today. GPT
returns Thu 19 Nov 07:08. Each phase is merged only after a review by the
other model family: GPT reviews what Claude built, and the reverse.

## Decisions

| | Decision | Status |
|---|---|---|
| D1 | Use reset credits | **No** (user, 2026-11-18) |
| D2 | Media keys: OpenRouter (required), OpenAI and Recraft (optional); daily cap (suggested $5) | **hold off** (user, 2026-11-18, twice); Phase 4 waits |
| D3 | Account safety: keep subscriptions, move chat to API keys, or mix per lane (E12) | **keep subscription sign-ins** (user, 2026-11-18: "definitely sub signins") |
| D4 | Which Claude account is primary once both are active | **old account primary, new one secondary; use the one that has usage** (user, 2026-11-18) |
| D5 | OK to edit `AGENTS.md` (P3-b) | **yes**, done 2026-11-18 |
| D6 | OK to push LICENSE + CI (P3-c) | **yes**, pushed 2026-11-18; CI green |

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| P1-b switches off the retry for short throttles | provider-source rule; existing test must stay green |
| A wrong usage window benches a model for days | explicit window list, every-account rule, 1-hour re-check |
| The usage endpoint itself rate-limits (seen today on forced refresh) | cache only, never forced; error falls back to the 10-minute default |
| `request-retry: 0` breaks multi-account failover | backend's single round still tries every account (E16); P2-a log check |
| Per-account priority works differently than the binary suggests | P2-a starts with a live check before any code |
| Media request formats differ from the docs | P4-0 records real fixtures first |
| Runaway media spend | cap checked before the call; draft by default; cost sidecar |
| Keys leak to DSH or the MCP server | the tool only talks to DSHProxy; keys stay encrypted there |
| Builder and reviewer from one model family | merge gated on the other family's review |
| Paused account forgotten | listed above under "Left open"; P2-a removes the need to pause |

Not in this plan, with reasons: see "Rejected" in `spec.md`.
