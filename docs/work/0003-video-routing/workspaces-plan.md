# Workspace implementation plan

Approved interaction: `workspaces.html`; acceptance contract: `workspaces-spec.md`. The UI is a setup surface, not a video generator. Work in the existing video-routing worktree; leave prototypes and the user's primary checkout untouched.

1. Settings, no dependency: implement `src/video/settings.js` plus `test/video-settings.test.js` with real temporary settings, exact route allowlist, safe disabled defaults and preservation of unrelated config. Red→green `node --test test/video-settings.test.js`.
2. CLI integration, depends on settings: expose bounded settings read/write via `video settings` and `video settings set MODEL ROUTE enabled|disabled`; test via `test/video-command.test.js` against temporary settings, no real user profile. Workspace UI consumes only this interface.
3. Native desktop, depends on CLI contract: `app/DSHProxyApp.cs` (and styling if required), retaining existing navigation and chat behavior. Video settings use the CLI, do not invoke auth or paid actions, and represent uninstalled Harness support honestly. Compile and inspect synthetic preview without touching the running app.
4. Harness design/integration, depends on documented installed extension points: expose only genuinely implemented and verified functionality; explicit user approval for paid execution, no profile mutation during development. If a required safe approval boundary cannot be verified, leave generation unavailable and document the exact gate, never simulate success.
5. Full tests, build, independent review and diff check. No real account, spend, installation, push or deployment without separate approval. Preserve unrelated main checkout changes.

Execution: settings backend, desktop UI and read-only Harness design are disjoint parallel tracks; lead owns CLI, documentation and integration/review.
