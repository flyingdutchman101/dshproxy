# Ledger: centered, responsive desktop layout

- 2026-11-22 03:28. Request: review size, design, responsiveness and overall use; everything centered; common monitor sizes 13 to 49 inch. Base `3f6eb33` (pushed to `origin/video-routing`).
- Review done on the committed build in preview mode. Captures in `review/`. Findings are in `spec.md`: no centering or maximum width, fixed 1000x760 start size, about 400 px of fixed chrome, fixed list column widths, process is DPI-unaware (measured awareness 0).
- This machine: 3440x1440 and 2560x1440, both at 100% scaling. Scaled-display behaviour cannot be observed here. 5120x1392 capture was accepted by Windows at that size for the baseline.
- Ruling: DPI awareness is a separate change (non-goal here). Running app is not replaced without the user's approval.
- Worker `desktop-ui` owns `app/DSHProxyApp.cs` and `app/Skin.cs` for this change; captures go to `after/`.
- Next gate: inspect `after/` captures, independent review, then ask the user before restarting the running app or pushing.

## Side task: refused backend update (CLIProxyAPI 8.1.0)

- 2026-11-22 03:32. User reported the update dialog: 8.1.0 "did not pass its trial"; "lists 11 models"; claude and codex "no model of this service is listed".
- Cause, measured: `src/backend/trial.js` stopped waiting at the first non-empty model list. With API keys saved (qwen, deepseek) 11 models are listed at once; the account models appear 5.1 s later. Same timing for 8.1.0 and for the current 8.0.75 started the same way, so 8.1.0 is not at fault. The 5 s comes from the second instance timing out on `auth\kv.db`, which the running backend holds open. Log shows the verdict 14 ms after "backend ready", three times.
- Diagnostic run: started each binary on a spare port with the real auth folder and polled `/v1/models` only; no request was sent to any account. Temp config removed; only the user's own backend process was left running.
- Fix on branch `fix-update-trial-race` (worktree `.agents/worktrees/fix-update-trial-race`, commit `2f44b79` on `main` `9009235`), local only, not pushed, not applied to the running gateway. Red first: the new test failed with the dialog's two lines. Then `test/trial.test.js` 3/3, whole suite 306/306, 48 files OK.
- Not verified: a real update passing end to end. That needs the fix loaded by the gateway (a gateway restart, which interrupts open Harness sessions including this one) and then Update in the app, which sends one small request per account.
- Review `trial-review` (reviewer lane; the model family that served it was not checked in the DSHProxy log): no critical, high or medium findings; ran `test/trial.test.js` 3/3 itself. One low finding taken: a model list that is not an array is now treated as empty. Commit amended to `c4dcdc2`; suite 306/306 and 48 files OK rerun after the amend.

## State of the previous change at handoff (0003)

- `3f6eb33` pushed to `origin/video-routing`. No PR, no merge.
- Main checkout: scoped patch `c34bd94..3f6eb33` applied uncommitted (app, logos, `src/video`, `integrations/dsh-video`); desktop app restarted from it, PID 39184 at the time. Previous executable kept at `%TEMP%\dshproxy-old-d4260f26-0c77-4403-8fb3-73cd7b3faf0a.exe`.
- Harness bundle `@local/dshproxy-video` 0.1.0 installed into profile `desktop` with `plugin_manager install_bundle`, linked to the main checkout's `integrations\dsh-video`; result "applied", no warnings. `video_options` called once in this session: returned an empty model list, which matches the real settings (nothing enabled). `video_quote`, `video_submit` and `video_status` have not been called live. No Krea sign-in, no spend.
