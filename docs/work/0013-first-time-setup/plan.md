# First-time setup: plan

Spec: `spec.md`. Mode: thorough, two implementers on disjoint files in their own worktrees (both from `main` at `ed0f03b`), the lead merges, verifies and has the finished branch reviewed. Pictures of the new confirmation, the wait dialog and the Video > DeepSeek Harness page go to the user before anything ships.

| id | depends on | True when done | Files | Seam, red to green | Verify |
|---|---|---|---|---|---|
| F0 | none | The command installs a bundle from outside (spike) | none | done, ledger | ledger |
| F1 | F0 | `dshproxy dsh bundle status|install` per the contract | new `src/dsh/bundle.js`, `src/cli.js`, new `test/dsh-bundle.test.js`, `README.md` is out (the user has uncommitted edits to it) | `state(deps)` and `install(deps)` with a throwaway `DSH_HOME`, a stand-in `dsh.cmd` and an injected process list | `node --test`, `node scripts/check.js` |
| F2 | F0 (the contract only) | Apply shows the checklist, waits for Harness to close, installs, reports; the Video > DeepSeek Harness page shows the real state | `app/DSHProxyApp.cs`, `app/Skin.cs` if needed, the layout harness | layout harness with sample contract lines and an injected "is Harness running" | build, full layout run |
| F3 | F1, F2 | Both merged on one branch; the real command run once more against a throwaway home through `dshproxy dsh bundle install`; pictures shown to the user | merge only | lead | all of the above on the merged branch |
| F4 | F3, the user's go | Review, merge to `main`, push, swap at an idle moment | none | reviewer lane | CI |