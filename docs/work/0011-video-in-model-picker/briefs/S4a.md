# Brief: S4a — the paid video route in the DeepSeek Harness profile

You are the implementer for one slice. Read this file fully before acting. You start with no knowledge of the conversation that produced it.

## Objective

DSHProxy writes provider routes with model lists into DeepSeek Harness profiles (`dshproxy dsh apply`), checks them (`dsh verify`) and removes them (`dsh remove`). Today there are four routes. This slice teaches that code a fifth, `dshproxy-video`: a list of paid video entries that a person can pick in the Harness chat model picker. Because picking one can lead to a real purchase, the route must never become selectable for agents or be the default model, and `verify` must say so when a profile breaks that.

This slice is only the profile module and its tests. Who calls it with the list of entries, and what answers the route, is other people's work.

## Read first

Your worktree: `C:\Users\USER\Desktop\Development\DSHProxy\.agents\worktrees\picker-profile`, branch `picker-profile` (from `main`). You edit files only there.

Design, read-only: `C:\Users\USER\Desktop\Development\DSHProxy\.agents\worktrees\video-picker\docs\work\0011-video-in-model-picker\design-D.md`, sections 2.3 (route options), 2.4 (model id), 9.3 last bullet (`exposed`), and 10 (apply, verify, remove). Section 0.2 row R1 says why exposure matters. Also `research\dsh-model-facts.md` in the same folder: what a route may carry (`retryPolicy`, `streamIdleTimeoutMs`) and where a profile can name a provider and model (`allowedModels`, tool rows with `agentOptions`, the default model).

In your worktree: `src\dsh\profile.js` (all of it: `ROUTES`, `buildRoutes`, `apply`, `verify`, `remove`, `state`/`hasRoutes`, how the default model and `allowedModels` are handled, backups, how `cordis.patch.yml` is read and written), and `test\profile.test.js` (the style, the throwaway `DSH_HOME`).

## What to build

In `src\dsh\profile.js`, through its existing public functions:

1. **The route.** `ROUTES` gets `"dshproxy-video"`: protocol `anthropic-messages`, base URL `<origin>/dshproxy/video`, display name `DSHProxy · Video (paid)`, and the route options `streamIdleTimeoutMs: 900000` and `retryPolicy: { mode: "normal", maxRetries: 0 }`, written into the route as the Harness expects them (see the facts file for the exact place and spelling; if the facts file and the existing routes disagree about where a route option goes, follow how the existing code writes a route and say so in the report).
2. **Its models** are the entries the caller passes in, marked `api: "video"` (the caller gives each `{ id, name, api: "video", input: ["text"], contextWindow, maxTokens, efforts: [] }`, with ids such as `seedance-2.5/720p/krea`). A model with `api: "video"` goes to this route and to no other; the four existing routes are written exactly as before whether or not video models are passed.
3. **`apply`**: writes the video route with exactly the passed entries, in the passed order. When no video model is passed, the route is removed if present (and nothing else changes). It never adds a video model or the video provider to `allowedModels` or to any tool row. If the profile's default model points at provider `dshproxy-video`, it is repaired the way a missing default is repaired today. `--dry-run` reports these changes like the others.
4. **`verify`** reports, besides today's checks: the video route's model ids differ from the passed entries in either direction (say to run `dshproxy dsh apply`); `retryPolicy.maxRetries` is not 0 on the video route; and **every place in the profile that names provider `dshproxy-video` outside the provider list** (in `allowedModels`, in a tool row's agent options, as the default model, or anywhere else a `{ provider, model }` pair appears), with the sentence "the paid video route must not be selectable for agents or be the default model" and where it was found. A profile without the video route and with no video entries passed verifies as today.
5. **`remove`** deletes the video route with the other four.
6. **`videoExposed(home)`** (exported): true when any Harness profile names provider `dshproxy-video` outside its provider list, as in point 4. A profile that cannot be read or parsed counts as exposed. It reads only; it is what the gateway will ask before allowing a purchase.

Everything else about `apply`, `verify`, `remove` stays as it is: backups, the credentials reference, the four routes, messages for existing cases.

## Acceptance criteria

- With no video models passed and no video route in the profile, the bytes `apply` writes are identical to what the unchanged code writes for the same input (a test compares against a fixture produced by the unchanged code, or asserts on the full written document for one representative profile).
- New tests, each through `apply` / `verify` / `remove` / `videoExposed` with a throwaway `DSH_HOME`: route written with options and entries; entries changed (added, removed, reordered) are picked up by apply and reported by verify before it; no entries removes the route; default model on the video route is repaired; apply never puts the video provider into `allowedModels` or a tool row even when the profile already lists the other routes there; verify reports each exposure place separately; `maxRetries` not 0 is reported; remove deletes it; `videoExposed` true for each exposure place, false for a clean profile, true for an unreadable profile, and it writes nothing (compare the folder before and after).
- Red before green: write the tests first and record the failures against the unchanged module.
- No existing test is edited. `node --test` and `node scripts/check.js` pass.

## Files you own

- `src\dsh\profile.js`
- `test\profile-video.test.js` (new; do not edit `test\profile.test.js`)
- `docs\work\0011-video-in-model-picker\reports\S4a.md` in your worktree (create the folders)

## Out of bounds

- Every other file, in particular `src\cli.js`, `src\daemon.js`, `src\app.js`, `src\gateway\`, `src\video\`, `src\dsh\bundle.js`, `README.md`, `app\`.
- **The real Harness home `C:\Users\USER\.dsh` and the real DSHProxy data folder `C:\Users\USER\.dshproxy`: never read for testing, never written.** Every test and every command you run sets `DSH_HOME` and `DSHPROXY_HOME` to throwaway folders under `%TEMP%`. Never run `dshproxy dsh apply`, `verify` or `remove` without them.
- The running DSHProxy (nothing to `127.0.0.1:8417` or `8418`), the main checkout and every other worktree.
- No new dependency. No commit, push, subagents, goals.

## Verify

From your worktree root, with `$env:NODE_PATH='C:\Users\USER\Desktop\Development\DSHProxy\node_modules'`:

- `node --test test/profile-video.test.js test/profile.test.js` : 0 fail
- `node --test` : 0 fail (627 before your change)
- `node scripts/check.js` : exit 0

## Rules you would not otherwise know

- Node.js CommonJS, Windows; the shell is Windows PowerShell 5.1 (`powershell`). Write files as UTF-8 without BOM and keep the file's line endings.
- The profile file belongs to the user: `apply` changes only what DSHProxy owns in it and keeps everything else, comments and order included, as the existing code does. Do not reformat.
- Messages are for a person: say what is wrong and what to do, in one or two plain sentences.

## Return

Write the full report to `docs\work\0011-video-in-model-picker\reports\S4a.md` in your worktree: what you built, where route options are written and why, the red and green output, how each criterion is covered (test names), and anything in the design that did not fit the code.

Then reply with at most 12 lines, in exactly this shape:

```
Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Files changed: <paths>
Verify: <command> -> <result line>
Red before green: <test name> failed with <message> before the change
Concerns: <one line each, or none>
Report: <path>
```

Use `BLOCKED` when a criterion is wrong or cannot be met; say which and why. Do not work around it.
