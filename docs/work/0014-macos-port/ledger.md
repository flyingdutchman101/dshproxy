# Ledger — 0014 DSHProxy on macOS

**Start here on the Mac.** Branch `macos-port`. Read this file, then `spec.md`, then `plan.md`. On the user's Mac the checkout was cloned on 23 Nov.

| Gate | Status | Evidence |
|---|---|---|
| Spec review (two lenses), stage A | done | 23 Nov, reviewer lane: simplicity and reuse (2 Major, 4 Nit), design risk (8 Major, 6 Nit), no Blocker. Resolved below. |
| Proof of the riskiest assumption on a Mac | done | 23 Nov, runs 45221540307 and 45221963088, both processors; `research/facts.md` section 5. One assumption did not hold (a locked keychain waits instead of failing); spec changed. |
| Goal and scope by the user | done | 23 Nov: "it does need same fuctionality, exactly the same as win". Spec rewritten to four stages. |
| Spec read and approved by the user | open | The user set the goal and said to push and continue on the Mac; the document itself was not confirmed. Stages B to D are outlines and were not reviewed. |
| Plan review, stage A | open | `plan.md` is a draft; the plan lens has not run. Run it before A1. |
| A0 baseline on the Mac | done | 23 Nov, user's Mac (arm64, macOS 26, Node 24.19.0). Proof: 17 passed, 1 failed (K7 after unlocking: a pending Keychain dialog blocks the next read; new fact). Tests: 914, 877 pass, 35 fail, 2 skipped; every failure explained in `research/facts.md` section 6. `package.json` and the lock allow `darwin`. |
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

Next step: plan review of stage A (running), then slice A1.

## Rulings

- Ruling: the goal is the same functionality as on Windows, on macOS; iPhone and iPad are out — because the user said so on 23 Nov ("macos"; "exactly the same as win") — cost if wrong: none known.
- Ruling: four stages, A gateway and command line, B video, C plugin install, D app — because each is usable alone, the risky and the unknown parts differ per stage, and C and D need facts that can only be read on a Mac — cost if wrong: an order to change, nothing to undo.
- Ruling: the key wrapper on macOS is the Keychain — because it is what DPAPI is on Windows and the proof passed; the user did not choose it in so many words — cost if wrong: one module to replace before any key has been stored.
- Ruling: Windows code for DPAPI is not moved or merged — because the port does not need it (spec review).
- Ruling: work is on branch `macos-port`, from `main` at `8efe918`. Pushed to GitHub on the user's word (23 Nov, twice: "Yes you can"; "you can push the thing and i'll continue developing it on mac").
- Ruling: the proof ran before the spec was confirmed — because it is throwaway, changes no production code, and its result decided the key wrapper — cost if wrong: one workflow file and one script to delete.
- Ruling: this work folder is 0014 — because 0009 to 0013 are taken on other branches (`0009-dpi-awareness`, `0010` to `0012`, `0013-first-time-setup`). It was first pushed as 0012, then 0013; the GitHub runs of the proof carry those names.

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
- 23 Nov, on the user's Mac: `node docs/work/0014-macos-port/spike/proof.js` and `node --test` before any change (A0); `research/facts.md` section 6. A `SecurityAgent` process (a Keychain dialog for the proof's throwaway keychain, which no longer exists) was still running afterwards; it is the user's to dismiss with Cancel.
- Read in the code: an update is applied only through the control routes `update/check`, `update/apply`, `update/rollback` (`src/daemon.js`); the command line has `backend version` and `backend rollback` only (`src/cli.js:55-56, 578-591`).

## Not verified

- Nothing of DSHProxy itself has run on a Mac beyond its test suite; the proof script and the unmodified backend ran on the user's Mac.
- What a locked Keychain does over SSH with nobody logged in at the screen.
- Whether the user's Mac lets the downloaded backend run without a question when DSHProxy downloads it (the proof's download, by Node, ran with no question on 23 Nov; it carried `com.apple.provenance`, not quarantine). M1 settles it.
- The Mac layout of the Harness application, its launcher and its process name: inferred from the Windows install (`research/facts.md` section 2).
- What `fsync` in Node does on macOS.
- The forecast of which tests fail on a Mac (`research/facts.md` section 3) comes from reading, not from running them.

## Other branches put on GitHub for the Mac, 23 Nov

On the user's word (asked what "Go!" meant; answer: "Only push the leftovers, I build on the Mac").

- `gateway-receipt-wip`: `main` plus one commit with the three files that were uncommitted in the Windows checkout of `main` (`README.md`, `src/gateway/server.js`, `test/gateway.test.js`): a routing receipt in the `X-DSHProxy-Receipt` header. As they were; not reviewed. The Windows checkout was not touched and still has them uncommitted.
- `work-documents`: `main` plus one commit with the 37 work documents that were only on the local branch `video-picker`: `0005` ledger additions, `0010-video-resolution-pricing`, `0011-video-in-model-picker`, `0012-new-models-check`, `0013-first-time-setup`. Stage B should read `0011` first. Taken out before publishing, because the repository is public: the Windows user name in paths (`USER`), Krea job ids (`JOB-ID-REMOVED`), Krea balance figures (`BALANCE-REMOVED`) and the Krea plan (`PLAN-REMOVED`). The originals are on the Windows computer.
- Neither is merged into `macos-port` or `main`.

## Exists only on the Windows computer

- The local branch `video-picker` itself, with the unedited documents and its history.
- The data folder (`~/.dshproxy`), the provider sign-ins and the Krea sign-in. A Mac starts with none of them; signing in again there is the user's.

## Open with the user

- Reading and confirming the spec, in particular the outlines of stages B to D.
- Decision 4: the app in stage D as a local web page with a menu-bar item, or as a native Mac app.
- Whether `gateway-receipt-wip` and `work-documents` are to be merged, and where.
- Apple Silicon or Intel: the user's Mac is Apple Silicon (seen, 23 Nov); Intel stays covered by the lock and CI.
