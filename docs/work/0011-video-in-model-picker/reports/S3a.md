# Report S3a: the real edges of the video picker

Worktree `picker-edges`, branch `picker-edges`, 2026-11-23. Nothing is committed. No existing file was changed.

Status: **DONE_WITH_CONCERNS**. Every acceptance criterion is met and verified. The concerns are places where the design did not fit the code, and choices the integrator has to know about (section 7).

The lead's two corrections, sent while this was being built, are built in: the body limit is 32 MiB by default, and a request whose `stream` is not exactly `true` is answered with one JSON message.

## 1. Files

New, all of them:

| File | What it is |
|---|---|
| `src/video/picker/entries.js` | the offered entries and their ids |
| `src/video/picker/child.js` | the child process, and `spawnChild` and `argsFor` for the gateway side |
| `src/video/picker/stream.js` | the Anthropic event stream, and the same answer as one message |
| `src/video/picker/http.js` | `claims`, `handler`, `mount` |
| `test/video-picker-entries.test.js` | 6 tests |
| `test/video-picker-http.test.js` | 22 tests |
| `test/video-picker-mount.test.js` | 8 tests |
| `test/video-picker-child.test.js` | 27 tests |

No helper file under `test/` was needed. `node --test` runs every `.js` file under `test/` as a test file, so the stand-in child script of the process test is written into the test's own throwaway folder instead.

## 2. Interfaces, exactly

### `src/video/picker/entries.js`

```js
idOf(entry)        // "seedance-2.5/720p/krea"; model + "/" + slug(resolution) + "/" + route
slug(text)         // lower case; every run outside a-z 0-9 . becomes one "-"   ("2K" -> "2k")
unitOf(entry)      // 'krea_units' (route krea) | 'callirra_credits' (priceBasis 'effective') | 'usd_micros'
byId(list)         // Map(id -> entry) from a list of catalog entries; pure
offered(home)      // Promise<Map(id -> entry)> of the entries switched on (settings.entriesOn)
models(home)       // Promise<Array<{ id, name: label, api: 'video', input: ['text'], contextWindow: 1000000, maxTokens: 4096, efforts: [] }>>
```

- **`offered` and `models` return promises.** `settings.entriesOn(home)` is asynchronous and the settings module exports no synchronous read. They reject when the video settings file cannot be read (the settings module's own error).
- A value of the map is the catalog's entry as `catalog.entries()` gives it (`model, resolution, route, label, modelId, [host], fixedTier, default, durationSeconds, aspectRatio, priceBasis, verifiedOn, sourceUrls`, and `usdMicros` and `credits` where the route has a published price, `reference` on Krea), without `on`, with `id`, and with `unit` **replaced** by `krea_units`, `usd_micros` or `callirra_credits`. The catalog's own `unit` (`workspace_compute_units`, `USD`, `plan_credits`) is not kept.
- Two entries with one id are both left out, as is any later entry with that id, and an entry whose id does not match `^[a-z0-9][a-z0-9./-]{2,79}$`.
- All routes are included (amendment A8). With every entry of today's catalog on there are 41 ids.
- Fresh objects at every call; the settings file is read at every call.

### `src/video/picker/stream.js`

```js
open(res, { model })     // writes 200, the two headers, message_start, content_block_start; returns:
  .text(piece)           //   one content_block_delta; true when handed to the connection, false when dropped
  .close()               //   content_block_stop, message_delta (end_turn), message_stop, end of response; once
  .closed                //   boolean
message(text, { model }) // the non-streaming message object: { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens } }
asText(piece)            // text as is; a number, true/false written out; anything else ''
```

- `open` is the only call that can throw (when the response cannot take headers). `text` and `close` never throw, for any argument and whatever the state of the connection.
- Headers are exactly `content-type: text/event-stream` and `cache-control: no-store`.
- `usage` in `message_start` is `{ input_tokens: 1, output_tokens: 1 }`; the final `output_tokens` is characters / 4, at least 1 and at most 4096.
- `model` is echoed from the request when it is text (cut at 200 characters), otherwise `video`.

### `src/video/picker/http.js`

```js
claims(req)                                    // typeof req.url === 'string' && req.url.startsWith('/dshproxy/video/')
handler({ answer, origin, log, maxBytes })     // -> (req, res) => Promise<undefined>, which never rejects
mount(server, { handler, claims, log })        // throws at mount when the server has no request listener or more than one
PREFIX = '/dshproxy/video/'   MESSAGES_PATH = '/dshproxy/video/v1/messages'
MAX_BODY_BYTES = 33554432     FAILED_LINE = 'Something went wrong inside DSHProxy; nothing further was sent.'
```

`handler` options:

- `answer(body, write, { signal })`. `body` is the parsed request. `write(piece)` never throws; it returns true when the piece was taken and false when it was dropped (client gone, or the piece had no text). `signal` aborts when the client goes away before the answer is complete; it does not abort after a finished answer. `answer` may return a promise or throw.
- `origin`: the gateway's own address, for example `http://127.0.0.1:8417`. Must be an `http:` address; `handler` throws a `TypeError` otherwise, and also when `answer` is not a function or `maxBytes` is not a positive whole number. **So `handler(...)` itself can throw at gateway start: the integrator wraps it and passes `handler: null` to `mount` on failure.**
- `log(line)`: optional. Every line starts with `video picker: `.
- `maxBytes`: default 32 MiB.

What a request gets, in this order, with nothing of the body read before the 413 of the fifth row:

| Request | Answer |
|---|---|
| path (the part before `?`) is not `/dshproxy/video/v1/messages` | 404 |
| method is not `POST` (this includes a model listing: the facts file names no such request) | 404 |
| an `Origin` header is present, even an empty one | 403 |
| `Host`, lower-cased, is not `127.0.0.1:<port>` or `localhost:<port>` of `origin` | 403 |
| `content-type` is not `application/json` (parameters allowed) | 415 |
| `content-length` announces more than `maxBytes` | 413 |
| the body passes `maxBytes` while it is read | 413; what was read is dropped at that moment |
| not UTF-8, not JSON, not an object, no `messages` list, or a message that is not an object with role `user` or `assistant` | 400 |
| `stream === true` | 200, the event stream; `answer` is called after `message_start` and `content_block_start` went out |
| any other `stream` | `answer` is called the same way, its text is collected, and the reply is one JSON message (`stream.message`), 200, `content-type: application/json`, `cache-control: no-store` |

Errors are `{ "type": "error", "error": { "type": "dshproxy_video_<code>", "message": "<fixed sentence>" } }`.

When something fails (amendment A3):

- `answer` throws or rejects, stream open: the text so far stays, then one delta with `FAILED_LINE` (preceded by a blank line when text was written), then the three closing events. The stream is valid and complete.
- `answer` throws or rejects, no stream asked: 500 with a short JSON error; nothing of what `answer` wrote is sent.
- the stream cannot be opened, or anything else fails before a byte went out: 500 with a short JSON error.
- headers went out and the failure is outside `answer`: the response is ended.
- A client that went away while its body was arriving is dropped without an answer and without calling `answer`.
- Log lines: `video picker: refused a request (<code>, HTTP <status>)`, `video picker: the answer failed part-way; it was ended with the fixed line (<Class>)`, `video picker: the answer failed; nothing had been sent (<Class>)`, `video picker: a request failed (<Class>)`. `<Class>` is the name of the error's constructor when it matches `^[A-Za-z][A-Za-z0-9]{0,39}$`, otherwise nothing. Never a message, a path, a header or a body. A `log` that throws is ignored.

`mount(server, { handler, claims = claims, log })`:

- Takes the server's one `request` listener off and puts one listener in its place. A request that `claims` does not hold for goes to the original listener as `forward.call(this, req, res)`; only `req.url` was read.
- `handler` not a function (`null`, `undefined`): requests under `/dshproxy/video/` get 503 with a short JSON error and never reach the original listener.
- A `handler` that throws, or whose promise rejects: 500 when nothing was sent, otherwise the response is ended; one log line with the class name.
- A `claims` that throws counts as "not mine": the request goes to the original listener.
- Must be called before `countRequests` in `daemon.js` prepends its listener; a server with zero or two listeners is refused and left unchanged.

How the two are wired in `daemon.js` (not done here; the file is out of bounds):

```js
let handle = null;
try { handle = http.handler({ answer: picker.answer, origin: state.origin, log }); } catch (error) { log("video picker is off"); }
http.mount(gateway, { handler: handle, log });
```

### `src/video/picker/child.js`

```js
main(request, { run, writeOnce, print, exists })   // Promise<exit code>; 0 = one line printed
start({ input, run, writeOnce, print, exists })    // Promise<exit code>; reads `input` (standard input) to its end
outcomeOf(resultOrError)                           // { state: 'submitted', jobId, status, ... } | { state: 'not-sent', reason } | { state: 'unknown' }
reasonOf(error)                                    // 'sign-in' | 'refused' | 'bad-request' | 'over-cap' | 'no-key' | null
argsFor(kind, entry, { prompt, cap, jobId })       // string[]; throws TypeError
spawnChild(request, { execPath, timeoutMs, signal, home, env, script, spawn })   // Promise; never rejects
parseRequest(textOrBuffer)                         // request | null
environment(source, request, home)                 // the child's environment object
ENVIRONMENT, KEY_VARIABLES, MAX_REQUEST_BYTES (65536)
```

**The request** (one line of JSON on standard input, at most 64 KiB):

```js
{ kind: 'quote' | 'status', args: [...] }
{ kind: 'submit', args: [...], outcomeFile: '<absolute path>', nonce: '<1 to 256 printable ASCII characters, no space>' }
```

- `args` is 3 to 16 strings and **its first word must equal `kind`**, so a request can never run `key`, `settings`, `entries` or `balance`.
- No other key is accepted. `outcomeFile` and `nonce` are required for a submit and must be absent (or `undefined`) otherwise.
- Anything else: the child exits with code 2, prints nothing, loads no command.

**What the child does**: calls `require('../command').run([...args], out, { env: process.env })` once. For a submit it then writes the outcome file with `fs.openSync(file, 'wx')`, `writeSync`, `fsyncSync`, `closeSync`, and only then prints. Exit code 0 whenever a line was printed, whatever the line says.

**The outcome file** (one line of JSON; the nonce first):

```js
{ "nonce": "...", "state": "submitted", "jobId": "...", "status": "...", ["outputUrl"], ["reservedCredits"], ["chargedUsd"] }
{ "nonce": "...", "state": "not-sent", "reason": "sign-in" | "refused" | "bad-request" | "over-cap" | "no-key" }
{ "nonce": "...", "state": "unknown" }
```

**The printed line** (always `{ v: 1, kind, ok, ... }`):

```js
// quote
{ v: 1, kind: 'quote', ok: true, unit: 'krea_units', amount, available, estimated, affordable }
{ v: 1, kind: 'quote', ok: true, unit: 'usd_micros', amount, verifiedOn }
{ v: 1, kind: 'quote', ok: true, unit: 'callirra_credits', amount, usdMicros, verifiedOn }
{ v: 1, kind: 'quote', ok: false, reason }          // reason: the five codes, or 'failed'
// status
{ v: 1, kind: 'status', ok: true, jobId, status, [outputUrl], [chargedUsd], [reservedCredits] }
{ v: 1, kind: 'status', ok: false, reason }
// submit: ok is true exactly when state is 'submitted'
{ v: 1, kind: 'submit', ok, state, [jobId, status, ...] | [reason], recorded }
```

- `recorded` says whether this run wrote the outcome file. `false` with `state: 'submitted'` means the purchase happened and the file could not be created (it was already there, or the disk failed); the line is then the only place the job id is.
- Checked fields: `jobId` `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`; `status` `^[a-z][a-z0-9_-]{0,63}$`; numbers finite and not negative (`amount` of a published price and `usdMicros` whole); `verifiedOn` `YYYY-MM-DD`; `outputUrl` only for status `completed` or `succeeded`, `https`, at most 8192 characters, no user name, password or fragment, and none of ``( ) [ ] < > " ' ` \`` or blank space. An unusable link is left out and the job is still reported.
- A status answer about another job id than the one asked is `ok: false, reason: 'failed'`.
- A quote whose unit does not belong to the route asked (Krea units on an API route or the reverse) is `failed`.

**`argsFor`** builds, with `R` = `'--resolution', entry.resolution` unless `entry.fixedTier === true`:

| Kind | Krea | Dollar routes | Callirra |
|---|---|---|---|
| quote | `quote M krea R --prompt P` | `quote M ROUTE R` | `quote M callirra R` |
| submit | `submit M krea --max-units CAP --confirm-charge R P` | `submit M ROUTE --max-usd CAP --confirm-charge R P` | `submit M callirra --max-credits CAP --confirm-charge R P` |
| status | `status M krea JOB R` | `status M ROUTE JOB R` | `status M callirra JOB R` |

- `entry` needs `model`, `resolution`, `route`, `unit` (as `entries.offered` gives it) and, for a fixed tier, `fixedTier: true`. An entry passed without `fixedTier` gets `--resolution <tier name>`, which the real command also accepts and sends to Krea as no resolution (tested).
- `cap` is **the text for the flag**: Krea `^\d{1,9}(\.\d{1,6})?$`; dollars, in dollars, `^\d{1,6}(\.\d{1,6})?$` (so 702125 micros is `"0.702125"`); credits `^\d{1,6}$`; and greater than zero. `argsFor` does no rounding and no conversion.
- `--resolution` always stands before the prompt, so a prompt can never be read as the option.
- Throws `TypeError` for: an unknown kind; an entry without those fields or whose unit does not belong to its route; a prompt that is empty, starts with `--`, holds a NUL or is over 16,000 bytes; a cap in another form; a job id outside the pattern. An API-route quote takes no prompt.
- A status on an API route needs the resolution: for VideoRouter the provider model id depends on it.

**`spawnChild`** resolves to one of:

```js
{ ok: true,  started: true,  result }   // result: the child's line, checked again on this side with the same rules
{ ok: false, started: false, why: 'request' }    // not a valid request or over 64 KiB; no process
{ ok: false, started: false, why: 'abandoned' }  // signal already aborted; no process
{ ok: false, started: false, why: 'spawn' }      // the process could not be started
{ ok: false, started: true,  why: 'exit' }       // ended with a non-zero code
{ ok: false, started: true,  why: 'output' }     // ended with code 0 without one valid line
{ ok: false, started: true,  why: 'timeout' }    // quote and status only
{ ok: false, started: true,  why: 'abandoned' }  // signal aborted while waiting
```

- Started as `spawn(execPath, [script], { env, stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true })`; the request is written once with `stdin.end(line)`. Standard error of the child is never read.
- `execPath` defaults to `process.execPath`, as `workspace.js` does for the Krea helper. `script` (default: `child.js` itself) and `spawn` exist for tests; they are function arguments, not environment variables, so nothing outside the calling code can set them.
- `home`: the gateway's data folder; it becomes the child's `DSHPROXY_HOME` and wins over the one in the environment. **Pass `state.home`.**
- **A submit child is never killed and never timed out**: `timeoutMs` is ignored for it. When `signal` aborts while it runs, the promise resolves `abandoned`, the child and its pipes are unreferenced, and the child finishes and writes its outcome file (amendment A7). A quote or status child is killed on abort and on timeout.
- `started: false` is the one case in which the gateway knows nothing was sent.

## 3. The environment list

`ENVIRONMENT`, copied from the gateway's environment when set, never looked at:

| Name | Why, checked against the code |
|---|---|
| `SystemRoot` | `src/secrets.js:57` finds `powershell.exe` under it to unlock the master key (DPAPI); `src/krea-helper/oauth.js:75` refuses without it; `workspace.js:45` hands it to the Krea helper. |
| `LOCALAPPDATA` | `oauth.js:85-86`: the Krea sign-in is `%LOCALAPPDATA%\DSHProxy\KreaOAuth\session.v1`; `workspace.js:45` hands it on. |
| `TEMP`, `TMP` | `workspace.js:45` hands both to the Krea helper; `oauth.js:79` hands `TEMP` to PowerShell. |
| `USERPROFILE` | `src/settings.js:41` (`os.homedir()`) when `DSHPROXY_HOME` is not set; `workspace.js:45` hands it on. |
| `DSHPROXY_HOME` | `command.js:143` and `keys.js`: the folder of `video-keys.json` and `master.key`. |
| `APPDATA` | **Kept because the design lists it; nothing in DSHProxy reads it.** An experiment on this machine created and unlocked a master key through the real `secrets.loadMasterKey` in a child with the list, with the list minus `APPDATA`, and with `DSHPROXY_HOME` alone: all three worked. It is a folder path, not a secret. It can be removed. |

`KEY_VARIABLES` (`VIDEOROUTER_API_KEY`, `KOVAPI_API_KEY`, `CALLIRRA_API_KEY`), when set, **only when the request's route is not `krea`**: a Krea child has no use for a provider key. The names are the ones in `keys.js:25-27`.

Added to the design's list: nothing. Left out on purpose: `NODE_OPTIONS` and `NODE_PATH` (could load code into the child; the child needs neither, it uses built-in modules and files of the checkout only), `PATH` (PowerShell and Node are started by full path), `DSH_HOME`, `DSHPROXY_API_KEY`, and `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY` (see concern 6).

**The design did not fit the code here:** on Windows, Node adds eleven names to every process it starts when the parent has them and the given environment does not: `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR` (observed: a child given only `DSHPROXY_HOME` saw exactly those twelve). So "the child gets only the listed names" is true of what the gateway passes, not of what the child sees. None of the eleven is a secret. The process test checks that the child saw no name outside the list plus those eleven, and none of the planted ones (`NODE_OPTIONS`, `NODE_PATH`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DSHPROXY_API_KEY`, `DSH_HOME`, `KREA_API_TOKEN`, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `PICKER_EDGE_PLANTED`).

## 4. The "not sent" sentences

A failed submit is `not-sent` only when `run` threw a real `Error` whose message matches one of these. Everything else is `unknown`.

| Reason | Match | Sentence | Where it is produced | Why it is before the paid request |
|---|---|---|---|---|
| `sign-in` | begins | `Krea workspace sign-in required.` | `src/video/workspace.js:53`, from the helper's `KREA_LOGIN_REQUIRED` | `bin/dshproxy-krea.js:19` gets the token before anything is called; `mcp.js:125-130` turns a 401 on the paid call itself into `KREA_UNCERTAIN`. |
| `refused` | begins | `Krea refused the request` | `workspace.js:53`, from `KREA_REFUSED` | `mcp.js:120-122` refuses on the preflight (cap, balance); the paid call and the reading of its receipt are inside one `try` whose every failure is `KREA_UNCERTAIN` (`mcp.js:124-130`); `bin/dshproxy-krea.js:20-25` maps anything after the call to `KREA_UNCERTAIN` for a submit. |
| `bad-request` | begins | `Krea workspace OAuth requires explicit workspace parameters.` | `workspace.js:25` | thrown while the request is built |
| `bad-request` | exact | `Unknown video model` | `command.js:102`, `catalog.js:125` | before a key is looked for |
| `bad-request` | begins | `Unsupported video route for ` | `catalog.js:130`, `catalog.js:204` (also `keys.js:57`) | the same |
| `bad-request` | begins | `Unsupported video resolution for ` | `catalog.js:151`: V3's sentence for a combination that is not an entry | the same |
| `bad-request` | ends | `: it takes no resolution.` | `catalog.js:150`: V3's sentence for a resolution given to a fixed tier | the same |
| `bad-request` | exact | `Invalid video route or model` | `transport.js:62` | before `fetch` |
| `bad-request` | exact | `Invalid video prompt` | `transport.js:65` | before `fetch` |
| `bad-request` | exact | `Invalid video provider credential` | `transport.js:64` | before `fetch` |
| `over-cap` | exact | `The quote exceeds --max-usd; no job submitted.` | `command.js:139` | before a key is looked for |
| `over-cap` | exact | `Insufficient credit budget; no job submitted.` | `command.js:138` | the same |
| `no-key` | ends | `No request sent.` | `keys.js:210` (no key) and `keys.js:212` (a saved key that cannot be read) | thrown by `keys.resolve`, before the transport is loaded |

The reasons are tried in this order, so `workspace.js:25`, which also ends with `No request sent.`, is `bad-request`.

The test `each "not sent" sentence, produced by the real module that owns it, is recognised with its reason` makes the real `command.run`, the real `transport.submit`, the real `keys.resolve` and the real `workspace.invoke` throw each of the 18 cases and checks the reason. A sentence reworded in those modules fails it. For the two Krea sentences the helper process is replaced by a stand-in that prints the helper's code (`KREA_LOGIN_REQUIRED`, `KREA_REFUSED`); the real helper is never started (section 6).

Real failures that are **not** on the list and are therefore `unknown`, each also produced with the real modules in a test: `Video submission unconfirmed; do not retry until provider history is checked.` (a 500, a thrown `fetch`, an invalid job id in the answer), `Invalid Krea job response. Do not resubmit automatically.`, `Invalid Krea output URL.`, `Krea helper did not return a verified result…` (`KREA_UNCERTAIN`, unreadable output, a helper that prints the sign-in sentence instead of its code), and three that are refused before any request but are not in design 5.5: `--resolution takes one resolution…`, `Invalid USD budget…`, the usage text. See concern 3.

## 5. Red and green

**Red** (tests written first, before any file under `src/video/picker/` existed):

```
Error: Cannot find module '../src/video/picker/entries'
✖ test\video-picker-child.test.js (66.0057ms)
Error: Cannot find module '../src/video/picker/entries'
✖ test\video-picker-entries.test.js (64.4347ms)
Error: Cannot find module '../src/video/picker/http'
✖ test\video-picker-http.test.js (57.3495ms)
Error: Cannot find module '../src/video/picker/http'
✖ test\video-picker-mount.test.js (57.4914ms)
ℹ tests 4
ℹ pass 0
ℹ fail 4
```

"The module does not exist" proves little, so each behaviour was also broken on purpose in the finished code, one change at a time, and the matching test file run. 40 changes, each put back afterwards; all 40 were caught (a test failed, or was cancelled by its time limit, and the run ended with an error):

| Change | Failing tests |
|---|---|
| http: body touched before the door | 1 |
| http: Origin check removed | 2 |
| http: Host check accepts any host | 1 |
| http: failure of `answer` not caught in the stream | 5 |
| http: signal never aborts | 2 cancelled by their 30 s limit |
| http: no limit while reading | 1 |
| http: stream opened even when not asked | 3 |
| http: messages not checked | 1 |
| http: error text logged | 6 |
| mount: forwarded without `this` | 1 |
| mount: reads the method and headers before forwarding | 1 |
| mount: no handler falls through to chat | 1 |
| mount: rejection of the handler not caught | 1 |
| mount: listener count not checked | 1 |
| stream: a tool block instead of text | 1 |
| stream: write after the client has gone not guarded | 1 |
| child: line printed before the outcome is written | 5 |
| child: outcome file overwritten (`w` for `wx`) | 1 |
| child: nonce not echoed | 3 |
| child: a reworded sign-in sentence | 4 |
| child: a reworded refusal sentence | 2 |
| child: a reworded over-cap sentence | 1 |
| child: a reworded no-key ending | 2 |
| child: an unconfirmed submission counted as not sent | 2 |
| child: any error is "not sent" | 3 |
| child: `run` called twice | 7 |
| child: error text printed | 3 |
| child: any first word accepted in `args` | 1, and 1 cancelled by its limit |
| child: submit without outcome file accepted | 1, and 1 cancelled by its limit |
| child: resolution dropped from the submit list | 2 |
| child: wrong flag for dollars | 2 |
| child: submit child timed out | 1 |
| child: submit child killed on abort | 1 |
| child: whole environment handed on | 3 |
| child: a shell is used | 3 |
| child: the child's line not checked again | 2 |
| child: a link with a password passes | 2 |
| entries: duplicates kept | 1 |
| entries: resolution not slugged | 3 |
| entries: only Krea offered | 3 |

One change in the first run survived because the change itself was wrong (it never reached the code it meant to break); it was corrected and is the "reads the method and headers" row. Three changes first made a test wait for ever instead of failing; the nine tests that wait for an event now have a 30-second limit, and the three rows show the second run.

**Green**, from the worktree root with `NODE_PATH` set and `DSHPROXY_HOME` on a folder under `%TEMP%` that does not exist:

```
node --test test/video-picker-http.test.js test/video-picker-mount.test.js test/video-picker-child.test.js test/video-picker-entries.test.js
ℹ tests 63
ℹ pass 63
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0

node --test
ℹ tests 759
ℹ pass 759
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0

node scripts/check.js
84 files OK        (exit 0)
```

759 is the 696 from before plus these 63. The focused run takes under one second. After the runs: the `DSHPROXY_HOME` folder was not created, no folder of these tests is left under `%TEMP%`, and `git status` shows only the new files.

## 6. What was and was not run

- No request to any provider, no credential, no job. `video submit`, `video quote … krea`, `video balance` and `video status` were not run.
- In `test/video-picker-child.test.js` the network is a function that counts and throws (the count is asserted to be 0), and `src/video/workspace.js` is loaded while `child_process.spawn` is a stand-in, so in that process the Krea helper cannot be started by anything; every start of the stand-in is recorded and checked.
- The real `child.js` is started as a process only with input that is not a request (empty, garbage, a request without `args`, 70 KB): it exits 2 and prints nothing. It is never started with a submit, nor with any valid request.
- The process test of `spawnChild` runs a script written into its throwaway folder: the real child code with a stub in place of the video command, a `status` request.
- One experiment outside the suite: a throwaway master key created and unlocked through the real `src/secrets.js` (Windows DPAPI, a local operation) in a folder under `%TEMP%`, which was deleted. That is the evidence in section 3.
- Nothing was sent to `127.0.0.1:8417` or `8418`; every test server listens on port 0. `C:\Users\USER\.dshproxy` and `C:\Users\USER\.dsh` were not touched.

## 7. Concerns, and where the design did not fit the code

1. **`offered(home)` and `models(home)` are asynchronous** (section 2). Design 2.4 and 9.2 write them as plain values. The gateway and the profile writer must `await` them.
2. **Windows adds environment names** (section 3). The criterion "the child gets only the listed environment names" is met for what is passed, and tested as "nothing outside the list and the eleven names Node adds".
3. **The "not sent" list is closed, as the brief says.** Other refusals that provably happen before any request (`--resolution takes one resolution…`, `Invalid USD budget…`, `Specify both model and route.`, the usage text) are `unknown` for a submit. `argsFor` cannot build a list that causes them, so they need a mistake elsewhere to appear; if they do, the user is told the outcome is unknown and the amount counts against the ceiling. Adding them is a design decision, not made here.
4. **Two things the child does that the brief does not ask for**, both on the side of not sending: a submit is not started (exit code 3, nothing printed) when its outcome file already exists or the file's folder does not; and `spawnChild` starts nothing when `signal` has already aborted, for a submit too. Consequences for the integrator: the `outcomes` folder must exist before the child is started; and after a claim, an `abandoned` answer with `started: false` means nothing was sent, which can be recorded as `not-sent`. If the purchase should go ahead even though the client left between the claim and the start, do not pass `signal` to the submit.
5. **A submit child is not detached and does not ignore Ctrl+C.** It outlives a gateway process that exits. A Ctrl+C in a console the gateway runs in reaches the child as well, and a job object that kills its members would too; the outcome is then missing, which reads as unknown. Not built because it cannot be tested here.
6. **`NODE_EXTRA_CA_CERTS` and `HTTPS_PROXY` are not passed**, as in the design's list. On a machine that needs them to reach a provider, an API-route submit fails inside `fetch`, which the transport reports as unconfirmed, so the answer is unknown. The Krea helper already runs without them today.
7. **The address check ignores a query string**: `/dshproxy/video/v1/messages?beta=true` is the messages path. The brief says "exactly"; whether the application appends a query is not in the facts file, and refusing it would fail in the rehearsal for no gain in safety. One line to change if it must be strict.
8. **An `answer` that writes nothing** gives a stream with no text delta (the application treats that as an empty response) or a message with empty text. `http.js` does not invent a sentence. `answer` should always write.
9. **Status codes**: design 4.3 row 1 says "403 or 404". Used: 404 for a wrong path or method, 403 for `Origin` and `Host`, 415 for the content type (the brief's addition to the row), 413 for size.
10. **The link check is stricter than design section 8**: it also refuses a fragment and the characters that can end a Markdown link, since the link is shown as `[Open the clip](…)`. A provider whose links contain `(` or `'` would lose its link (the job is still reported).
11. **A secret that has the form of a job id cannot be told from a job id.** The planted-secret test uses a string with `.`, `/`, `+` and `=`, which no checked field admits. `transport.js` already refuses a job id that contains the provider key.
12. **`process.execPath`** is used for the child, as `workspace.js` does. If the gateway is ever started by a program that is not Node, the integrator passes `execPath`.

## 8. Not done

- `src/daemon.js` is not changed: nothing is mounted yet. `index.js`, `store.js`, `flow.js`, `classify.js` and `ops.js` belong to the other worker and the integrator.
- No commit.
