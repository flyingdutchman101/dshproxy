# DeepSeek Harness gateway — ledger

## State (2026-11-15)

First version written, reviewed and committed locally. Not pushed. Not applied to the real DeepSeek Harness profiles. No real account has been signed in through it.

## Rulings

- No fork of CLIProxyAPI or DroidProxy — because the backend changes daily and nothing in the Windows app depended on the DroidProxy sources — cost if wrong: a fix that needs backend internals has to go upstream or into a plugin.
- Lanes replace Auto routing — because DeepSeek Harness already names its lanes and ladders in its working defaults — cost if wrong: task-type and quota-aware routing would have to be added to the gateway.
- Separate ports (8417, 8418) and a separate auth folder — because the existing app must keep running unchanged — cost if wrong: each subscription has to be signed in a second time.
- The `Anthropic-Beta` rewrite and thinking-block removal were not carried over — because two single-turn probes showed no difference with and without them — cost if wrong: Claude requests fail or lose visible thinking in long tool-using conversations, and the rewrite has to be added to `src/gateway/request.js`.
- A rejection is judged by its text only when another rung could take the request, and only up to 64 KB — because reading every reply would delay streaming — cost if wrong: an oversized error body is returned instead of failing over.
- No time limit on a reply — because a model can think for minutes without sending anything — cost if wrong: a backend that stalls with the connection open holds the request until the client gives up.
- No backup copy of the DeepSeek Harness credentials file — because a copy would be a second file holding credentials — cost if wrong: a bad write to that file cannot be undone from a backup. The file is now left alone unless it has the expected form, and is written through a temporary file.

## Review (GPT 6.1 Terra, commit 9df1a72)

The first reviewer (Gemini 4 Carbon) failed on HTTP 429 before reporting. The review ran on the next usable rung. No critical or high findings.

Fixed, each with a test that failed first:

1. A client that cancelled three times made a healthy model sit out for 10 minutes.
2. A reply cut off part-way left the client waiting forever.
3. A compressed "too long" rejection was not failed over.
4. A credentials file of an unexpected shape was overwritten.
5. A settings file that could not be parsed loaded as defaults, and the next save replaced it.
6. The request body had no size limit.
7. `dsh remove` left behind the plugin entry that `dsh apply` had added, and wrote profiles one by one.
8. Two backups in the same second overwrote each other.
9. Connection-level response headers were passed on; the `too many tokens` pattern was dropped as too broad.

Tests added for criteria the review found uncovered: the third server error at gateway level (3), a port held by another program (13), the API key through the real CLI (21), `dsh remove` by exact text (20).

Not changed:

- An installed backend is not re-verified, and two first-time starts can collide. Listed under Known limits in the README.
- `reclaimOrphan` after process-ID reuse: it stops a process only if it runs this gateway's own backend binary.
- An account whose token has expired still counts as available; CLIProxyAPI refreshes it.

## Evidence

- `npm test`: 128 tests pass. `npm run check`: 27 files.
- Real backend, after the review fixes: CLIProxyAPI 8.0.72 started on 127.0.0.1:8418; model list, an empty lane (503) and a real model without an account (the backend's 400, unchanged) all answered through the gateway; `stop` left no listener, process or pid file.
- Before the review fixes: checksum matched on download; Management paths returned 404; neither port answered on the LAN address; an orphaned backend recorded in `backend.pid` was stopped by the next `start` while VeryCuteDroidProxy's backend kept running.
- Profile sync: applied to a copy of the real `desktop` and `web` profiles. Every entry other than the `dshgate-*` routes was identical, and the comment count was unchanged.
- API key commands: a made-up key was saved, listed, offered as models and removed. It did not appear in `settings.json` or `master.key`.

## Real-account test (2026-11-16)

Signed in through the app: ChatGPT (weekly limit at 0%), Claude (weekly 22%), Gemini/Antigravity. No API key.

- Every model answered a one-word request in its own protocol (Claude 1 s, Gemini Flash 2 s, Gemini Argon 7 s, Gemini Carbon 13 s). GPT returned 429 "usage limit reached", matching its 0% limit.
- Every lane answered. `lane-main` moved past GPT and past `claude-fable-5-2` (429 "would exceed your account's rate limit") to Gemini Carbon; `lane-architect` moved past GPT 6.1 Terra to Gemini Argon. Each skip was logged with its reason.
- Streaming worked through a lane that failed over.
- 20 requests at once on `lane-scout`: all answered, median 0.9 s. 10 at once on `lane-main` (with failover): all answered, median 9.7 s. Gateway memory 115 → 117 MB.
- Two-turn tool call with thinking enabled: worked on Claude Sonnet, Gemini Carbon and Claude via Google; each conversation stayed on one model. Gemini returned thinking blocks; Claude returned none.
- Limits before and after differed by at most 0.2 points.
- `dsh apply` on the real `desktop` and `web` profiles: only the `dshgate-*` routes changed; backups written.

## Model discovery and backend updates (2026-11-16)

- Discovery against the real catalog and accounts offered 10 new models (claude-fable-5, claude-opus-5, claude-sonnet-5, gpt-6-sol, gpt-6-chat-thinking, gemini-4-hydrogen-xhigh, gemini-3-flash, gemini-3.1-flash-lite, gemini-3.5-flash-lite, gemini-3.8-flash-tiered); claude-opus-5, gemini-4-hydrogen-xhigh and gemini-3.5-flash-lite answered through dshgate. 26 served models stay hidden (image, older generations). DeepSeek Harness routes in `desktop` and `web` were re-applied automatically (both had dshgate routes).
- First trial against real binaries failed for both 8.0.72 and 8.0.75: the backend lists 0 models for its first seconds. Fixed by waiting up to 30 s for the model list; both then passed.
- Real update 8.0.72 → 8.0.75 through the control API: trial passed (ChatGPT 429 not counted), switched, restarted, lane-scout and claude-opus-5 answered. Real rollback to 8.0.72 worked; then updated to 8.0.75 again, which is what runs now.
- Review: first reviewer (Gemini 4 Carbon) died without output; second (Gemini 4 Argon) found no blockers and 8 should-fix items. Fixed with red-first tests: syncs run one at a time and record success only after writing; automatic syncs write only profiles that already have dshgate routes (and add no credential reference otherwise); update and rollback share one lock; rollback below the shipped version refused; updates start from the running version; no download without a restart path; release versions must be plain numbers and the checksum URL official; dated IDs not taken as newer; more old generations hidden; catalog context capped at 2M. Also: stop waits for the backend to exit, restart retries and falls back to the previous version, `dshgate backend rollback` works offline, the trial falls back to another model of the service when its probe model is not listed. Kept: the trial shares the real auth folder (a copy would rotate refresh tokens away from the running backend); the risk is documented in trial.js.
- Not done: a test that drives `runTrial` itself (it needs a real backend binary); checks are live-only.

## Not checked

- Any request served by a real model through the gateway. Failover was tested against a stand-in backend only.
- `login` for any provider.
- DeepSeek Harness loading the written routes.
- Claude thinking across several turns with tool use.
- Whether CLIProxyAPI compresses its error replies.
- A secret scan with gitleaks or trufflehog (neither is installed). A pattern search over the committed files found nothing.
- The review fixes themselves were not reviewed a second time.

## Next

1. Decide whether dshgate shares `~/.cli-proxy-api` with VeryCuteDroidProxy or gets its own sign-ins.
2. Sign in, run `dsh apply`, and send one request per lane.
3. Decide whether the DeepSeek Harness default model, delegation lanes and `allowedModels` should point at dshgate.
