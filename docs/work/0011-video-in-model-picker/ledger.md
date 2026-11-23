# Video in the model picker: ledger

| Gate | Status | Evidence |
|---|---|---|
| V0 live shapes, code map, how the Harness calls a picked model | done 22 Nov | `evidence/krea-live-shapes.md`, `research/code-map.md`, `research/dsh-model-facts.md` |
| Spec, parts A and B frozen; C frozen with its brief | done | `spec.md`, `briefs/V3.md` |
| V1 (Krea live interface) built, reviewed twice | done 22 Nov | `reports/V1.md` |
| V1 live check: balance and free quotes | done 23 Nov 01:45 | below |
| V1 shipped | done 23 Nov 01:50 | `main` = `origin/main` = `e21520a`, CI success; code identical to the reviewed commit; the docs stayed on this branch |
| V2 (sign-in renewal) | partial, not shipped | worktree `video-renewal`; renewal switched off for the real store until a durable primitive exists |
| V3 (catalog by resolution, Flux 3, entries) | done 02:35; reviewed 02:46 (reviewer lane served by deepseek-v4-pro, author claude-fable-5-2): one low finding, fixed red-then-green by the lead | branch `video-catalog` `43edb1f` + `fd6a434`; 696 pass, bundle 50, check 76 files; `reports/V3.md` |
| Part D design (architect) | done 02:07 | `design-D.md` |
| Part D design review (reviewer lane, adversarial) | done 02:12: 1 critical, 2 high, 4 medium, 2 low; all ruled on | `design-D-amendments.md` |
| User's three product answers | done 02:12 | `design-D-amendments.md` |
| Part D frozen | done 02:20 | `design-D.md` + `design-D-amendments.md` (amendments win) |
| S1 one purchase per quote | done 03:05, verified by the lead (646 pass; one `submit` call site; journal opened only `wx` and append) | branch `picker-core`, `reports/S1.md` with the mutation runs |
| S2 everything that must not buy; ceiling; switch; rehearsal; rulings A10, A11 | done 04:00, verified by the lead (694 pass) | `reports/S2.md` with the mutation runs |
| S3a HTTP, stream, mount, child process, entry list (against fakes) | done 03:28, verified by the lead (759 pass) | `reports/S3a.md` |
| S3b real ops, wiring in `index.js`, hook in `src/daemon.js`, `picker` line in `command.js` | done 04:08 | branch `picker-build` |
| S4a profile apply/verify/remove, `videoExposed` | done 03:00, verified by the lead (659 pass, existing profile tests untouched) | branch `picker-profile`, `reports/S4a.md` |
| S4b callers pass the entries (`cli.js`, `daemon.js` sync, `app.js`), decisions 0005 and 0006 | done 03:35 | branch `picker-build` |
| Branch review, two reviewers | done 04:45: three low findings, all fixed | section below |
| Free rehearsal in the real Harness (needs the user: Apply, Harness restart, Krea sign-in) | not started | |
| Decision records replacing parts of 0002 and 0004 | not started | |
| Independent review of V3 and V4 | not started | |
| Live check with one paid clip (needs the user's go) | not started | |
| V5 (app Video page, after DPI) | not started | |
| Final checks, merge, push, Apply, Harness restart | not started | |

Next step: collect S2 and S3a; integrate on one branch from `video-catalog` (merge `picker-profile`, `picker-core`, `picker-edges`); S3b and S4b by the lead; branch review by the reviewer lane; ask the user for the go to merge, Apply and restart the Harness for the free rehearsal.

Scope ruling (user, 23 Nov 01:46, "Ok, do the work now!"): ship the Krea fix now, then the catalog and the picker entries as soon as they work; Krea auto-renewal and the app's Video page follow later.
## Rulings

- Ruling: the user's "Ok go 1-4" is taken as choosing quote-then-confirm for picker entries — because the lead recommended it in the message being answered and the user named no other — cost if wrong: one extra reply per clip until changed; it is a setting, not a structure.
- Ruling: the helper's schema check is narrowed to what protects the user (what is sent, that a preflight is a preflight, one paid request, drift in the fields DSHProxy sends) and stops refusing unknown keywords and tools — because the closed check refused the live interface outright and protected nothing that A1, A2 and A6 do not state — cost if wrong: an interface change in a field DSHProxy does not send goes unnoticed, which cannot change a request.
- Ruling: a top-level combinator in a model schema that the helper cannot evaluate (`anyOf` on `bytedance/seedance-2-5`, branches not recorded) is not a refusal — because the server validates the input on the free preflight, and a submit only ever sends the input its own preflight just accepted.
- Ruling: V2 runs in its own worktree beside V1 — because the files are disjoint and each run of the whole test suite would otherwise see the other's half-finished edits.
- Ruling: the app's Video page is a later slice (V5) — because it is in `app/DSHProxyApp.cs`, which DPI slices S2 to S5 rewrite one after another.

## Records

- Earlier records of today's live session, quotes and three paid jobs: `docs/work/0005-video-credentials/ledger.md` and `docs/work/0010-video-resolution-pricing/report.md`, both uncommitted in the worktree of branch `dpi-awareness`; to be committed there or moved here before any push.
## Live check after the user signed in again (2026-11-23, 01:45)

The gate table above is behind: V1 is built, reviewed twice and committed here (`dc1c737`); V2 is partial in worktree `video-renewal` (renewal switched off for the real store); V3 to V5 are not started.

- Sign-in: `dshproxy-krea status` says signed in, access valid until 02:44:13.
- Live install (`main`, without V1): `video quote seedance-2.5 krea --prompt ...` is refused ("Krea refused the request; the exact schema ..."), exit 1. This is the fault V1 fixes.
- This branch (with V1), same sign-in: `video balance krea` exit 0: plan PLAN-REMOVED; BALANCE-REMOVED units left (BALANCE-REMOVED plan, BALANCE-REMOVED purchased). `video quote seedance-2.5 krea --prompt "A red ball rolls slowly across a wooden table"` exit 0: preflight, 856 units, not estimated, affordable. Both free; no job was started.
- Still not run live with V1: a paid submit, a job status, a failed or cancelled job.
## Rulings, 23 Nov 03:10

- A10: the journal's first line is a header with its creation time; age is the later of header and file creation time; no valid header, no purchase. Because NTFS gives a file recreated within 15 seconds its predecessor's creation time (S1 concern 1).
- A11: an outcome or result file on disk means the quote is used, even when the journal has lost its line (S1 concern 2). The mutation evidence then rests on tests 2, 4 and 5 plus a test of the guard itself.
- Units are `krea_units`, `usd_micros`, `callirra_credits`.
- A job is reported whatever its entry's switch says; only quoting and buying need the entry on.
- HTTP body limit 32 MiB as in the design (the S3a brief said 1 MiB; corrected by message), and a non-streaming request gets one JSON message.
- S4a: `apply` refuses a model list that holds only video entries; a video id is never a chat model; doubt counts as exposed. Accepted as built.
- The Krea sign-in expired 02:44 (no renewal yet). Any live check, the rehearsal included, needs the user to sign in again.

## Integration, 23 Nov 04:10

- Branch `picker-build` (worktree of the same name), from `video-catalog`: merged `picker-profile` (S4a), `picker-edges` (S3a), `picker-core` (S1 + S2, 694 pass on its own).
- S4b by the lead, red then green: `app.snapshot` lists `video` apart from `models`; `dsh apply`, `dsh verify` and the gateway's sync pass both (`test/video-picker-callers.test.js`, through the real command on a throwaway profile).
- S3b by the lead, red then green: `picker/ops.js` (real quote, submit, status, one child each), `wired` and `mount` in `picker/index.js`, the hook in `src/daemon.js` (two lines; `src/gateway/server.js` untouched), `video picker` in `command.js` (`test/video-picker-wired.test.js`, 12 tests; one new test in `test/daemon.test.js` on the real gateway, which fails with `application/json` when the mount line is taken out).
- Decisions 0005 and 0006 written on the branch.
- Whole branch: `node --test` 876 pass, `check.js` 99 files, bundle 50 pass. No user path in the diff against `main` (47 files, 11,267 lines added).
- Free run with real child processes in a throwaway folder: a published-price quote for Wan 3.0 1080p on VideoRouter (77 ms, no network), and "Sign in to Krea" for a Krea entry (the sign-in expired 02:44). No purchase has ever been made through this code.
- S2 concerns ruled: dollars rounded up at the fourth decimal stays (the shown amount is never below the cap sent); the ceiling counted in journal order stays (first claims win; the literal design let six at once refuse each other); a reworded compaction request without a mark gets a free quote and cannot buy (accepted, in 0005 as data sent to a provider only when taken for a prompt); folders made by S1 code never existed outside tests.
- S3a concerns ruled: a query string on the messages path is accepted (the application may add one); other pre-request refusals count as unknown for a purchase (the safe side); the purchase child is not detached, so a gateway killed with its process tree mid-purchase leaves an unknown outcome.
- Two reviewers (reviewer lane) dispatched 04:10 on the whole branch: purchase safety, and HTTP, mount, profile, callers.

## Branch review, 23 Nov 04:45

- Two reviewers on the reviewer lane, served by `deepseek/deepseek-v4-pro` per the DSHProxy log (authors: `claude-fable-5-2`). Cross-family.
- Purchase safety: no critical, high or medium finding. Two low: a claim record accepted a time before 1970 (would fall out of the ceiling); the record accepted caps of nine digits where the command takes six for dollars and credits. Both fixed, each with a test that failed first (`test/video-picker-store.test.js`).
- HTTP, mount, profile, callers: one low: the signal that says the client left was dropped in `index.js`, so an abandoned confirmation was followed with status checks for twelve minutes (48 checks in the failing test). Fixed: the signal reaches the flow; a client gone before the claim buys nothing and leaves the quote open; from the claim on, leaving does not stop the one order.
- Residual, accepted and in decision 0005: a program with file access can edit a stored quote or the settings; a reworded application frame without any mark gets a free quote; key variables pass through the gateway's environment to the child.
- The purchase reviewer ran 83 of the picker tests, not the 500-sequence and the multi-process tests; the lead ran those three times after the fixes (36 pass each) and the whole suite: 880 pass, `check.js` 100 files.
- Head of `picker-build`: `14e874a`, 12 commits ahead of `main` (`e21520a`), 0 behind; none of the user's three uncommitted files is touched.
- Next gate: the user's go to merge and push. Not verified anywhere: the route loaded in the real application, a paid job, a live Krea quote through the picker (sign-in expired 02:44).

## Renewal (V2), 23 Nov 12:20 to 12:45

- User, 12:19: "whenever proxy turns on and off, Krea unconnects". Measured: sign-in file written 08:53, gateway running since 08:56 without a restart, helper `status` says signed out at 12:20. Cause is the one-hour token, not the restart.
- User, after being told the cost (a longer-lived credential on disk, a recorded rule reversed): "Ok, see if possible. This needs mto be permanent. Do renewal and push with picker". This is the go for renewal, for the stored renewal token, and for merging and pushing renewal and picker together.
- Seen at Krea today, without credentials: public metadata lists `refresh_token` among the grants; a dynamic registration asking for it was accepted (201, public client, grants echoed). One stray client record now exists at Krea from that probe. Not seen: whether a sign-in then carries a renewal token, and how long one lasts.
- Ruling, replaces the 22 Nov ruling "fail closed until a durable anti-replay primitive exists": that ruling protected against sending an old renewal token twice, whose worst outcome is Krea refusing it, which is a new sign-in. It bought that at the price of a lock no one could recover and of a sign-in lost on any network fault. For a sign-in that must be permanent the trade is wrong. New policy: no pending marker; 400/401/403 drops the renewal token; anything else changes nothing and the next call retries; the lock is `withLock` (holder identity, dead holder taken over at once); login holds no lock at the consent page; the file is fsynced before it replaces the old one; `status` renews.
- Built by the lead on `picker-build` as `3d416aa`, from the worker's uncommitted V2 in worktree `video-renewal` (left there untouched). Red: 16 of 18 new tests fail against main's helper. Green: 30 of 30 in the three Krea sign-in test files; whole suite 898 pass; `check.js` 102 files. Six mutations each caught by named tests.
- Decision 0007 written on the branch.
- Reviewer dispatched 12:45 on `3d416aa` alone (`renewal-review-2`).
- Next: fix findings, merge `picker-build` into `main`, push, watch CI. Then the user signs in once (the sign-in on disk has ended and has no renewal token), and `status` shows `canRenew`; an hour later a free call shows whether it renewed.

## Shipped, 23 Nov 12:57

- Renewal review (reviewer lane): no critical or high. One medium: a renewal could hold the lock longer than the 30 seconds after which a live holder's lock is taken over, and the helper then refused could overwrite the other's renewal. Three low: renewed tokens under two minutes refused; an unreadable file under the lock read as signed out; `status` could outwait the app's 20 seconds. All four fixed in `0fc014f`, each with a test that failed first (`withLock` takes `staleMs`; the session lock uses two minutes; a refused helper re-reads before dropping the renewal token; `status` waits 5 seconds for the lock).
- `main` fast-forwarded to `picker-build` and pushed: `e21520a..0fc014f`. The user's three uncommitted files were not touched (hashes equal before and after).
- CI on `0fc014f` failed: the six process tests of the renewal each ended after 10 seconds, the helper's limit for PowerShell data protection, which the build machine exceeded. Fixed in `720bd6a`: the store takes the key wrapper as an option and those tests use a stand-in. The real protection was run once locally afterwards in a throwaway folder (renewed and read back in 866 ms). CI on `720bd6a`: success, both Node versions. Note for later: a cold PowerShell start over 10 seconds would also fail a real helper call; not seen on this machine.
- Whole suite at `720bd6a`: 904 pass locally.
- Live install after the merge: `dshproxy video picker` answers (purchases off, ceilings 10 / 15,000 / 20.00 / 2,000, nothing used); 0 of 41 entries on; Krea `status` is `{signedIn:false, canRenew:false}`. The running gateway (started 08:56) still has the old code: it has no video path, and its sync pass would remove a video route from the profile. It must be restarted before Apply.
- Not verified: a real sign-in with the new helper (does Krea hand out a renewal token; does it renew after an hour); the route in the real application; any paid job.
- Waiting for the user: restart the gateway, sign in to Krea, choose entries, Apply, restart the application, rehearsal.

## Live, 23 Nov 13:43

- User restarted the gateway (started 13:42:15, new code: the log shows `video picker: refused a request (not_found, HTTP 404)` for a GET on the video path) and signed in to Krea at 13:42:49.
- Helper `status`: `signedIn: true`, ends 14:42:49, `canRenew: true`. Krea does hand out a renewal token at sign-in. Not yet seen: a renewal after the hour.
- On the user's word ("Switch all available on krea on") the 12 Krea entries are on; 0 others. `dsh verify`: route `dshproxy-video` missing in `desktop` and `web` until Apply.
- Waiting for the user: Apply, restart the application, rehearsal; after 14:43 a look at the sign-in state to see whether it renewed.

## The picker in the real application, 23 Nov 13:45 to 14:55

- First use by the user. Two faults. (1) After a model change the quote showed the Harness's `[model changed: ...]` unit as the prompt. (2) Every `yes` was refused with the "a profile lets agents pick the paid video route" sentence, while `dsh verify` said ready.
- Cause of (2), seen with a temporary diagnostic in the gateway (removed again, never committed): at the confirmation the `desktop` profile's default model was the picked video entry (gateway log, 14:09:31, `desktop: video-default`). Read in the Harness source (0.2.2-rc.5): `selectModel` saves every picked model as `agent-default-model`; no setting prevents it. The design's rule "no new session may start on a paid entry" therefore made buying impossible. `verify` said ready because the user had picked a text model again by then.
- One clip was bought outside the picker, on the user's click in a question dialog: `dshproxy video submit seedance-2.5 krea --resolution 480p --max-units 380.333334`, job `JOB-ID-REMOVED`, completed, 380.33 units charged (balance BALANCE-REMOVED to BALANCE-REMOVED). The user then said they wanted to submit it themselves through the picker.
- Read in the Harness source before changing the guard: a subagent without a model takes its parent's last route, not the default; lane tools are pinned; a delegated prompt has guidance text appended and a later agent message arrives as `Agent NAME sent a message: ...`, so neither is ever a bare `yes`; a scheduled prompt carries `[SCHEDULE REMINDER]`; a subagent's session reminder has the required line `You are a subagent delegated by agent "..."`. Not tried live.
- Ruling (decision 0008 on the branch): the default model itself no longer counts as the route being open to agents; everything else still does; a conversation whose reminder says subagent gets no quote and no purchase; the model-changed unit is not the prompt. `apply` still sets a lane.
- Built on `picker-build` as `7055005`. Red first: the guard returned true for a picked default; a subagent's prompt was a `prompt`; the quote showed the model-changed unit. Green: `node --test` 911 pass; `check.js` 104 files. Seven mutations each caught by named tests. Six assertions in `test/profile-video.test.js` that pinned the old rule were changed with the rule.
- Reviewer dispatched 14:55 on `7055005` (`picked-default-review`). Purchases from chat are off. Not merged, not pushed, not deployed.
- Next: fix findings; merge to `main`; push; CI; the user restarts DSHProxy; purchases on; the user picks Seedance, types the scene, checks the quote, replies `yes`.

## Picked default shipped, 23 Nov 15:15

- Review of `7055005` (reviewer lane, says DeepSeek family): no critical, high or medium. Three low. Fixed in `8efe918`, tests red first: only an `agent-default-model` that is one of the profile's own entries is the default (a mapping with that id inside a tool row or the allowed models is not); a subagent's reminder is recognised when split over text blocks or with text before it. Not changed: a person who types exactly the model-changed notice as the whole prompt gets "no message"; accepted.
- Found while fixing: the first pattern for the reminder took 45 seconds on a hostile 2 MB text. Replaced by one pass with `indexOf`; the same texts take under 5 ms.
- `main` fast-forwarded and pushed: `720bd6a..8efe918`. The user's three uncommitted files untouched (hashes equal). CI on `8efe918`: success. `node --test` locally: 914 pass.
- Renewal seen working: signed in by hand at 13:42:49 for one hour; the sign-in file was rewritten at 14:40:56 with no sign-in by the user, and `status` at 15:14 says signed in until 15:40:56, `canRenew: true`.
- Purchases from chat switched on at the user's request ("enable me to do a live test. Push everything live"). Ceiling 10 clips, 15,000 Krea units per 24 hours.
- The running gateway was started 14:07:45 and has the old code. It must be restarted before the picker works.
- Not verified: a purchase through the picker in the real application; the subagent wording against a real subagent request.
- Waiting for the user: restart DSHProxy; pick Seedance; type the scene; check the quote; reply `yes`.

## Bought through the picker, 23 Nov 15:28

- The gateway was restarted at 15:23:20 and runs `8efe918`.
- The user's own test in the application, 15:25 to 15:28: picked Seedance 2.5 at 480p in the model picker, typed the scene, got a quote that showed the scene as typed, replied `yes`. One clip was bought: quote `Q-R84FZKFAAP5CDH5P`, job `JOB-ID-REMOVED`, about 380.33 Krea units, done after 2 min 24 s. This is the first purchase through the picker in the real application.
- The clip was downloaded for the user to the Downloads folder: H.264, 854×480, 24 fps, 5.06 s, 2,310,399 bytes.
- Seen in use: while a video entry is the picked model, every message typed goes to the picker and comes back as a quote. Nothing was bought from such quotes. New chats start on the picked entry until a text model is picked (decision 0008).
- Still not verified: the subagent wording against a real subagent request; how long Krea honours a renewal token.
- Open: nothing. The change is in `main` and on GitHub.