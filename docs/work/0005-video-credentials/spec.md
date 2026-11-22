# Video credentials in the desktop app

Requested 2026-11-22: "make a way to add keys to API keys in video models and auth Krea model under accounts." Base `3f6eb33`, worktree `video-routing`. Changes ADR 0002 and 0003: see `docs/decisions/0004-video-credentials-in-app.md`.

## Outcome

- Video > API keys: the user can save, replace and remove the key of each pay-per-use video provider (VideoRouter, KovAPI, Callirra) in the app.
- Video > Accounts: the user can sign in to and out of the Krea workspace from the app and see whether a sign-in is present.

## Part 1: saved video API keys (DSHProxy CLI, `src/video`)

Providers: `videorouter` (serves routes `videorouter` and `videorouter-replicate`), `kovapi`, `callirra`.

Storage: `<DSHPROXY_HOME>/video-keys.json`, one entry per provider, each key encrypted with the existing DSHProxy master key (`src/secrets.js`, the same protection as the Chat API keys). Not in `settings.json`, whose save drops unknown entries. Written atomically (temporary file, then rename). The plain key is never written to disk, a log, a command line, an environment variable of a child process, or any output.

Commands (all print JSON, like `video settings`):

| Command | Result |
|---|---|
| `video key list` | `{"providers":[{"provider","label","variable","routes":[...],"saved":bool,"readable":bool,"inEnvironment":bool}]}`. `readable` is false when a saved key cannot be decrypted. Never a key or part of one. |
| `video key set PROVIDER` | Reads the key from standard input, like `dshproxy key set`. Trims it. Refuses an empty key, one longer than 512 characters, or one with any character outside printable ASCII (0x21 to 0x7E): the transport refuses such a key before any request, so it could never be used. Prints `{"provider","saved":true}`. |
| `video key remove PROVIDER` | Prints `{"provider","saved":false,"removed":bool}`. |

Use: `video submit` and `video status` on an API route take the provider's environment variable when it is set and not blank, otherwise the saved key. With neither: refuse before any request, naming both ways to provide one. With a saved key that cannot be read and no variable: refuse before any request and say to enter it again. Nothing else about submit, status, quotes, caps or single-send changes.

Unknown provider, extra arguments, or a missing key on standard input are refusals with a usage line. Help text lists the three commands and no longer says keys come only from environment variables.

## Part 2: Krea sign-in state (helper, `bin/dshproxy-krea.js`, `src/krea-helper`)

New helper command `status`: prints one line, `{"signedIn":true,"expiresAt":<ms since epoch>}` or `{"signedIn":false}`, exit code 0 in both cases. "Signed in" uses the same rule as a request: stored session for the Krea resource, well-formed token, more than 30 seconds left. Any failure to read the store is `{"signedIn":false}`. Never prints the token. Contacts nothing.

`login` and `logout` keep their behaviour. The routing CLI still never imports the helper's modules and never sees the token.

## Part 3: desktop app (`app/DSHProxyApp.cs`, `app/Skin.cs`), after the responsive layout lands

Video > API keys:
- One row per provider: logo slot or text as today, environment variable name, billed in, state. States: "Saved", "Saved, cannot be read: enter it again", "Not saved", each with " · also set in the environment" when `inEnvironment`. No state claims the key works: it is not checked against the provider.
- Buttons: "Add or replace key..." (existing key dialog; key sent on standard input to `video key set`), "Remove key" (confirmation first). Disabled without a selected row.
- Page note says the key is stored encrypted like the Chat keys, is used by DSHProxy's video command, and that video generation from DeepSeek Harness works on the Krea route only for now.

Video > Accounts:
- Krea row state from helper `status`: "Signed in · until <local date and time>" or "Not signed in". Read on entering the page and after sign-in or sign-out, never on a timer.
- "Sign in to Krea...": starts `node bin\dshproxy-krea.js login` hidden, reads the consent address from its first output line, opens it in the default browser only if it is `https` on `krea.ai`, `www.krea.ai` or `api.krea.ai`; otherwise stops the helper and reports a refusal. Shows "Waiting for you to finish in the browser" with Cancel (stops the helper). Result: "Signed in" or one fixed message per helper code. The consent address is never written to the log.
- "Sign out": confirmation, then `logout`, then re-read.
- The note says sign-in with a live Krea workspace has not been verified in this build, until it has been.

Both pages: every helper or CLI call runs off the UI thread, one at a time. Preview windows (`--preview`, `--preview-limits`) start no process and read no file: sample rows, actions answer "Sample only".

## Not in this change

- Video generation or status on API routes from DeepSeek Harness. The bundle still refuses API routes before any quote or question.
- Checking a key against a provider, showing balances, or spending anything.
- A Krea client-id field, token refresh, or automatic sign-in.

## Verification

- Red before green for each new behaviour at the CLI and helper seams, with a temporary `DSHPROXY_HOME`, a test master key and no network. Include: key never appears in any output, file or thrown message; environment variable wins over a saved key; unreadable saved key refuses before a request; `status` output for present, expired, missing and corrupt sessions.
- `npm test`, `npm run check`, `app\build.ps1`. App pages checked in preview at 860x600 and one wide size, plus a seam check against a temporary home with a synthetic key.
- Not possible without the user: a real Krea sign-in, and a real provider accepting a saved key.
