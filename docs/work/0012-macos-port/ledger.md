# Ledger — 0012 DSHProxy on macOS

| Gate | Status | Evidence |
|---|---|---|
| Spec review (two lenses) | running | dispatched 23 Nov |
| Spec approval by the user | open | |
| Plan review | open | |
| Slice verifies | open | plan not written |
| Final checks (both systems in CI) | open | |
| Independent review | open | |
| Check on the user's Mac (M1 to M5) | open | |

Next step: collect the two spec reviews, fix the spec, put it to the user with the three open decisions.

## Rulings

- Ruling: scope is macOS only; iPhone and iPad are out — because the user answered "macos" when asked which — cost if wrong: a separate project, nothing here is wasted.
- Ruling: the Harness is on the Mac ("it's the same setup dsh + dsh proxy") — because the user said so — cost if wrong: M3 cannot be done.
- Ruling: the plugin install (`dsh bundle install`) is left out — because the Mac application's layout can only be inferred from the Windows install — cost if wrong: the video tools plugin has to be installed by hand on a Mac until the next change.
- Ruling: work is on branch `macos-port`, worktree `.agents/worktrees/macos-port`, from `main` at `8efe918`.

## Evidence

- 23 Nov: GitHub API, release `v8.0.72`: `darwin_aarch64` and `darwin_amd64` archives exist; digests in `research/facts.md`.
- 23 Nov: survey of Windows-only code (scout `win-map`) and of the Harness sources for macOS (scout `agent-10`), condensed in `research/facts.md`.
- 23 Nov: `gh repo view`: the repository is public.

## Open with the user

- Video on the Mac in this change or after.
- Keychain or a private file for the key wrapper.
- Pushing the `macos-port` branch so CI can run on a Mac.
- Apple Silicon or Intel (asked, not answered; both are planned).
