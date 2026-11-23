# Ledger — 0013 DSHProxy on macOS

**Start here on the Mac.** Branch `macos-port`. Read this file, then `spec.md`, then `plan.md`. No production code has been written; the next step is slice A0 of the plan.

| Gate | Status | Evidence |
|---|---|---|
| Spec review (two lenses), stage A | done | 23 Nov, reviewer lane: simplicity and reuse (2 Major, 4 Nit), design risk (8 Major, 6 Nit), no Blocker. Resolved below. |
| Proof of the riskiest assumption on a Mac | done | 23 Nov, runs 45221540307 and 45221963088, both processors; `research/facts.md` section 5. One assumption did not hold (a locked keychain waits instead of failing); spec changed. |
| Goal and scope by the user | done | 23 Nov: "it does need same fuctionality, exactly the same as win". Spec rewritten to four stages. |
| Spec read and approved by the user | open | The user set the goal and said to push and continue on the Mac; the document itself was not confirmed. Stages B to D are outlines and were not reviewed. |
| Plan review, stage A | open | `plan.md` is a draft; the plan lens has not run. Run it before A1. |
| A0 baseline on the Mac | open | |
| A1 key wrapper | open | |
| A2 private files | open | |
| A3 backend on a Mac | open | |
| A4 updates | open | |
| A5 not-yet sentences | open | |
| A6 packaging, README, decision 0009, remove the proof | open | |
| A7 independent review; M1 to M4 by hand | open | |
| Stage B video: criteria, plan, build | open | outline in the spec |
| Stage C plugin install: facts on the Mac, plan, build | open | outline in the spec |
| Stage D app: inventory, decision, prototype, build | open | outline in the spec; decision 4 is the user's |

Next step: on the Mac, slice A0 (`plan.md`).

## Rulings

- Ruling: the goal is the same functionality as on Windows, on macOS; iPhone and iPad are out — because the user said so on 23 Nov ("macos"; "exactly the same as win") — cost if wrong: none known.
- Ruling: four stages, A gateway and command line, B video, C plugin install, D app — because each is usable alone, the risky and the unknown parts differ per stage, and C and D need facts that can only be read on a Mac — cost if wrong: an order to change, nothing to undo.
- Ruling: the key wrapper on macOS is the Keychain — because it is what DPAPI is on Windows and the proof passed; the user did not choose it in so many words — cost if wrong: one module to replace before any key has been stored.
- Ruling: Windows code for DPAPI is not moved or merged — because the port does not need it (spec review).
- Ruling: work is on branch `macos-port`, from `main` at `8efe918`. Pushed to GitHub on the user's word (23 Nov, twice: "Yes you can"; "you can push the thing and i'll continue developing it on mac").
- Ruling: the proof ran before the spec was confirmed — because it is throwaway, changes no production code, and its result decided the key wrapper — cost if wrong: one workflow file and one script to delete.
- Ruling: this work folder is 0013, not 0012 — because `0012-new-models-check` exists on the local branch `video-picker`, which is not on GitHub.

## Spec review, findings and what was done

Simplicity and reuse:

1. Major, modes file by file: accepted. The file-creation mask is set once per program on macOS (design 3).
2. Major, "one key wrapper, moved not changed" cannot be true of two different DPAPI paths: accepted. Windows code stays where it is; macOS is chosen by system (design 1).
3. Nit, video is scope growth: accepted at the time as a later release; the user has since put video in scope. It is stage B.
4. Nit, the plugin runner's environment for a plugin that cannot be installed: accepted; it moves to stage C with the install.
5. Nit, refusing a release without a macOS asset changes Windows: accepted. An update needs its own system's assets only (design 2, C4).
6. Nit, a numbered decision and the README: accepted (design 5, decision 0009 to be written with the code).

Design risk:

1. Major, tests would use the real login Keychain: accepted. `DSHPROXY_KEYCHAIN`, throwaway keychain files, no test touches a login Keychain.
2. Major, a locked Keychain may show a dialog; no timeout given: accepted, and then seen in the proof. 10 seconds per call.
3. Major, the case for the Keychain was overstated, because `backend-config.yaml` and `auth/` hold the secrets in plain text: accepted. Section "What the Keychain does and does not protect". Rejected: deleting `backend-config.yaml` on stop, because the backend needs it while it runs and it would change Windows.
4. Major, no way to apply a backend update on a Mac: accepted. New command `dshproxy backend update` on both systems (C5).
5. Major, the updater rule changed Windows: accepted, same as simplicity 5.
6. Major, `.credentials.yaml` not narrowed when the reference is already there; temporary files readable for a moment: accepted (design 3, C10).
7. Major, two Windows wrappers: accepted, same as simplicity 2.
8. Major, `fsync` on macOS and the paid-once journal: **not decided**. To establish before stage B is built; the reviewer's claim and the opposite belief are both unverified.
9. Nit, the program name in the macOS archive was stated as fact: accepted, and then seen in the proof (`cli-proxy-api`).
10. Nit, how the key reaches `security`, and its encoding: accepted, and then seen in the proof (`security -i`; 64 hex characters).
11. Nit, lower-cased path comparison: accepted. `realpath`, exact, on macOS.
12. Nit, decision 0009: accepted.
13. Nit, the Krea helper's environment: stage B.
14. Nit, mode of the Krea folder: stage B (`0700`).

## Evidence

- 23 Nov: GitHub API, release `v8.0.72`: `darwin_aarch64` and `darwin_amd64` archives exist; digests in `research/facts.md` section 1.
- 23 Nov: survey of Windows-only code and of the Harness sources for macOS, condensed in `research/facts.md` sections 2 to 4.
- 23 Nov: the proof on two GitHub Macs, `research/facts.md` section 5. First run: 18 passed, 1 failed (the locked keychain). Second run, with the check rewritten to what was seen: 19 passed on both.
- Read in the code: an update is applied only through the control routes `update/check`, `update/apply`, `update/rollback` (`src/daemon.js`); the command line has `backend version` and `backend rollback` only (`src/cli.js:55-56, 578-591`).

## Not verified

- No production code has been written. Nothing of DSHProxy itself has run on a Mac; only the proof script and the unmodified backend.
- What a locked Keychain does over SSH with nobody logged in at the screen.
- Whether the user's Mac lets the downloaded backend run without a question (on GitHub's Macs it did).
- The Mac layout of the Harness application, its launcher and its process name: inferred from the Windows install (`research/facts.md` section 2).
- What `fsync` in Node does on macOS.
- The forecast of which tests fail on a Mac (`research/facts.md` section 3) comes from reading, not from running them.

## Exists only on the Windows computer, not on GitHub

- Three uncommitted files in the main checkout there: `README.md`, `src/gateway/server.js`, `test/gateway.test.js`. They are the user's and were left alone.
- The local branch `video-picker` (24 commits ahead of `main`): the work folders `0010`, `0011` and `0012-new-models-check` with their specs, ledgers and research. The code of that work is in `main`; the documents are not.
- The data folder (`~/.dshproxy`), the provider sign-ins and the Krea sign-in. A Mac starts with none of them; signing in again there is the user's.

## Open with the user

- Reading and confirming the spec, in particular the outlines of stages B to D.
- Decision 4: the app in stage D as a local web page with a menu-bar item, or as a native Mac app.
- Whether to put the documents of `video-picker` and the three uncommitted files on GitHub.
- Apple Silicon or Intel (asked, not answered; both are covered).
