# Video in the model picker: plan

Spec: `spec.md`. Evidence: `evidence/krea-live-shapes.md`. Research: `research/code-map.md`, `research/dsh-model-facts.md`.

Mode: thorough. A fresh implementer per slice with a written brief in `briefs/`; the lead verifies each slice itself, commits it, and the next slice starts from that commit. Independent review (reviewer lane, outside the authors' model family) of V1 and V2 together, since both are on the path that spends the user's units, and of the finished branch. The DPI work (`dpi-awareness`, other worktree) runs beside this and owns `app/`.

## Conflict table

| Slices | Shared files | Order |
|---|---|---|
| V1, V2 | none (V1: `src/krea-helper/mcp.js`, `src/video/*`, `bin/dshproxy-krea.js`; V2: `src/krea-helper/oauth.js`) | parallel, V2 in its own worktree `video-renewal`, merged into `video-picker` when both are accepted |
| V1, V3 | `src/video/krea-preset.js`, `src/video/command.js`, `src/video/workspace.js` | V3 after V1 |
| V3, V4 | `src/video/catalog.js`, `src/video/settings.js` | V4 after V3 |
| V5, DPI S1 to S5 | `app/DSHProxyApp.cs` | V5 after the DPI branch is merged |

## Slices

| id | depends on | What is true when done | Files | Seam, red to green | Verify |
|---|---|---|---|---|---|
| V0 | none | Live shapes recorded; code mapped; how the Harness calls a picked model researched | `evidence/`, `research/` | done by lead and two read-only agents | the three files |
| V1 | V0 | Part A: quote, submit, status and balance against the live interface, resolution as a request field | `src/krea-helper/mcp.js`, `src/video/krea-preset.js`, `src/video/workspace.js`, `src/video/command.js`, `bin/dshproxy-krea.js`, tests | `run(request, token, {fetchImpl})` with a fake server from the evidence: red on the unchanged helper (tool name, ids, version, schema), green after | A1 to A8 |
| V2 | V0 | Part B: sign-in renews | `src/krea-helper/oauth.js`, `test/krea-oauth.test.js` | `login`, `access`, `status` with a fake token endpoint: red (no refresh request is ever made), green after | B1 to B6 |
| V1+V2 live | V1, V2, the user's sign-in | A9, B7 | none | lead, with the user | recorded in the ledger |
| V3 | V1 | Part C: entries per model, resolution and route; Flux 3; transports and commands take a resolution | `src/video/catalog.js`, `transport.js`, `command.js`, `settings.js`, `krea-preset.js`, `integrations/dsh-video`, tests | `entries()` and `quote(model, route, resolution)`: red (no such function, one resolution), green after | C1 to C5 |
| V4 | V3, research, spec review of part D | Part D: picker route, local answers, quote then confirm, one purchase per confirmation | new `src/video/picker*.js`, `src/dsh/profile.js`, `src/app.js`, `src/daemon.js`, one hook in `src/gateway/server.js`, `docs/decisions/` | the answer module with fake quote, submit, status and clock: the retry-after-lost-answer case first | D1 to D6 |
| V5 | V4, DPI merged | The app's Video page shows Flux 3, entries and the Krea balance | `app/DSHProxyApp.cs`, `app/logos/` | layout harness | own brief |

## Rules for every slice

- The implementer does not commit, push, start subagents, sign in anywhere, or make any request to Krea, VideoRouter, KovAPI or Callirra. Tests use fake servers only. No paid call of any kind.
- Never read `%LOCALAPPDATA%\DSHProxy\KreaOAuth` or `C:\Users\USER\.dshproxy`; never touch the running install or `127.0.0.1:8417` and `8418`. A throwaway home under `%TEMP%` for anything that needs one.
- Tests: red first on the unchanged code for the stated reason; through the public seams named in the spec; no skipped or weakened test; mocks at the network, the clock and the token store only.
- `node --test` and `node scripts/check.js` from the worktree root with `NODE_PATH=C:\Users\USER\Desktop\Development\DSHProxy\node_modules`.
- No secret, token-shaped test value copied from a real session, user name or workspace id in any file.