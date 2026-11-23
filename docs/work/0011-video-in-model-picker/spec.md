# Video models by name, resolution and provider, in the chat model picker

Requested 2026-11-22 15:43 and confirmed 15:50 ("Ok go 1-4"): fix the Krea route, make the Krea sign-in renew itself, add Flux 3 and a price per resolution on every route with a Krea balance readout, and show video models in the DeepSeek Harness chat model picker as "name - resolution - via provider" (the user's example: "Seedance 2.5 - 768p - Krea.ai").

## Where it stands

- The Krea sign-in works with the user's PLAN-REMOVED plan (first live session today). The shipped helper cannot quote, submit or check a job: it was tested against synthetic answers that do not match the live interface. Three paid clips were made with one-off scripts. Everything observed is in `evidence/krea-live-shapes.md`.
- The sign-in lasts one hour and cannot renew: the helper registers for the `authorization_code` grant only, while Krea lists `refresh_token`.
- The catalog holds four models at one resolution each. Prices at 480p, 720p (768p for MiniMax H3) and 1080p for every route were collected today (`docs/work/0010-video-resolution-pricing/report.md` on branch `dpi-awareness`, with the lead's checks against the providers' pages).
- Video models are not chat models today. Decision 0002 says video jobs never go through the chat gateway, because a retry after an ambiguous timeout can buy two jobs; decision 0004 keeps paid generation from DeepSeek Harness on the Krea route. The Harness reaches video through four tools of the bundle `integrations/dsh-video`.

## Goal

1. **Part A, Krea route works.** Quote, submit, status and balance work against Krea's live interface for the models DSHProxy offers.
2. **Part B, sign-in renews.** A Krea sign-in stays usable without a new consent for as long as Krea lets a refresh token live.
3. **Part C, models by resolution.** The catalog knows, per model, per resolution and per route, whether the combination exists and what the reference clip costs; Flux 3 is a fifth model; every command and both Krea and API transports take the resolution as a parameter.
4. **Part D, picker entries.** Enabled combinations appear in the DeepSeek Harness chat model picker, named "Model - resolution - Provider". Picking one and typing a prompt gives a quote; a confirming reply generates one clip and returns its link.

## Non-goals

- New providers. Protoface was priced today and is not a route.
- Durations other than 5 seconds, aspect ratios other than 16:9, reference images or videos, audio switches.
- Picking the cheapest route automatically, or failing over between routes.
- The desktop app's Video page (company, logo, route label, balance, entry list): it lives in `app/DSHProxyApp.cs`, which the DPI work is rewriting. It is its own slice after that work is merged. Until then entries are switched on with a command.
- Downloading or storing clips. The reply carries the provider's link.

## Must stay unchanged

- One paid request per job, sent once, never retried, never failed over. An outcome that is not known is reported as unknown.
- The routing CLI and the gateway never hold the Krea token. Only the helper process reads it.
- No secret in any output, log or error.
- Chat requests for chat models: byte-for-byte as today.
- The four tools of `integrations/dsh-video` keep working with the same answers for the same settings.
- The user's three uncommitted files in the main checkout (`README.md`, `src/gateway/server.js`, `test/gateway.test.js`) are not touched or committed. Part D adds its gateway code in a new module with the smallest possible hook in `server.js`, because that file has uncommitted edits by the user.

## Terms

- **Reference clip:** 5 seconds, 16:9, text only.
- **Entry:** one combination of model, resolution and route that exists, for example `seedance-2.5 / 720p / krea`. Its picker name is "Seedance 2.5 - 720p - Krea".
- **Fixed tier:** a model on a route that offers no resolution choice (MiniMax H3 on Krea). Its entry names the tier the provider states.
- **Hold and charge:** Krea reserves the quoted units when a job is submitted and settles at completion; the charge can be lower than the hold.
- **Confirmation:** a user message that consists of a confirming word only, directly after the gateway's quote for the same entry in the same conversation.

## Seams

- `bin/dshproxy-krea.js`: one request as one JSON line on standard input, one JSON line out, or one of three error codes on standard error. Tests drive `src/krea-helper/mcp.js` `run(request, token, {fetchImpl})` with a fake server built from the recorded live shapes.
- `src/krea-helper/oauth.js`: `login`, `access`, `status` with injected `fetchImpl`, `store`, `now`.
- `src/video/catalog.js`: `models`, `entries()`, `quote(model, route, resolution)`.
- `src/video/command.js` `run(args, out, deps)`: the contract the bundle's `runner.cjs` depends on.
- Part D: one module that turns a chat request for a video entry into an answer, driven in tests with fake quote, submit and status functions and a fake clock.

## Acceptance criteria

### Part A (frozen)

A1. With a fake server that answers as recorded in `evidence/krea-live-shapes.md`, a quote for each of `seedance-2.5`, `seedance-2.0`, `wan-3.0` at 480p, 720p and 1080p and for `minimax-h3` at its fixed tier returns the recorded compute units (fractional numbers kept), `is_estimated`, `affordable` and the available units. The arguments sent to `generate_video` are exactly `{model, input: {prompt, duration: 5, aspect_ratio: "16:9"[, resolution]}, preflight: true}` with the live model id.
A2. A submit takes a fresh quote for the identical input; refuses without sending when the quote exceeds the cap, is not affordable, or is not a plain preflight (`mode` other than `preflight`, or any job field present); otherwise sends exactly one `generate_video` call with `preflight: false` and returns the job id and status. Counted in the test: one paid request, whatever the fake server answers, including a timeout, a non-200, a malformed body and an answer without a job id; each of those ends as outcome unknown.
A3. A status check calls `get_job` with `jobId`, never calls `generate_video`, accepts the statuses seen (`scheduled`, `queued`, `processing`, `completed`), reports a status it does not know as such without failing, and returns the output link of a completed job when it is exactly one `https` link.
A4. A balance request calls `get_balance` only and returns plan name, billing period, monthly units and the units left (total, plan, purchased, free). `dshproxy video balance krea` prints it as JSON.
A5. The helper accepts the protocol version the server returns when it is one the helper knows (`2025-06-18`, `2025-11-25`) and refuses any other.
A6. Drift is refused, not guessed: a model id missing from `list_models`, a field DSHProxy sends that the model's schema does not declare with a compatible type, a resolution outside the schema's enum, a resolution asked of a model whose schema has none, or a required field DSHProxy does not send. Keywords and tools the helper does not use do not cause a refusal.
A7. Red before green: the new tests fail on the unchanged helper for the reasons listed in the evidence file (tool name, model ids, protocol version, schema keywords).
A8. No output or error contains the token; the existing tests of that property still pass.
A9. Live, with the user signed in again (needs the user): quotes for all models and the balance agree with the evidence file or the difference is explained; `video status` on one of today's job ids returns its link. A paid job only if the user says so then.

### Part B (frozen)

B1. `login` registers for `authorization_code` and `refresh_token`, and stores the client id and, when the token answer carries one, the refresh token, under the same protection as the access token.
B2. `access` returns a valid access token without a new consent when the stored one has expired or is about to, by one refresh request (`grant_type=refresh_token`, client id, resource); a rotated refresh token replaces the old one; the refreshed session is stored before the token is used.
B3. Two helper processes that need a renewal at the same moment make one refresh request between them, and both end with a valid token.
B4. A refused refresh (`invalid_grant` or any 4xx) removes the session and ends as sign-in required; a network failure or 5xx leaves the session as it was and ends as sign-in required for this call only.
B5. `status` retains existing desktop semantics: `signedIn` is true only while the access token is usable; add `canRenew` to report a renewable expired session separately. An expired renewable session is refreshed by `access`, not misrepresented as signed in. A session file written by the shipped helper keeps working until it expires.
B6. Red before green; no token, refresh token or client secret in any output.
B7. Live (needs the user): after a new sign-in, a call made more than an hour later works without a new consent. If Krea gives a public client no refresh token, that is reported and the behaviour stays as today.

### Part C (frozen when its brief is written; listed here so A and B do not block it)

C1. `entries()` lists every combination that exists, with the reference clip's price or units basis and its source; nothing is interpolated. The 720p (768p) figures equal today's catalog.
C2. Flux 3 exists as `flux-3` on VideoRouter (720p, 1080p) and Krea (`black-forest-labs/flux-3-video`, 720p, 1080p).
C3. VideoRouter requests pin the host that the price belongs to for that resolution, with fallbacks off; a resolution the pinned host does not list is not an entry.
C4. Quote, submit and status take the resolution on every route; a combination that is not an entry is refused before any request.
C5. The bundle's four tools give the same answers as before for existing settings.

### Part D (draft; frozen after the research on how DeepSeek Harness calls a picked model and a spec review)

D1. Enabled entries appear in the picker under one route, named "Model - resolution - Provider".
D2. A user message to an entry is answered with a quote and nothing is bought.
D3. Only a confirmation buys, and it buys once: the same request arriving again (a retry, a duplicate, a reconnect) finds the first job and does not buy another.
D4. Anything else the Harness sends to the entry (a title request, a summary, a tool round, a subagent) is answered without buying.
D5. The answer to a confirmation reports progress while the connection is open and ends with the clip's link; if the connection closes first, the job goes on and the next message reports its state.
D6. New decisions replace the parts of 0002 and 0004 this reverses.

## Riskiest assumption and its hardest case

That a chat request can be made safe to carry a purchase. The hardest case: the Harness sends the confirming turn, the gateway submits, the connection drops before any byte of the answer arrives, and the Harness retries the same request. D3 must hold there, across a gateway restart between the two requests. Part D is not started until the research says what the Harness retries and what it sends besides user turns.

For parts A and B the risk is the opposite of a design risk: the fixtures. They are built from what was observed in one hour on one plan; `evidence/krea-live-shapes.md` lists what was not observed (a failed job, an unaffordable preflight, a refresh). A9 and B7 are the live checks.

## Rejected alternatives

- Relaxing the helper until the live answers pass. Rejected: the checks that matter (what is sent, that a preflight is a preflight, one paid request) are stated in A1, A2 and A6 and tested; the rest is dropped on purpose.
- Generating straight away on every message to a picker entry. The user was offered it and chose to go on with the recommended quote-then-confirm.
- A second process or listener for picker entries. Rejected: the Harness already talks to the gateway; a second listener doubles the surface.

## Known risks

- Krea can change its interface again. A6 turns that into a refusal with a reason.
- A refresh token on disk outlives the hour. It has the protection the access token has.
- About 38 entries in a picker that also lists chat models; which are switched on is the user's choice, all off by default.
