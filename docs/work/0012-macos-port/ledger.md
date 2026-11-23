# Ledger — 0012 DSHProxy on macOS

| Gate | Status | Evidence |
|---|---|---|
| Spec review (two lenses) | done | 23 Nov, reviewer lane: simplicity and reuse (2 Major, 4 Nit), design risk (8 Major, 6 Nit), no Blocker. Resolved below. |
| Proof of the riskiest assumption on a Mac | done | 23 Nov, runs 45221540307 and 45221963088, both processors; `research/facts.md` section 5. One assumption did not hold (a locked keychain waits instead of failing); spec changed. |
| Spec approval by the user | open | revised spec put to the user 23 Nov; put again with the proof's result |
| Plan review | open | plan not written |
| Slice verifies | open | |
| Final checks (both systems in CI) | open | |
| Independent review | open | |
| Check on the user's Mac (M1 to M4) | open | |

Next step: the user's approval of the spec, and decisions 1 and 2. Then `plan.md` and its review. Before the branch is merged: remove `.github/workflows/macos-proof.yml` and `spike/`.

## Rulings

- Ruling: scope is macOS only; iPhone and iPad are out — because the user answered "macos" when asked which — cost if wrong: a separate project, nothing here is wasted.
- Ruling: the Harness is on the Mac ("it's the same setup dsh + dsh proxy") — because the user said so — cost if wrong: M3 cannot be done.
- Ruling: the plugin install (`dsh bundle install`) is left out — because the Mac application's layout can only be inferred from the Windows install — cost if wrong: the video tools plugin has to be installed by hand on a Mac until a later change.
- Ruling: two releases, A without video, B video — because the first review showed video adds two design parts and the paid-once journal to a change whose riskiest part is unproven — cost if wrong: video on the Mac comes one round later. Still open with the user as decision 1.
- Ruling: work is on branch `macos-port`, worktree `.agents/worktrees/macos-port`, from `main` at `8efe918`. Pushed to GitHub on 23 Nov on the user's word ("Yes you can", in answer to four questions of which the last was "May I push the `macos-port` branch to GitHub?"). Taken as the permission to push and to run the proof, not as approval of the spec or as an answer to decisions 1 and 2.
- Ruling: the proof ran before spec approval — because it is throwaway, changes no production code, and its result is what decision 2 depends on — cost if wrong: one workflow file and one script to delete.

## Spec review, findings and what was done

Simplicity and reuse:

1. Major, modes file by file: accepted. The file-creation mask is set once per program on macOS (design 3).
2. Major, "one key wrapper, moved not changed" cannot be true of two different DPAPI paths: accepted. Windows code stays where it is; macOS is chosen by system (design 1).
3. Nit, video is scope growth: accepted. Release B.
4. Nit, the plugin runner's environment for a plugin that cannot be installed: accepted, dropped.
5. Nit, refusing a release without a macOS asset changes Windows: accepted. An update needs its own system's assets only (design 2, C4).
6. Nit, a numbered decision and the README: accepted (design 5, decision 0009 to be written with the code).

Design risk:

1. Major, tests would use the real login Keychain: accepted. `DSHPROXY_KEYCHAIN`, throwaway keychain files, no test touches a login Keychain.
2. Major, a locked Keychain may show a dialog; no timeout given: accepted. 10 seconds per call, behaviour stated, the locked case added to the first proof and to C9.
3. Major, the case for the Keychain was overstated, because `backend-config.yaml` and `auth/` hold the secrets in plain text: accepted. New section "What the Keychain does and does not protect"; the choice is put to the user with it. Rejected: deleting `backend-config.yaml` on stop, because the backend needs it while it runs and it would change Windows.
4. Major, no way to apply a backend update on a Mac: accepted. New command `dshproxy backend update` on both systems (C5).
5. Major, the updater rule changed Windows: accepted, same as simplicity 5.
6. Major, `.credentials.yaml` not narrowed when the reference is already there; temporary files readable for a moment: accepted. Mask from the first byte; `apply` sets the mode every time; `verify` reports it (C10).
7. Major, two Windows wrappers: accepted, same as simplicity 2.
8. Major, `fsync` on macOS and the paid-once journal: not decided. Moved to Release B as a check to make before building; the reviewer's claim about Node and `F_FULLFSYNC` is not verified either way.
9. Nit, the program name in the macOS archive was stated as fact: accepted. Checked in the first proof.
10. Nit, how the key reaches `security`, and its encoding: accepted. `security -i` with the command on standard input; 64 hex characters. To be shown in the first proof.
11. Nit, lower-cased path comparison: accepted. `realpath`, exact, on macOS.
12. Nit, decision 0009: accepted.
13. Nit, C11 and the Krea helper: moot in Release A; carried to B.
14. Nit, mode of the Krea folder: carried to B (`0700`).

## Evidence

- 23 Nov: GitHub API, release `v8.0.72`: `darwin_aarch64` and `darwin_amd64` archives exist; digests in `research/facts.md`.
- 23 Nov: survey of Windows-only code (scout `win-map`) and of the Harness sources for macOS (scout `agent-10`), condensed in `research/facts.md`.
- 23 Nov: `gh repo view`: the repository is public.
- Read in the code after the review: an update is applied only through the control routes `update/check`, `update/apply`, `update/rollback` (`src/daemon.js`); the command line has `backend version` and `backend rollback` only (`src/cli.js:55-56, 578-591`).

## Not verified

- No production code has been written.
- What a locked Keychain does over SSH with nobody logged in at the screen.
- Whether the user's Mac lets the downloaded backend run without a question (on GitHub's Macs it did).
- Sign-ins, the Harness on a Mac, and everything else in M1 to M4.

## Open with the user

- Approval of the spec.
- Decision 1: video after the core is confirmed on the Mac, or straight after it.
- Decision 2: Keychain or a private file for the key wrapper.
- Decision 3: answered, yes (23 Nov).
- Apple Silicon or Intel (asked, not answered; both are planned).
