# Part D design: video entries in the chat model picker

Written 2026-11-23 for `spec.md` part D (criteria D1 to D6). Read-only design: no code was changed, nothing was run against the gateway, the data folders or a provider.

Sources read: `spec.md`, `research/dsh-model-facts.md`, `research/code-map.md`, `briefs/V3.md`, `evidence/krea-live-shapes.md`, decisions 0001 to 0004, and in the main checkout `src/gateway/server.js` (with the user's uncommitted diff), `src/daemon.js`, `src/dsh/profile.js`, `src/app.js`, `src/cli.js`, `src/models.js`, `src/filelock.js`, `src/video/{command,settings,catalog,workspace,transport,keys}.js`, `integrations/dsh-video/{runner.cjs,lib/submit.js}`.

Not read: the DeepSeek Harness sources. They are inside `app.asar` and cannot be opened from here, so every statement about the Harness below comes from `research/dsh-model-facts.md` and is marked where the design leans on it.

---

## 0. Read this first

### 0.1 Requirements that cannot be met as written

1. **"A request carrying tools is answered without buying."** Not possible. The Harness sends its full tool list with every request (`dsh-model-facts.md` section 3), including the user's own confirming turn. A rule that refuses on a non-empty `tools` field would refuse every purchase. What the design does instead: the `tools` field is ignored, the gateway never emits a tool call, and a request whose messages after the quote contain anything other than text (a tool result, an image, a document) never buys.
2. **"A subagent is answered without buying."** Cannot be proven from the request. The facts file says a subagent on a route has no marker on the wire. A parent agent that is allowed to pick the video route for a subagent could send a prompt, read the quote, and send `yes`. The design blocks the configured way in (the route is never in `allowedModels`; `dsh verify` reports it; the gateway refuses to buy while a profile lists it) and caps the damage (daily ceiling). It does not make it impossible.
3. **"The gateway can prove the last user message is a confirmation."** Two corrections.
   - The last user-role message on the wire is usually not what the user typed. The Harness appends its own user-role messages after the typed text (a time sample on every step, instructions and runtime context at times). So the rule is about the messages after the gateway's quote, not the last message.
   - The gateway can prove what the request contains. It cannot prove a person typed it. Requests to `127.0.0.1:8417` carry no identity. Any local program that can send two requests and read the first answer can buy one clip. That was already true of `dshproxy video submit` for any program with a shell (decision 0004 says so); the new part is that an HTTP request is enough.
4. **"Exactly once."** What can be built is at most once, plus an honest "unknown". If the gateway dies after it recorded the purchase and before the paid request left, nothing is bought and the answer is "unknown", because after a restart the two cases cannot be told apart. The requirement's own last sentence allows this; it is stated here so nobody reads "exactly once" as "always once".

### 0.2 Residual risks that remain with this design

| # | Risk | What limits it |
|---|---|---|
| R1 | A local program, or an agent able to pick the video route for a subagent, orders a clip with two requests. | Host and Origin checks stop web pages. The route is kept out of `allowedModels` and purchases are refused while a profile lists it. Daily ceiling. Purchases from chat are off until the user switches them on. |
| R2 | Power loss or an operating-system crash in the seconds after the purchase record is written, on a disk that does not honour a flush: the record could be gone after the reboot while the paid request was sent. A replay of the same request would then buy again. | The record is flushed before the paid request starts. Node cannot flush a folder on Windows, so the guarantee is "as good as NTFS's flush of the file", and it is not testable. A process crash or a gateway restart is fully covered. |
| R3 | "Unknown" outcomes need the user. After one, the gateway never sends again and cannot find out by itself whether Krea took the job. | The answer says so and names where to look. The unknown counts against the daily ceiling. |
| R4 | The price shown is a cap on the quote, not the bill. Krea holds the quoted units and settles itself (3 % came back on Seedance 2.5 in the evidence). On API routes the "quote" is a dated published price and nobody checks the provider's real charge before the job. | Krea: the submit takes a fresh preflight and refuses when it exceeds the cap. API routes: left out of the first release (section 12, question 1). |
| R5 | Four Harness behaviours the design needs in order to work at all were read from source, not observed: the route options load, the assistant's text is replayed verbatim, the Harness's own messages are separate messages, text deltas reset the idle timer. | Each one fails closed (no purchase). A free rehearsal mode (section 7.3) checks all four in the real Harness before any money is involved. |
| R6 | Any text that reaches a Krea entry and is not recognised as Harness traffic is sent to Krea as the prompt of a free preflight. Prompts and job ids are kept in plain text in the data folder for 30 days. | Recognisers for title, compaction, goal and schedule requests. Nothing is bought. Stated in the decision record. |
| R7 | The hook replaces the gateway's request listener in `daemon.js`. A mistake there would touch every chat request. | Three lines, a start-up check, and a test that pins that other requests reach the original handler with the same objects and nothing read from them. |
| R8 | A user who types `yes please` instead of `yes` could be quoted for a clip called "yes please" and then confirm that. | After an open quote, short replies that start with a confirming or refusing word are never treated as a prompt (section 4.3). |

---

## 1. Decisions in one table

| Question | Decision |
|---|---|
| Route | One new provider route `dshproxy-video`, display name `DSHProxy · Video (paid)`. |
| Protocol | `anthropic-messages`. It is the only protocol whose minimum answer, timers and ping behaviour the research verified. |
| Address | `baseURL: <origin>/dshproxy/video`. The Harness then posts to `/dshproxy/video/v1/messages`. A path of its own is what keeps chat requests untouched. |
| Route options | `retryPolicy: { mode: normal, maxRetries: 0 }`, `streamIdleTimeoutMs: 900000`. Neither is needed for safety. |
| Model id | `<model>/<resolution>/<route>`, for example `seedance-2.5/720p/krea`. Looked up in a table, never parsed. |
| Conversation | No derived conversation id. The conversation is recognised by content the gateway planted in it: its own quote answer, with a random quote id, replayed word for word as the assistant turn directly before the confirmation. |
| Quote binding | Quote id (80 random bits), entry id, SHA-256 of the prompt, amount, unit, cap, expiry, and SHA-256 of the whole quote answer text. |
| Confirmation | One message after the quote, and only one, that is exactly `yes`, `da`, `confirm`, `potvrdi` or `potvrđujem`; any letter case; one optional final `.` or `!`. |
| At most once | A claim file created with exclusive create and flushed, before the paid request. It is never deleted, renamed or taken over while its quote exists. |
| Purchase path | A child process that calls `src/video/command.js` `run(['submit', ...])` with the cap set to the quoted amount. The gateway process never loads a key or a token. |
| Waiting | Text deltas: a status line on each change and a dot every 10 seconds. Up to 12 minutes, then the answer ends and the next message reports. |
| Ceiling | Per rolling 24 hours: 5 purchases and 5,000 Krea units, whichever is reached first. Set in `<DSHPROXY_HOME>/video-picker/settings.json` with `dshproxy video picker`. |
| Second switch | Purchases from chat are off until `dshproxy video picker purchases on`. While off, a confirmation runs a rehearsal that buys nothing. |
| Hook | `src/daemon.js`, three lines after `createGateway(...)`. `src/gateway/server.js` is not changed at all. |

---

## 2. Route, protocol, model id

### 2.1 Why a path of its own

All four routes of today post to the same origin and are told apart by the model id only. A video entry told apart by model id would need a check inside `handle()` in `server.js`, after the body is parsed, in the middle of the user's uncommitted edits.

With `baseURL: http://127.0.0.1:8417/dshproxy/video` the request line already says "video": `POST /dshproxy/video/v1/messages`. The decision "is this mine" needs `req.url` only. Everything else goes to today's handler before a single byte of the body is read. That is how requirement 4 holds by construction, not by care.

`/dshproxy/` is already the gateway's own namespace (`/dshproxy/status`, `/dshproxy/control/`). No new listener is opened.

### 2.2 Why `anthropic-messages`

- Section 6 of the facts file gives the exact minimum for a text-only answer on this protocol, and section 5 says text deltas reset the idle timer while pings and comments do not. For the OpenAI protocols the header timer is "not verified".
- The lanes and Claude routes already use it, so the profile writer needs no new protocol.

### 2.3 Route options

```yaml
dshproxy-video:
  displayName: DSHProxy · Video (paid)
  apiKeyEnv: DSHPROXY_API_KEY
  api: anthropic-messages
  baseURL: http://127.0.0.1:8417/dshproxy/video
  streamIdleTimeoutMs: 900000
  retryPolicy: { mode: normal, maxRetries: 0 }
  models:
    - { id: seedance-2.5/720p/krea, name: "Seedance 2.5 - 720p - Krea", input: [text], contextWindow: 1000000, maxTokens: 4096, reasoningEfforts: false }
```

- `maxRetries: 0`. The design is safe with the default five retries: a retry of a confirmation finds the first purchase (section 5). Zero is chosen because a paid route should not be re-sent to automatically. Cost: after a dropped connection the user sees an error and sends one message to get the state.
- `streamIdleTimeoutMs: 900000` is a margin. The answer sends text at least every 10 seconds, far inside the default 300 seconds.
- `contextWindow: 1000000` and reported usage of a few tokens keep compaction away. If it runs anyway it is recognised and answered without buying.
- `maxRequestImages` and `maxRequestImageBytes` are written as on the other routes, so `verify` treats all routes alike. A request with an image never buys.
- The facts file marks this excerpt "not verified: not loaded". Loading it in the real Harness is a gate of slice S4.

### 2.4 Model id

`id = model + "/" + slug(resolution) + "/" + route`, where `slug` lowercases and turns every run of characters outside `a-z 0-9 .` into `-`. Examples: `seedance-2.5/720p/krea`, `wan-3.0/1080p/krea`, `flux-3/720p/krea`. For a fixed tier, `resolution` is whatever V3 puts where the resolution would be.

- `/` is already used in model ids on this gateway (custom endpoints are `<endpoint>/<model>`), and it matches the spec's notation `seedance-2.5 / 720p / krea`.
- The id is never parsed. One function, `picker/entries.js` `offered(home)`, returns `Map(id -> entry)` built from V3's `catalog.entries()` filtered by V3's "entries switched on" function. The profile writer and the gateway both use that one function, so they cannot disagree.
- A test walks the real catalog: every id is unique and matches `^[a-z0-9][a-z0-9./-]{2,79}$`. Two entries with the same id would both be left out.
- The gateway reads which entries are on at every request. An entry switched off stops quoting and buying at once, even while the Harness still lists it.
- First release: Krea entries only (`route === 'krea'`). Decision 0004 keeps paid generation from the Harness on the Krea route "until a separate decision covers API routes"; that is question 1 in section 12.

---

## 3. Conversation and quote binding

### 3.1 What a request offers

No conversation id. The body has `system`, `tools`, the whole message history and the model id. Headers such as `x-session-id` are not sent by the Harness. A plugin could stamp a session id (facts section 3), but that would make the safety of a purchase depend on a plugin being installed and loaded; it is not used.

Two derived ids were considered and rejected:

- **Hash of the first user message** (what `src/gateway/sessions.js` does for lanes). Two sessions that start with the same prompt collide. Good enough to pick a rung, not to spend money.
- **Hash of the whole history before the quote.** Whether the Harness replays earlier messages byte for byte is not known: the time sample may be sent only with the current turn, images are replaced by placeholders, compaction rewrites history. Each of those would make every confirmation fail. It also adds no safety beyond 3.2: a fork of the session has the same history.

### 3.2 What is used instead

The Harness replays the assistant's earlier answers in every request. So the gateway puts a random id into its quote answer and stores the answer's hash. A confirming request must carry that exact answer as the assistant turn directly before the user's reply.

"This conversation" therefore means: the conversation whose latest assistant turn is, word for word, the quote answer this gateway produced for quote `Q`. The only other conversations that can contain it are copies of this one (a fork, a duplicated session). The claim in section 5 lets all copies together buy once.

For a follow-up after a lost connection, the conversation is found the same way: the quote ids in its assistant turns name its jobs.

### 3.3 The quote record

Written to `quotes/<id>.json` before the first byte of the quote answer is sent, so a quote the user can see always exists on disk.

```json
{ "v": 1, "id": "Q-7K3M9A2F4HXD6P2B", "entry": "seedance-2.5/720p/krea",
  "model": "seedance-2.5", "resolution": "720p", "route": "krea", "label": "Seedance 2.5 - 720p - Krea",
  "prompt": "A red ball rolls slowly across a wooden table",
  "promptSha": "<sha256 of the prompt's UTF-8 bytes>",
  "amount": 856, "unit": "krea_units", "cap": "856", "estimated": false,
  "issuedAt": 1795395000000, "expiresAt": 1795395600000,
  "answerSha": "<sha256 of the normalised quote answer>" }
```

- `id`: `Q-` and 16 characters of `A-Z2-7` from `crypto.randomBytes(10)`. It is also the file name; anything not matching `^Q-[A-Z2-7]{16}$` never reaches a path.
- `prompt`: the typed message, trimmed, exactly as it will be sent. It is stored because the purchase after a restart needs it.
- `cap`: the quoted amount as the text that goes to `--max-units`, rounded up at the sixth decimal the way `integrations/dsh-video/lib/submit.js` `exactCap` does (the command accepts at most six decimals; Krea quotes such as 380.33333333333326 are never rounded down). The cap can exceed the quote by less than one millionth of a unit.
- `answerSha`: SHA-256 of the full quote answer after this normalisation, applied the same way when the record is written and when a request is checked: Unicode NFC, `\r\n` to `\n`, trailing spaces removed from every line, leading and trailing blank space removed.
- The quote id is the last line of the answer. A quote that was cut off part-way has no id and cannot be confirmed.

### 3.4 What a confirmation must show (all of it)

Let `tail` be the messages after the last assistant message of the request.

- **C1.** The tail holds exactly one typed unit, and it is a confirming word (section 4). Units are defined in 4.1.
- **C2.** The message directly before the tail is an assistant message made of text only, its last line names a quote id, and its normalised text hashes to that quote's `answerSha`.
- **C3.** The quote record exists and reads cleanly, its `entry` equals the request's `model`, that entry is switched on now, and `issuedAt <= now <= expiresAt`.
- **C4.** No claim exists for the quote. If one exists the request is a repeat and is answered from the stored state (section 5.4).
- **C5.** Purchases from chat are on, no profile lists the video route for agents (section 9.3), and the ceiling allows it.

A missing, unreadable or mismatching piece means no purchase. There is no fallback path.

The gateway also stores a hash of the history before the quote and logs at confirmation whether it still matches. It is measured, not enforced, for the reason in 3.1. The rehearsal in slice S4 will show whether it is stable enough to enforce later.

---

## 4. Reading a request

### 4.1 Units

The Harness sends its own user-role messages next to the typed one. Whether the library merges neighbouring user messages into one message with several text blocks is not known. So the tail is flattened into **units**: a message whose content is a string is one unit; in a message whose content is a list, every text block is one unit; any other block makes the request a tool round or an attachment (no purchase, no quote).

A unit is **injected** when, after trimming, it starts with `<system-reminder>` or with `Time sampled while preparing turn `. Every other unit is **typed**.

Injected units are skipped. That is safe because skipping can only matter when exactly one other unit is a bare confirming word. A Harness message of a kind this list does not know counts as typed, and then C1 fails.

### 4.2 The confirmation rule

```
bare(text) = NFC(text), trimmed, one final "." or "!" removed, lower-cased
CONFIRM    = { yes, da, confirm, potvrdi, potvrđujem, potvrdujem }
```

- Whole message only. `Yes`, `YES`, `da.`, `Da!` confirm. `yes?`, `yes please`, `"yes"`, `ok`, `y`, `može` do not.
- NFC, not NFKC: look-alike and full-width letters are not folded into ASCII and so do not match.
- English and Croatian. `potvrdujem` is accepted for keyboards without `đ`.
- `ok` and `može` are left out on purpose: they are also what people write to acknowledge a price. Question 2 in section 12.

Why Harness traffic cannot satisfy it:

1. Every message the Harness writes itself has a frame longer than one word: `<system-reminder>…`, `Time sampled…`, `Generate the session title…`, `You are now acting as a compaction engine…`, `<goal_round>…`, `[SCHEDULE REMINDER]…`. None can be equal to one of six bare words.
2. It must be the only typed unit after the quote. An extra message of any unknown kind breaks C1.
3. It must follow the gateway's own quote answer, carrying an id that cannot be guessed. A title request carries the user's messages inside one JSON string and has no assistant turn. A first message has none either.
4. The quote is used once, belongs to one entry, and lasts ten minutes.

### 4.3 Classification, in this order

| # | Kind | Rule | Answer (nothing is bought in any row but 9) |
|---|---|---|---|
| 1 | Not for this route | Not `POST`, path is not `/dshproxy/video/v1/messages`, an `Origin` header is present, or `Host` is not the gateway's own `127.0.0.1:<port>` / `localhost:<port>` | HTTP 403 or 404 with a short JSON error. |
| 2 | Malformed | Body over 32 MiB, not JSON, no `messages` list, a message that is not `user` or `assistant` | HTTP 400 or 413, JSON error. |
| 3 | Not streaming | `stream` is not `true` | One JSON message: "This route answers DeepSeek Harness chat requests only." |
| 4 | Unknown entry | `model` is not an entry that is switched on | "This video entry is switched off in DSHProxy. Nothing was quoted or bought. Switch it on with `dshproxy video entries`, then run `dshproxy dsh apply`." |
| 5 | Title | `system` starts with `Create a concise title`, or a tail unit starts with `Generate the session title from this JSON array` | One line: `Video: <first 48 characters of the first message in that array>`, or `Video clip`. |
| 6 | Compaction, goal, schedule | A tail unit starts with `You are now acting as a compaction engine`, or contains `<goal_round` or `[SCHEDULE REMINDER]` | Compaction: "Video conversation." and one line per job found in the history. Goal or schedule: "This entry makes a video from a prompt you type. Goals and scheduled tasks are not run here. Nothing was quoted or bought." |
| 7 | Tool round or attachment | A tail message holds a block that is not text | "This entry takes text only. Nothing was quoted or bought." |
| 8 | No typed message | The last message is from the assistant, or the tail has no typed unit | "I found no message from you. Type a prompt to get a quote." |
| 9 | Confirmation | C1 and C2 hold | Section 5. C3 to C5 are checked there, each with its own sentence. |
| 10 | Confirming word, not a confirmation | The last typed unit is a confirming word but C1 or C2 fails | "There is nothing to confirm: a `yes` buys only when it is the one reply directly after a quote. Nothing was bought. Send the prompt again to get a quote." |
| 11 | Refusal | The assistant turn before the tail is an open quote and the last typed unit is `no`, `ne`, `cancel`, `stop`, `odustani`, `odustajem` or `nemoj` | The quote is closed for good. "Dropped. Nothing was bought." |
| 12 | Status | The last typed unit is `status` or `stanje`, alone or followed by a quote id | Section 6.4. |
| 13 | Near-confirmation | The assistant turn before the tail is an open quote, the last typed unit has at most four words, and its first word is one of `yes da ok okay sure yep yeah y go može moze ajde hajde kupi buy naravno confirm potvrdi potvrđujem potvrdujem no ne` | "Nothing was bought. To buy the quoted clip, reply with only `yes` (or `da`). To drop it, reply `no`." No new quote is made. |
| 14 | Prompt | Anything else: the last typed unit is the prompt | A quote (section 6.1), or the reason there is none. |

Rows 5 and 6 are a courtesy, not part of the proof. If the Harness rewords a title request tomorrow, it falls to row 14 and gets a free quote. It cannot reach row 9.

A bare confirming, refusing or status word is never used as a prompt.

A prompt is refused, with no quote, when it is empty, longer than 16,000 bytes, starts with `--`, or holds control, invisible or text-direction characters (the pattern from `lib/submit.js`): what is shown must be what is sent.

---

## 5. One purchase per quote

### 5.1 State store

```
<DSHPROXY_HOME>/video-picker/
  settings.json            purchases on/off and ceilings (section 7)
  quotes/<id>.json         written once, when a quote is issued
  claims/<id>.json         written once: "this quote is used"
  outcomes/<id>.json       written once: what the one attempt led to
  results/<id>.json        written once: the job's final state and link
```

- **One write primitive for all four folders:** `writeOnce(file, object)` = `fs.openSync(file, 'wx')`, `writeSync`, `fsyncSync`, `closeSync`. `wx` is `CREATE_NEW` on Windows: of any number of callers in any number of processes, one succeeds and the rest get `EEXIST`. No file in these folders is ever rewritten, renamed or deleted, except by the clean-up in 5.6.
- **No lock.** `src/filelock.js` takes a lock from a live holder after 30 seconds, and a paid request can take longer than that. Here the claim file itself is the mutual exclusion. It has no time limit, no owner to steal from and no release step.
- **Readers.** A file that exists but does not parse is read as follows: a claim counts as a claim; a quote is invalid (no purchase); an outcome is read again for up to two seconds and then counts as unknown; a result is ignored and the job is asked again.
- **`settings.json`** is ordinary configuration. It is written with the existing `withLock` and `replaceFile`; a lost update there cannot spend anything. An unreadable or invalid file means purchases are off.
- **Durability.** After `writeOnce` returns, the file survives the death of the process, always. Against power loss it is as durable as `FlushFileBuffers` on NTFS makes a new file; Node cannot flush the folder on Windows (R2).

### 5.2 Order of steps for a confirmation

| Step | What happens | Persisted |
|---|---|---|
| 1 | Check C1 to C5 and the ceiling. | nothing |
| 2 | **Claim.** `writeOnce(claims/<id>.json, { id, entry, amount, unit, cap, claimedAt })`. On `EEXIST` go to 5.4. On any other error: "The purchase could not be recorded, so nothing was sent." | the claim, flushed |
| 3 | Count the ceiling again, now with the own claim (7.2). Over: `writeOnce(outcomes/<id>.json, { state: "not-sent", reason: "ceiling" })` and answer. | maybe an outcome |
| 4 | Start the child process with the submit arguments and the path of the outcome file. | nothing |
| 5 | **The child** calls `run(['submit', ...])`: one paid request. It then writes `outcomes/<id>.json` itself, flushed, and only then prints its result. | the outcome, written by the child |
| 6 | The gateway reads the outcome when the child ends. If the child ended and wrote none: `writeOnce(outcomes/<id>.json, { state: "unknown" })`. | maybe an outcome |
| 7 | Answer by outcome. For a submitted job, follow it (section 6.3). When it reaches a final state: `writeOnce(results/<id>.json, ...)`. | the result |

The claim (step 2) comes before the paid request (step 5) and is flushed first. From step 2 on, the quote can never buy again, whatever happens later.

The child writes the outcome, not the gateway. So a gateway that is stopped or crashes while the child is working does not lose the job id.

Outcome states: `submitted` (job id and status), `not-sent` (with a reason code; only for failures known to happen before the paid request), `unknown`, `rehearsal` (section 7.3), `declined`.

### 5.3 The process dies between steps

| Dies | On disk | A repeat of the same request |
|---|---|---|
| before 2 | quote only | Passes the checks and buys. This is the first purchase, not a second. |
| between 2 and 4 | claim, no outcome | Nothing was sent, but that cannot be told apart from the next row. Answer: unknown. Never sent again. |
| between 4 and the child's write | claim, no outcome; the child may still be running | While the claim is younger than 180 seconds: "being sent", and the request waits for the outcome file. The child usually finishes and writes it, and the repeat reports the job. If none appears by 180 seconds: unknown. |
| after the child's write, before any byte of the answer | claim and outcome | The repeat reads the outcome and reports the job. **This is the hardest case of the spec, with or without a restart in between.** |
| while following the job | claim and outcome, maybe a result | Same: reads, asks the job's status once, goes on following. |

180 seconds is longer than anything the submit path allows itself: 90 seconds for the Krea helper process (`workspace.js`), 30 seconds for an API request plus 20 seconds to unlock a saved key. The gateway never kills the submit child and writes no "unknown" on a timer. If a child finishes late, its outcome replaces the derived "unknown" from then on.

Two confirmations of one quote at the same moment (a retry that overlaps, a forked session, two processes): one wins step 2, the other gets `EEXIST` and goes to 5.4.

### 5.4 A request for a quote that is already claimed

| Found | Answer |
|---|---|
| claim, no outcome, claim younger than 180 s | "This quote is already being sent." A dot every second until an outcome appears, then as below. |
| claim, no outcome, older | The unknown-outcome text (6.3). |
| outcome `submitted`, result stored | The stored result: the link, or the failure. No request to the provider. |
| outcome `submitted`, no result | One status check, then follow the job as in 6.3. |
| outcome `not-sent` | "Nothing was bought with quote Q-…: <reason>. A quote is used once. Send the prompt again for a new one." |
| outcome `unknown` | The unknown-outcome text. |
| outcome `rehearsal` or `declined` | "That quote was a rehearsal; nothing was bought." / "You dropped that quote." |

Nothing in this table can start a purchase.

### 5.5 Which failures count as "not sent"

The child decides, from the message `run()` threw, with a fixed list. Only sentences that the command produces before the paid request is dispatched are on it:

| Message begins or ends with | Reason code |
|---|---|
| `Krea workspace sign-in required.` | `sign-in` |
| `Krea refused the request` (the helper refuses only before the paid call: price above the cap, balance, schema) | `refused` |
| `Krea workspace OAuth requires explicit workspace parameters.`, `Unknown video model`, `Unsupported video route for `, `Invalid video route or model`, `Invalid video prompt`, `Invalid video provider credential`, and V3's sentence for a combination that is not an entry | `bad-request` |
| `The quote exceeds --max-usd; no job submitted.`, `Insufficient credit budget; no job submitted.` | `over-cap` |
| ends with `No request sent.` (no key, or a saved key that cannot be read) | `no-key` |

Every other failure, including one nobody thought of, is `unknown`. A result without a valid job id and status is `unknown`. This is the same rule `integrations/dsh-video/runner.cjs` already applies, and a test pins each sentence against the real modules.

### 5.6 Clean-up

Run when the gateway starts and at most once a day after that. A set is the files of one quote id.

- A quote without a claim, issued more than 24 hours ago: delete the quote.
- A set whose claim is older than 30 days: delete the quote first, then the result, the outcome and the claim last. A half-finished clean-up leaves a set without a quote, which can never buy.
- A claim younger than 30 days is never deleted. The ceiling counts 24 hours of claims.

A confirmation for a deleted quote finds no record and buys nothing.

---

## 6. What the user sees

All answers are plain English. Sentences below are the wording to implement.

### 6.1 The quote

````
**Quote: Seedance 2.5 - 720p - Krea**

- Cost: at most 856 Krea compute units. Your workspace has BALANCE-REMOVED. Krea holds this amount when the job starts and sets the final charge itself.
- Clip: one clip, 5 seconds, 16:9, 720p, from text only.
- Prompt, exactly as it will be sent:

```
A red ball rolls slowly across a wooden table
```

Nothing has been bought. To buy this clip, reply with only `yes` (or `da`). To drop it, reply `no`.
The quote stands until 02:14, ten minutes from now. If Krea's price is higher by then, nothing is sent.

Quote Q-7K3M9A2F4HXD6P2B
````

- The amount shown is the cap that will be sent, digit for digit.
- The prompt is in a fenced block whose fence is longer than any run of backticks in the prompt, so prompt text cannot pose as part of the quote.
- When Krea marks the quote as an estimate, the cost line says so.
- While purchases from chat are off, the line before the validity line reads: "Purchases from chat are switched off: a `yes` runs a rehearsal and buys nothing."
- If an earlier job of this conversation has no final answer yet, one line about it comes first (section 6.4).

No quote is issued, and the reason is given in one sentence, when: Krea is not signed in ("Sign in to Krea in the DSHProxy app, then send the prompt again."), Krea refused the preflight, the balance does not cover it ("needs 856, has 120"), the daily ceiling would be exceeded, or more than 20 quotes were asked in ten minutes.

### 6.2 While waiting, and the result

Headers, `message_start` and the first line go out at once. Then:

```
Buying one clip: Seedance 2.5 - 720p - Krea, at most 856 units (quote Q-7K3M9A2F4HXD6P2B).
Sent once. Job 3f1c2a9e-… is scheduled.
Generating .... processing 35 % ..... processing 75 % ....
Done after 2 min 20 s.

[Open the clip](https://app-uploads.krea.ai/public/….mp4)

Krea held up to 856 units and sets the final charge itself. Check it with `dshproxy video balance krea`.
Finished Q-7K3M9A2F4HXD6P2B
```

- A dot every 10 seconds, from a timer that does not wait for a status check. A status word whenever the status or the rounded progress changes.
- Status checks: the first after 5 seconds, then 15 seconds after the previous one returned. Each is one child process running `video status`.
- The link is shown only when the command returned a completed job with exactly one `https` link without user name or password. A completed job without such a link: "The job is completed, but its link could not be verified. Open your Krea history."
- A failed or cancelled job: "The job failed at Krea. Whether anything was charged is Krea's decision; check your balance. I did not send it again."
- After 12 minutes: "Still running after 12 minutes. Job 3f1c… Send `status` to check it." The answer ends normally.
- The mp4 is a link. The Harness renders no video (facts section 7).

### 6.3 Unknown outcome

```
I do not know whether this clip was bought.

The order for quote Q-7K3M9A2F4HXD6P2B was handed over once and no answer came back. It may have been sent and charged, or not.
I will not send it again. Check your Krea history at krea.ai before you order this prompt again.
Finished Q-7K3M9A2F4HXD6P2B
```

### 6.4 If the connection closes first; the status follow-up

When the connection closes (the user cancels, the Harness times out, the gateway stops), the gateway stops following the job and does nothing else. A submit child that is running is left to finish and write its outcome. There is no background work after that: nothing follows a job, and nothing can spend, while no request is open.

The next message in the conversation, whatever it says, reports. The gateway collects the quote ids in the request's assistant turns (newest first) and looks each up in the store.

- `status` or `stanje`: the newest job. `status Q-…` names one directly, for a conversation that was compacted.

```
Job 3f1c… (Seedance 2.5 - 720p - Krea, quote Q-7K3M…): processing, 75 %. Sent 3 minutes ago.
```

  A running job is then followed as in 6.2. A finished one gives its stored link. With no job: "There is no job in this conversation yet. Type a prompt to get a quote."
- A new prompt: the quote, with one line first when the newest job has no `Finished Q-…` line in a later assistant turn: "Earlier job 3f1c…: completed. [Open the clip](…)".
- A status check that cannot be made (sign-in expired, provider unreachable): "The job's state could not be read: the Krea sign-in has expired. The job itself is not affected. Job 3f1c…".

With `maxRetries: 0` a dropped connection shows as an error in the Harness and the user sends one message. If the Harness retries anyway, the retry lands in table 5.4 and the user sees the job being followed.

### 6.5 Stream format

`200`, `content-type: text/event-stream`, `cache-control: no-store`; then `message_start` (with `usage: {input_tokens: 1, output_tokens: 1}`), `content_block_start` (text), one `content_block_delta` per piece of text, `content_block_stop`, `message_delta` (`stop_reason: end_turn`, output tokens), `message_stop`. Never a tool call, never a thinking block. That is the minimum of facts section 6.

---

## 7. Second line of defence

### 7.1 Settings

`<DSHPROXY_HOME>/video-picker/settings.json`:

```json
{ "purchases": false, "ceiling": { "clips": 5, "krea_units": 5000 } }
```

Changed only with the command line, never from chat:

```
dshproxy video picker                         purchases on/off, ceilings, use in the last 24 hours, last jobs
dshproxy video picker purchases on|off
dshproxy video picker ceiling clips N
dshproxy video picker ceiling units N
dshproxy video picker jobs                    quote id, entry, amount, state, job id; for checking an "unknown"
```

`src/video/command.js` gets one line that hands `picker` to `src/video/picker/cli.js`.

### 7.2 The ceiling

Per rolling 24 hours, both limits apply: **5 purchases** and **5,000 Krea compute units** of quoted amounts. For scale: a Seedance 2.5 clip is 856 units at 720p and 2,106 at 1080p; the plan in the evidence has 100,000 a month. Question 3 in section 12.

There is no per-conversation ceiling, because there is no trustworthy conversation id (3.1).

It is counted from the claims folder, so it needs no file of its own and cannot drift. Every claim of the last 24 hours counts except those whose outcome is `not-sent`, `rehearsal` or `declined`. An unknown outcome counts in full.

Two purchases at the same moment cannot both slip under the limit: each counts after writing its own claim (step 3 of 5.2), and proceeds only if all the other claims it can see, plus its own, fit. The second writer always sees the first. At worst both refuse.

### 7.3 The purchases switch and the rehearsal

Purchases from chat are off until the user switches them on. While off, the whole path runs except the paid request: quote (a real, free Krea preflight), confirmation, claim, and then outcome `rehearsal`. The answer follows a pretend job for 3 minutes with the same dots and status words and ends with "Rehearsal: nothing was bought."

This is how the real Harness is checked for free: that the route loads, that a quote is replayed word for word, what the tail really looks like, that the title request is recognised, and that a three-minute answer survives the idle timer.

---

## 8. Credentials and secrets

- The gateway process starts `process.execPath src/video/picker/child.js` (`shell: false`, `windowsHide: true`) and writes one JSON line to its standard input: `{ args, outcomeFile }`. The child calls `require('../command').run(args, out, { env: process.env })`, the same call `src/cli.js:334` makes. The prompt travels on standard input, not on a command line.
- Krea: `run` starts `bin/dshproxy-krea.js` as today. Only that helper reads the token. Two processes down from the gateway.
- API routes (if the user wants them, question 1): `run` resolves the key inside the child. The gateway process never calls `keys.resolve` and never loads the master key.
- The child's environment is a fixed list of names, copied without being looked at: `SystemRoot`, `LOCALAPPDATA`, `APPDATA`, `TEMP`, `TMP`, `USERPROFILE`, `DSHPROXY_HOME`, and for API routes the three provider key variables when set.
- Submit arguments on Krea: `['submit', model, 'krea', '--max-units', cap, '--confirm-charge', '--resolution', R, prompt]` (the form `workspace.js` accepts on `main` today; without the resolution pair for a fixed tier). The exact vectors are V3's. One function builds them, and a test runs them through the real `run` with a fake `workspace` and checks that the fake received `maxUnits` equal to the cap, the prompt and the resolution.
- Chat answers are built from fixed sentences and validated fields only: quote id, job id (`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`), status (`^[a-z][a-z0-9_-]{0,63}$`), numbers, the entry label, the user's own prompt, and a checked `https` link. Text from a child's standard error or from a thrown error is never shown or logged; it is mapped to a reason code (5.5).
- Log lines: quote id, entry id, amount, unit, state, job id. Never the prompt (its length only) and never a link.
- A test feeds the fakes a result with a planted secret-shaped string in every free-text field and checks that no answer and no log line contains it.

---

## 9. The hook and the seams

### 9.1 The hook: `src/daemon.js`, nothing in `src/gateway/server.js`

`server.js` has uncommitted edits in the main checkout. Git refuses to merge a branch that changes a file with uncommitted edits, wherever in the file the change is. So the only hook that does not get in the user's way is one that leaves that file alone. `daemon.js` has no uncommitted edits.

Add after the last `require` (line 25):

```js
const videoPicker = require("./video/picker");
```

Add after the `createGateway({ ... });` call (it ends at line 490) and before the comment `// ---- Requests in flight`:

```js
  // Paid video entries are answered here and never forwarded. Every other
  // request reaches the gateway's own handler untouched.
  videoPicker.mount(gateway, { home: state.home, origin: state.origin, log });
```

`mount`, in the new module:

```js
function mount(server, options) {
  let picker;
  try { picker = create(options); } catch (error) { options.log(`video picker is off: ${error.message}`); return; }
  const handlers = server.listeners("request");
  if (handlers.length !== 1) throw new Error("The video picker must be mounted before anything else listens for requests.");
  const [forward] = handlers;
  server.removeListener("request", forward);
  server.on("request", (req, res) => (picker.claims(req) ? picker.handle(req, res) : forward.call(server, req, res)));
}
```

- `http.createServer(listener)` registers `listener` for the `request` event; that is documented Node behaviour, and `createGateway` returns exactly that server.
- `claims(req)` is `req.url.startsWith("/dshproxy/video/")`. It reads nothing from the request.
- It must run before `countRequests` (line 496), which prepends its own listener. The length check turns a wrong order into a start-up failure.
- Video requests are counted as in flight like any other. `stop --when-idle` waits for an open video answer. That is intended.
- If the picker cannot start (for example its folder cannot be made), the chat gateway runs as before and the video path is not mounted.

For later, once the user's edits are committed: a `local` parameter on `createGateway` and one line in its request handler would be a plainer seam. It is not part of this work.

### 9.2 Module layout

```
src/video/picker/
  index.js      create(options) -> { claims(req), handle(req, res), answer(body, write) }; mount(server, options)
  classify.js   request body -> kind (section 4.3). Pure.
  store.js      the four folders: writeOnce, read, state of a quote, 24-hour use, clean-up
  flow.js       the answer for each kind; the purchase steps of 5.2
  entries.js    offered(home) -> Map(id -> entry); idOf(entry)
  ops.js        real quote, submit, status: start the child, map its result to a closed set
  child.js      the child process: one request in, run(), outcome file, one line out
  stream.js     the Anthropic event stream
  cli.js        dshproxy video picker ...
```

The public interface is `create`, `mount`, and, for the profile writer, `entries.offered`.

### 9.3 Seams for tests

```js
create({
  home,                       // a throwaway folder
  origin,                     // for the Host check
  ops: { quote, submit, status },   // fakes
  clock: { now, sleep },      // fake: sleep advances now and returns at once
  random,                     // fixed bytes for quote ids
  entries,                    // () => Map(id -> entry)
  exposed,                    // () => false; true when a Harness profile lists the video route for agents
  log,
})
```

- `answer(body, write)` is the seam of the spec: a parsed request in, text pieces out through `write`, a promise that resolves when the answer is complete. No HTTP, no child process, no real time.
- "The gateway restarted" in a test is a second `create` on the same folder. Nothing is kept in memory between requests, so that is a faithful restart.
- "The gateway died while the child was working" is a fake `submit` that never returns; the test drops that picker, makes a new one, moves the clock and repeats the request. "The child finished after the gateway died" is the same, with the test writing the outcome through `store` first.
- `handle(req, res)` is tested on a plain `http.createServer` on port 0 with fake `ops`: stream shape, Host and Origin, a client that hangs up.
- `mount` is tested on a plain server whose own handler answers `forwarded`.
- `child.js` exports `main(request, { run })` and `outcomeOf(resultOrError)`; tests call them in-process with a fake `run`. No test starts the real child with a submit.
- `exposed` reads the Harness profiles in the real picker (`profile.videoExposed(home)`): any `{ provider: dshproxy-video, ... }` pair outside the provider list, such as in `allowedModels`, a tool's agent options or the default model. An unreadable profile counts as exposed.

---

## 10. `dsh apply`, `verify`, `remove`

All in `src/dsh/profile.js`, through its existing test seam (a throwaway `DSH_HOME`).

- **`ROUTES`** gets a fifth entry: `"dshproxy-video": { api: "video", protocol: "anthropic-messages", suffix: "/dshproxy/video", label: "DSHProxy · Video (paid)", options: { streamIdleTimeoutMs: 900000, retryPolicy: { mode: "normal", maxRetries: 0 } } }`. `buildRoutes` spreads `route.options` into the route it writes. The loops over `ROUTES` in `apply`, `remove`, `hasRoutes` and `state` then cover it without further change.
- **Models.** `app.snapshot()` gains `video`: one `{ id, name: label, api: "video", input: ["text"], contextWindow: 1000000, maxTokens: 4096, efforts: [] }` per offered entry, from `picker/entries.js`. It is kept apart from `models`, so lanes, `dshproxy models`, image checks and account lookups do not see it. The three callers pass `[...state.models, ...state.video]`: `cli.js` for `dsh apply` and `dsh verify`, and `daemon.js` `syncNow`, whose fingerprint then covers the entries.
- **`apply` writes** the route with exactly the offered entries, and removes the route when none is on. It never adds the route to `allowedModels`. A profile whose default model points at the video route is repaired to a lane, as a missing default is today: no new session may start on a paid entry.
- **`verify` reports**, in addition to today's checks for a route: the model ids differ from the offered entries in either direction ("run `dshproxy dsh apply`"); `retryPolicy.maxRetries` is not 0; and any place in the profile that names provider `dshproxy-video` outside the provider list ("the paid video route must not be selectable for agents or be the default model").
- **`remove`** deletes the route with the other four. The state folder is left alone: it holds the record of purchases.
- **Switching an entry on later** needs `dshproxy dsh apply` and a restart of DeepSeek Harness, because the Harness reads the model list from the profile. `dshproxy video entries set …` prints that. Switching an entry off works at the gateway at once.
- `purchases` being off does not hide entries: they quote and rehearse.

---

## 11. Decision records

**`docs/decisions/0005-video-entries-in-the-chat-picker.md`** (required). It records:

- Replaces in 0002: "Never send video jobs through the chat gateway: a retry after an ambiguous timeout can purchase two jobs." New rule: the gateway process answers picker entries on a path of its own; the chat forwarding path still never carries a video job; the purchase is still made by the video command, in a child process, once; a repeat of a confirmation is answered from a one-use record written and flushed before the paid request.
- Replaces in 0004: "Unchanged: video jobs never go through the chat gateway". The rest of that sentence stands: one send per job, no retry or fallback, the routing CLI never holds the Krea token.
- Settles what 0002 left open ("Any … daily cap … is a separate decision"): the 24-hour ceiling and the purchases switch.
- Keeps from 0002: no new listener. Notes the new fact: an unauthenticated local path can now start a purchase, with the limits of sections 0.2 and 7.
- Keeps from 0004, unless question 1 is answered otherwise: "paid generation from DeepSeek Harness stays on the Krea route".
- New data at rest: prompts, quote ids and job ids in `<DSHPROXY_HOME>/video-picker/` for 30 days, no credential.
- States the four points of section 0.1.

**`0006-api-routes-from-chat.md`** only if question 1 is answered yes. It would replace the last clause of 0004's "Unchanged" paragraph and state that an API-route quote is a dated published price, not a live one.

0003 is not changed: single send, no paid replay, sign-in only by the user.

---

## 12. Open questions for the user

1. **Krea entries only, or API routes too?** On VideoRouter, KovAPI and Callirra the "quote" is a published price from the catalog, and the cap is compared with that same number, so it does not protect against a different bill. The design lists Krea entries only until this is answered.
2. **Should `ok` and `može` buy?** The design says no: only `yes`, `da`, `confirm`, `potvrdi`, `potvrđujem`. They get "reply with only `yes`".
3. **The daily ceiling:** 5 purchases and 5,000 Krea units per 24 hours as the default?

---

## 13. Slices

Each slice is built test-first through one seam. Slices S1 to S3 touch no existing file except one line in `command.js` (S2).

| Slice | What is true when done | Seam | Files |
|---|---|---|---|
| **S1. One purchase per quote** (requirement 2, the riskiest) | A prompt gets a quote; a confirmation buys through a fake `submit` once; every repeat, in any order, across "restarts", finds the first attempt or its unknown outcome. | `create({ ops, clock, random, ... }).answer(body, write)` | new: `picker/{index,store,flow,entries}.js`, the confirmation part of `classify.js`, `test/video-picker-once.test.js` |
| **S2. Everything that must not buy** (requirement 1) | Every row of table 4.3 gives its answer; the ceiling, the purchases switch, the rehearsal, refusal, status follow-up and clean-up work. | the same `answer` | `picker/{classify,flow,store,cli}.js`, one line in `src/video/command.js`, `test/video-picker-refusals.test.js`, `test/video-picker-ceiling.test.js` |
| **S3. The real edges** (requirements 3 to 6) | A real HTTP request gets the event stream with dots; the child calls `run` with the cap; the outcome file is written by the child; the hook leaves other requests alone. | `handle(req, res)` on a test server; `child.main(request, { run })`; `mount(server, options)` | new: `picker/{stream,ops,child}.js`; `src/daemon.js` (4 lines); `test/video-picker-http.test.js`, `test/video-picker-child.test.js`, `test/video-picker-mount.test.js` |
| **S4. The profile and the records** (D1, D6) | Apply writes the route; verify and remove handle it; decision 0005 is written; the rehearsal has been run in the real Harness. | `profile.apply`, `verify`, `remove` with a throwaway `DSH_HOME` | `src/dsh/profile.js`, `src/app.js`, `src/cli.js`, `src/daemon.js` (`syncNow`), `test/profile.test.js` (new tests only), `docs/decisions/0005-…md` |

Tests of S1, written first, in this order:

1. The confirming request arrives twice with a new picker in between; the fake `submit` was called once; the second answer names the first job.
2. The same, where the first `submit` never returns: the second answer waits, and is "unknown" once the clock passes 180 seconds; `submit` was called once.
3. The same, where the outcome is written after the first picker is dropped: the second answer names the job.
4. Two confirmations at once: one `submit`.
5. An invariant over seeded random sequences of quote, confirm, repeat, restart, clock jump, fork and expiry: `submit` is called at most once per quote id, and never for a quote that failed C1 to C5.

Red before green for S1 is "the module does not exist", which proves little. So each S1 test is also run once against a `flow.js` with the claim step commented out, and the report shows tests 1 to 5 failing with two `submit` calls. That is the evidence that the tests test the claim.

Each S2 row of table 4.3 is one test that counts `submit` calls (zero) and, where the row forbids it, `quote` calls (zero).

### What cannot be verified without something real

- **Free, in the real Harness, with purchases off (gate of S4):** the route options load; the entries show under one heading; a quote is replayed word for word (C2); the real tail shapes match section 4.1; the title request is recognised; a three-minute rehearsal answer is not cut by the idle timer; `maxRetries: 0` is honoured; what the Harness shows when the gateway is stopped mid-answer.
- **Only with one paid clip (the user's go):** that Krea's real submit answer passes through this path and ends in a link; that the hold matches the cap; real progress values over a real job.
- **Not verifiable at all without more spending or luck:** a failed or cancelled job (none was ever observed), a real lost answer from Krea, and the power-loss case of R2.

---

## 14. Assumptions about slice V3 to settle before S1

- `catalog.entries()` returns `{ model, resolution, route, label }` at least. What `resolution` holds for a fixed tier decides the id slug.
- The name and shape of the settings function that returns the entries switched on.
- The exact argument vectors for `--resolution` on quote, submit and status, on Krea and on API routes.
- The sentence `run` throws for a combination that is not an entry (it joins the list in 5.5).
- A unit name for the Krea quote amount (`workspace_compute_units` in the command today; `krea_units` in this document is the store's own name).
