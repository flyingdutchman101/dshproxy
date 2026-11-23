# Brief: S3a — the real edges of the video picker: HTTP, the child process, the entry list

You are the implementer for one slice. Read this file fully before acting. You start with no knowledge of the conversation that produced it.

## Objective

DSHProxy's local gateway (127.0.0.1:8417) will answer "video entries" picked in a chat application's model picker: a prompt gets a quote, a confirming reply buys one paid clip. Another worker is building the decision logic (`answer(body, write)`: which request quotes, which buys, the one-purchase record). **You build the edges around it**, each against fakes:

1. the HTTP side: which requests the picker takes, the checks before anything is read, the Anthropic event stream that carries the answer, and the mount that puts it in front of the gateway's own handler without ever endangering chat traffic;
2. the child process that makes the real quote, purchase or status call through the existing video command, so the gateway process never holds a credential;
3. the list of entries that are offered, with their ids.

Nothing here contacts a provider or spends anything.

## Read first

Your worktree: `C:\Users\USER\Desktop\Development\DSHProxy\.agents\worktrees\picker-edges`, branch `picker-edges` (from `video-catalog`, which already has the catalog by resolution). You edit files only there.

Design, read-only, in `C:\Users\USER\Desktop\Development\DSHProxy\.agents\worktrees\video-picker\docs\work\0011-video-in-model-picker\`:

- `design-D-amendments.md`: read all, first. **Where it and `design-D.md` disagree, the amendments win** (A3, A7 and A8 are yours).
- `design-D.md`: sections 0, 1, 2 (route, path, model id), row 1 of the table in 4.3 (what is refused at the door), 5.2 steps 4 to 6 and 5.5 (the child, the outcome, which failures count as "not sent"), 6.2 to 6.5 (what a stream looks like), 8 (credentials and secrets), 9 (the hook and the seams).
- `research\dsh-model-facts.md`: sections 5 and 6 (timers; the minimum valid answer on the Anthropic messages protocol).

In your worktree: `src\video\command.js` (`run(args, out, options)`: the exact argument forms for quote, submit and status with `--resolution`, what it prints, the sentences it throws), `src\video\catalog.js` (`entries()`), `src\video\settings.js` (`entriesOn(home)`), `src\cli.js` (how it calls the video command), `src\daemon.js` around `createGateway(` (read only; you do not edit it), `src\gateway\server.js` (read only: how it answers errors and reads bodies).

## What to build (new files only)

**`src\video\picker\entries.js`**
- `idOf(entry)`: `model + "/" + slug(resolution) + "/" + route`, slug as design 2.4.
- `offered(home)`: a `Map` from id to entry for the entries switched on (`settings.entriesOn`), built from the catalog; each value has at least `{ id, model, resolution, route, label, unit }` where `unit` is `krea_units`, `usd_micros` or `callirra_credits`. Two entries with one id are both left out. All routes are included (amendment A8).
- `models(home)`: the same entries as the list the profile writer needs: `{ id, name: label, api: "video", input: ["text"], contextWindow: 1000000, maxTokens: 4096, efforts: [] }`.
- A test walks the real catalog with every entry switched on: ids unique, matching `^[a-z0-9][a-z0-9./-]{2,79}$`.

**`src\video\picker\child.js`** (runs as its own process; also exports for tests)
- Reads one line of JSON from standard input: `{ kind: "quote"|"submit"|"status", args, outcomeFile?, nonce? }` (at most 64 KiB; anything else: exit non-zero, nothing run). `args` is the argument list for the video command; the prompt travels inside it, never on a command line.
- Calls `require('../command').run(args, out, { env: process.env })` exactly once.
- For `submit`: **writes the outcome file itself, write-once (`wx`), flushed, before printing anything**, with the `nonce` echoed: `{ nonce, state: "submitted", jobId, status, ... }`, or `{ nonce, state: "not-sent", reason }` only for the failures listed in design 5.5 (take the sentences from the real `command.js` and the modules it calls; a test pins each sentence against the real modules so a reworded message fails the test rather than silently becoming "not sent"), or `{ nonce, state: "unknown" }` for everything else, including a result without a valid job id and status.
- Prints one line of JSON with validated fields only (design section 8: job id and status patterns, numbers, one checked `https` link without user name or password). Never the text of an error, never standard error of anything below it.
- Exports `main(request, { run, writeOnce })` and `outcomeOf(resultOrError)` so tests call them in-process with a fake `run`. **No test starts the real child with a submit.**
- `argsFor(kind, entry, { prompt, cap, jobId })`: the one function that builds the argument lists for every route (Krea: `--max-units`; dollar routes: `--max-usd`; Callirra: `--max-credits`; `--resolution` except for a fixed tier). A test runs each list through the real `command.run` with its `workspace`/transport seams faked and checks the cap, the prompt and the resolution arrive.
- `spawnChild(request, { execPath, timeoutMs? })` used by the gateway side: `shell: false`, `windowsHide: true`, the fixed environment list of design section 8 (check against the real code what `command.js`, the key store and the Krea helper need, DPAPI included, and say in the report what you added or left out and why), standard input written once. **A submit child is never killed and never timed out by the gateway**; quote and status children may have a time limit.

**`src\video\picker\stream.js`**
- Writes the event stream of design 6.5 to a response: `open(res)` (status, headers, `message_start`, `content_block_start`), `text(piece)`, `close()` (the three closing events). Text is escaped by `JSON.stringify` only. After the client has gone, writes are dropped without throwing. Never a tool call or a thinking block.

**`src\video\picker\http.js`**
- `claims(req)`: `req.url` starts with `/dshproxy/video/`. Reads nothing else.
- `handler({ answer, origin, log, maxBytes = 1048576 })` returns `(req, res)`:
  - Refused at the door, before the body is read, with a short JSON error (design 4.3 row 1): not `POST`; path not exactly `/dshproxy/video/v1/messages`; an `Origin` header present; `Host` not the gateway's own `127.0.0.1:<port>` or `localhost:<port>`; `content-type` not JSON.
  - Body: at most `maxBytes`, valid JSON object; otherwise a short error. A model listing request on this path, if the facts file says the application makes one, is answered as the facts file requires; otherwise 404.
  - Then opens the stream and calls `answer(body, write, { signal })`, where `signal` aborts when the client goes away. Whatever `answer` writes becomes text deltas.
  - **Nothing here can take the process down (amendment A3):** a synchronous throw or a rejected promise from `answer`, from the stream or from parsing is caught; if nothing was sent, a 500 with a short JSON error; if the stream is open, one last line "Something went wrong inside DSHProxy; nothing further was sent." and a clean close. The log line carries no request content and no error text beyond the error's class name.
- `mount(server, { handler, claims })`: as design 9.1, with these changes: the picker branch is wrapped so that even a throwing `handler` cannot escape; and when no handler could be made (the caller passes `handler: null`), requests under `/dshproxy/video/` are answered 503 with a short JSON error instead of reaching the chat handler. Every other request reaches the original listener with the same `this`, `req` and `res`, and nothing is read from it first.

## Acceptance criteria

- HTTP tests on a plain `http.createServer` on port 0 with a fake `answer`: every door refusal (and that `answer` was not called and the body was not read); the exact event sequence and headers for a short answer; pieces written over time arrive as separate deltas; a client that hangs up mid-answer (the signal aborts, later writes do not throw, the server keeps serving); `answer` throwing synchronously, rejecting before the first write, and rejecting after some text: each leaves the server alive and the next request is served; a 2 MiB body; a body that is not an object.
- Mount tests on a plain server whose own handler answers `forwarded`: other paths reach it untouched (same objects; a spy shows nothing was read); a server with zero or two listeners is refused at mount; `handler: null` gives 503 on the video path and `forwarded` elsewhere; a handler that throws leaves the server alive.
- Child tests in-process: each kind; each "not sent" sentence pinned against the real modules; an unknown error and a malformed result give `unknown`; the outcome is written before the line is printed (order observed through the fakes); an existing outcome file is not overwritten; a planted secret-shaped string in every free-text field of a fake result or error appears in no output line and no outcome file; oversized or malformed input runs nothing.
- One process test for `spawnChild` with a `kind: "status"` request against a stub command (through an environment variable honoured only when `NODE_ENV=test`, or by pointing `execPath` arguments at a test script: your choice, but no hook that could run in production): the child gets only the listed environment names, and its one line comes back.
- Red before green where there is a "before" (for new files: write the test first and record the failure). No existing file is changed. `node --test` and `node scripts/check.js` pass.

## Files you own

- `src\video\picker\entries.js`, `child.js`, `stream.js`, `http.js` (new). **Not** `index.js`, `store.js`, `flow.js`, `classify.js`: another worker owns those, in another worktree.
- `test\video-picker-http.test.js`, `test\video-picker-mount.test.js`, `test\video-picker-child.test.js`, `test\video-picker-entries.test.js`, and helper files under `test\` whose names start with `video-picker-edge-` (new)
- `docs\work\0011-video-in-model-picker\reports\S3a.md` in your worktree (create the folders)

## Out of bounds

- Every existing file, in particular `src\daemon.js`, `src\gateway\`, `src\video\command.js`, `src\cli.js`, `README.md`.
- **No request to any provider, no credential, nothing that could start a job.** Do not run `video submit`, `video quote ... krea`, `video balance` or `video status` for real.
- `C:\Users\USER\.dshproxy`, `C:\Users\USER\.dsh`, the running DSHProxy (nothing to `127.0.0.1:8417` or `8418`; test servers use port 0), the main checkout and every other worktree. Every command sets `DSHPROXY_HOME` to a throwaway folder under `%TEMP%`.
- No new dependency. No commit, push, subagents, goals.

## Verify

From your worktree root, with `$env:NODE_PATH='C:\Users\USER\Desktop\Development\DSHProxy\node_modules'`:

- `node --test test/video-picker-http.test.js test/video-picker-mount.test.js test/video-picker-child.test.js test/video-picker-entries.test.js` : 0 fail
- `node --test` : 0 fail (696 before your change)
- `node scripts/check.js` : exit 0

## Rules you would not otherwise know

- Node.js CommonJS, Windows; the shell is Windows PowerShell 5.1 (`powershell`). Write files as UTF-8 without BOM.
- One paid request per job, sent once, never retried. Nothing in this slice may call `run` twice for one request, restart a child, or re-send after a timeout.
- The suite also runs on a clean CI machine; tests must not depend on this machine, on timing luck, or leave folders or processes behind.

## Return

Write the full report to `docs\work\0011-video-in-model-picker\reports\S3a.md` in your worktree: what you built, the exact interfaces you exported (the integrator wires them to the other worker's `answer` and needs them precisely), the environment list with reasons, the "not sent" sentences and where each comes from, the red and green output, and where the design did not fit the code.

Then reply with at most 14 lines, in exactly this shape:

```
Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Files changed: <paths>
Verify: <command> -> <result line>
Interfaces: <one line each: entries, child, stream, http>
Concerns: <one line each, or none>
Report: <path>
```

Use `BLOCKED` when a criterion is wrong or cannot be met; say which and why. Do not work around it.
