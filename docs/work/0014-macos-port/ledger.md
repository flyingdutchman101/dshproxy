# Ledger — 0014 DSHProxy on macOS

**Start here on the Mac.** Branch `macos-port`. Read this file, then `spec.md`, then `plan.md`. On the user's Mac the checkout was cloned on 23 Nov.

| Gate | Status | Evidence |
|---|---|---|
| Spec review (two lenses), stage A | done | 23 Nov, reviewer lane: simplicity and reuse (2 Major, 4 Nit), design risk (8 Major, 6 Nit), no Blocker. Resolved below. |
| Proof of the riskiest assumption on a Mac | done | 23 Nov, runs 45221540307 and 45221963088, both processors; `research/facts.md` section 5. One assumption did not hold (a locked keychain waits instead of failing); spec changed. |
| Goal and scope by the user | done | 23 Nov: "it does need same fuctionality, exactly the same as win". Spec rewritten to four stages. |
| Spec read and approved by the user | open | The user set the goal and said to push and continue on the Mac; the document itself was not confirmed. Stages B to D are outlines and were not reviewed. |
| Plan review, stage A | done | 23 Nov on the Mac, one fresh-context reviewer subagent (the `reviewer` role could not be started: tool error; same model family as the author, so not cross-family): 2 Blocker, 9 Major, 4 Nit. Plan revised, spec C3, C9, C10, C12 and design 4 amended; below. |
| A0 baseline on the Mac | done | 23 Nov, user's Mac (arm64, macOS 26, Node 24.19.0). Proof: 17 passed, 1 failed (K7 after unlocking: a pending Keychain dialog blocks the next read; new fact). Tests: 914, 877 pass, 35 fail, 2 skipped; every failure explained in `research/facts.md` section 6. `package.json` and the lock allow `darwin`. |
| A1 key wrapper | done on the Mac; Windows CI pending | 23 Nov. `src/keywrap-darwin.js`; `src/secrets.js` takes it on `darwin` (DPAPI code untouched). Red first: 12 of 13 new tests failed with "Windows could not protect a new key" before `secrets.js` was wired; green after. Full suite on the Mac: 929, 901 pass, 25 fail (all A2, A3, A5/B/C), 3 skipped; the 10 key-wrapper failures of A0 pass. Locked-keychain test (C9 through the CLI) not run here: CI only, from A6. |
| A2 private files | done on the Mac; Windows CI pending | 23 Nov. Mask `077` in both `bin/` programs, data folder `0700` in `src/cli.js`, `.credentials.yaml` and backups `0600` and the `verify` report in `src/dsh/profile.js`, all on `darwin` only. Red first: the 3 tests of `test/modes-darwin.test.js` failed (folder `755`, no report), green after. `profile.test.js:535` split: skipped on macOS, new macOS test with a locked (`chflags uchg`) file; that one is a characterization (passes on the old code too). Suite on the Mac: 933, 905 pass, 24 fail (A3, A5/B/C), 4 skipped. |
| A3 backend on a Mac | done on the Mac; Windows CI pending | 23 Nov. Lock with four assets (C3, against the release's `checksums.txt` lines fetched that day); `/usr/bin/tar`, `cli-proxy-api`, `0700` on macOS; leftover backend by `ps -ww -o comm=` and exact `realpath` on macOS (C6). Red first: lock tests, the three archive tests and the reclaim test failed on the old code (the reclaim test checked again with the old `supervisor.js` put back). The stand-in backend is a copy of `/bin/sleep`, signed again ad hoc (a copy of Homebrew's `node` does not run: it needs its library; an unsigned copy of `sleep` is killed). C2 by hand: `start` in a throwaway home downloaded and started 8.0.72, `/dshproxy/status` 200, every file `600`/`700`, `stop --when-idle` → `{"stopped":true}`, no listener and no backend left. Suite on the Mac: 937, 912 pass, 20 fail (A5/B/C), 5 skipped. |
| A4 updates | done on the Mac; Windows CI pending | 23 Nov. `lockFromRelease(release, sums, { platform })`: own system's archives required as before, the other's kept when complete (C4); today's updater tests got `{ platform: "win32" }`, no assertion changed. `dshproxy backend update` through `update/check` and `update/apply`; a failed check is reported as a failure (C5). `daemon.start`'s test-only `backend` option also takes `checkForUpdate` and `trial`, and an update now installs through `backend.install` when a test gives one (production: the same `install`). Red first: 5 new updater tests and 4 CLI tests failed on the old code ("Usage: dshproxy backend version|rollback"). Windows sees the new command in the help and in that usage line; nothing else. GitHub, 23 Nov: latest release 8.1.2 publishes both macOS archives. Suite on the Mac: 946, 921 pass, 20 fail (A5/B/C), 5 skipped. |
| A5 not-yet sentences | done on the Mac; Windows CI pending | 23 Nov. `src/not-yet.js` is the one place; gates in `src/cli.js` (before anything is read or written), `bin/dshproxy-krea.js` (`require.main` branch), `src/daemon.js` (video path answers 404, no `video-picker` folder), `src/app.js` `videoModels` (no entries, so no video route). Red first: 12 of 13 tests of `test/not-yet-darwin.test.js` failed on the old code; green after. 31 tests skipped on macOS only, each naming stage B or C: `daemon.test.js` 1369; `krea-oauth.test.js` 129; `krea-renewal-process.test.js` 83, 98, 116, 137, 158, 170; `video-command.test.js` 58, 59, 71; `video-picker-callers.test.js` 56, 73, 82; `dsh-bundle.test.js` 323, 498, 544, 575, 590, 602, 615, 632, 674, 694, 708, 739, 762, 779, 790; `integrations/dsh-video/test/dsh-video.test.mjs` 151. **C1 on the Mac: `node --test` 959 tests, 924 pass, 0 fail, 35 skipped.** |
| A6 packaging, README, decision 0009, remove the proof | done | 23 Nov. CI run 45251609810 (commit of the CI change), all six jobs green: Windows Node 22 and 24: 962 tests, 929 pass, 0 fail, 33 skipped (macOS-only tests); every test that passed on Windows before the port (run 45247071345, 914) passes, compared by name; C13 passed (`main`'s CLI and this one read each other's data folders and lock). macOS `macos-latest` and `macos-15-intel`, Node 22 and 24: 962 tests, 925 pass, 0 fail, 37 skipped; the locked-keychain test ran and passed (C9 through the CLI); the login keychain had no DSHProxy item afterwards (exit 44); `scripts/start-stop-check.js` passed (C2). README macOS section; decision 0009; `spike/` and `macos-proof.yml` removed. |
| A7 independent review | done; fixes in CI | 23 Nov. Cross-family reviewer (a GPT model through the Harness's own provider; the `reviewer` role could not be started, tool error) on the committed diff against `8efe918`: 3 Major, 1 Minor, no Windows regression found; verdict "request changes". All four fixed, each red first: (1) an inherited `DSHPROXY_KEYCHAIN` was trusted by the tests: the support file now makes its own unless the path is one it made, and under the test runner the wrapper refuses any keychain outside the temporary folder; (2) video commands skipped the `0700` of the data folder: the `chmod` now comes before the video dispatch; (3) C9 did not hold for `start` (it writes its configuration and log): spec narrowed for `start` (ruling below), the locked-keychain test now covers `key set`, `key custom add`, `video key set`, `status`, `models` and `start`; (4) a release with one Windows archive gave a three-asset lock on macOS: the other system's archives are kept only as a complete pair. Suite on the Mac: 965, 927 pass, 0 fail, 38 skipped. CI on `c721af1`: all six jobs green; Windows 929 pass, 0 fail; the extended locked-keychain test passed on both Mac processors and Node versions (about 61 s each); login keychain untouched (exit 44). |
| M1 to M4 by hand | open | need the user |
| Stage B video: criteria, plan | written, shown to the user | `stage-b.md`, 23 Nov. Not reviewed. |
| B2 the children's environments | done on the Mac; CI pending | 23 Nov. `MAC_ENVIRONMENT` (`HOME, TMPDIR, DSHPROXY_HOME, DSHPROXY_KEYCHAIN`) for the picker's child, `helperEnvironment` (`HOME, TMPDIR, DSHPROXY_KEYCHAIN`) for the Krea helper; the Windows lists unchanged. Red first: 2 new tests. The Windows-string tests of the child now name `'win32'` (assertions unchanged); the real-process test uses the list of its system. |
| B3 the video gate goes | done on the Mac; CI pending | 23 Nov. `video` removed from `src/not-yet.js`, the CLI, the gateway mount and `app.videoModels`; the 7 macOS skips naming stage B removed; `test/not-yet-darwin.test.js` keeps the two plugin-install cases. One test expected "refused" off Windows (the store used to refuse); on macOS it now says "sign-in required", as on Windows. Suite on the Mac: 960, 935 pass, 0 fail, 25 skipped (stage C, Windows-only and CI-only tests). |
| B1 Krea sign-in store on macOS | done on the Mac; CI pending | 23 Nov. `macStore` in `src/krea-helper/oauth.js` (the store's body moved unchanged into `sessionStore`, which `windowsStore` calls as before); `bin/dshproxy-krea.js` picks the store by system; the `krea` not-yet gate removed. Red first: `test/krea-store-darwin.test.js` (3, "macStore is not a function") and the macOS twin of the real-helper status test (exit 1, the gate). The six renewal-process tests now run against the macOS store on a Mac (their Windows run is the same store as before) and pass. Suite on the Mac: 967, 935 pass, 0 fail, 32 skipped. |
| B CI | done | run on `3cc9bda`: all six jobs green; Windows 931 pass, 0 fail. |
| B4 independent review | done | 23 Nov, cross-family (GPT model, read-only) on `c721af1..HEAD`: no Blocker or Major; Windows store, format, location and environments found unchanged; one Minor: the Krea store's key was copied before wrapping and the copy never wiped. Fixed red first (`test/krea-store-darwin.test.js`, the key handed to the wrapper is all zeros afterwards, on success and failure); a rejected unwrapped key is wiped too. |
| BM1 to BM4 by hand | open | need the user (Krea sign-in; BM4 only on the user's word) |
| Stage C plugin install: facts, criteria, plan | written, shown to the user | `stage-c.md`, 23 Nov; facts `research/facts.md` section 7. The user answered "go" (23 Nov, 21:1x), taken as the word to build it. |
| C1 to C4 build | done on the Mac; CI pending | 23 Nov. `src/dsh/bundle.js`: on macOS the Harness is `DSHPROXY_HARNESS_DIR`, `/Applications/DeepSeek Harness.app` or `~/Applications/...`; running = any process whose `ps -ww -axo comm=` path is inside the application (real paths, any case); the command `Contents/Resources/runtime/cli/bin/dsh` started directly in its own process group, ended as a group after the time limit, both output streams kept. `integrations/dsh-video/lib/config.js`: `HOME, TMPDIR, DSHPROXY_KEYCHAIN` and `node` from `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`. `src/not-yet.js` and its test removed. Red first: the test file's stand-in made per system (an `.app` with a `sh` launcher on macOS) turned 34 tests red ("not found"), plus 5 new macOS tests (process list incl. a real process, places, arguments with shell characters, standard error) and the runner test; all green after. Windows-only tests (3) skip on macOS naming their twins. One test compared a child's working folder by name; now by real path (`/var` → `/private/var`). Suite on the Mac: 965, 956 pass, 0 fail, 9 skipped (all Windows-only or CI-only, each naming its macOS twin). |
| CM1 by hand | open | needs the user's word: installs the plugin into the user's Harness profile |
| Stage D app: inventory | done | `research/app-inventory.md` (subagent, read-only, every item with file:line): 11 page surfaces, 33 buttons, 7 dialogs, 15 of 18 control routes used. Found: the README's 10 % low-limit notification does not exist in the code. |
| Stage D: prototype, decision | prototype being built | option (a), local web page + menu-bar item, in `prototype/`; decision 4 is the user's |

Next step: stage A's automatic criteria C1 to C13 are met; M1 to M4 wait for the user. Stage B is built (B1 to B3, CI green); its review is running; BM1 to BM4 wait for the user. Stage C: plan written, build after the user has seen it. Stage D: prototype being built, then the user's decision.

## Rulings

- Ruling: the goal is the same functionality as on Windows, on macOS; iPhone and iPad are out — because the user said so on 23 Nov ("macos"; "exactly the same as win") — cost if wrong: none known.
- Ruling: four stages, A gateway and command line, B video, C plugin install, D app — because each is usable alone, the risky and the unknown parts differ per stage, and C and D need facts that can only be read on a Mac — cost if wrong: an order to change, nothing to undo.
- Ruling: the key wrapper on macOS is the Keychain — because it is what DPAPI is on Windows and the proof passed; the user did not choose it in so many words — cost if wrong: one module to replace before any key has been stored.
- Ruling: Windows code for DPAPI is not moved or merged — because the port does not need it (spec review).
- Ruling: work is on branch `macos-port`, from `main` at `8efe918`. Pushed to GitHub on the user's word (23 Nov, twice: "Yes you can"; "you can push the thing and i'll continue developing it on mac").
- Ruling: the proof ran before the spec was confirmed — because it is throwaway, changes no production code, and its result decided the key wrapper — cost if wrong: one workflow file and one script to delete.
- Ruling: with a locked Keychain, `start` goes on as on Windows and writes `backend-config.yaml` and its log; C9's "byte for byte" holds for the keys, `master.key`, `settings.json`, `video-keys.json` and the keychain — because stopping `start` there would change what Windows does and the reviewer offered this narrowing — cost if wrong: a refusal to start on macOS, a small change in one place. For the user to confirm.
- Ruling: the cross-family review was run by a GPT model through the Harness's own configured provider, the `reviewer` and `delegate_role` tools failing with a tool error — cost if wrong: none; the reviewer had read access only.
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

## Plan review, findings and what was done (23 Nov, on the Mac)

1. Blocker, tests that spawn the CLI would write into the login Keychain: accepted. `test/support/keychain.js` sets `DSHPROXY_KEYCHAIN` for the test process and its children; the wrapper refuses under the test runner without it; a CI step checks the CI machine's login keychain afterwards.
2. Blocker, locked-keychain tests put dialogs on the user's screen: accepted (also seen in A0). Real locked-keychain tests on CI or by opt-in only; a stand-in that does not answer covers it on a developer's Mac. Rejected part: "`create-keychain` adds to the search list": checked on this Mac, it does not.
3. Major, C9 unreachable for readers, and two 10 s waits per snapshot: accepted. C9 split into commands that save a key (non-zero exit) and those that only read (as on Windows); the wrapper keeps a failure for 60 s so a snapshot waits once. `src/app.js` stays as it is.
4. Major, no seam for the wrapper, and exit 44 on an existing `master.key`: accepted. `loadMasterKey(file, { keywrap })`; 44 creates only on the create path. No environment variable chooses the `security` program.
5. Major, `lockFromRelease` signature and `.tar.gz`: accepted. Today's updater tests get an explicit `platform: "win32"`, every assertion kept.
6. Major, no seam for C5: accepted (`backend.checkForUpdate` in the test-only option of `daemon.start`; a failed check is reported).
7. Major, A5 against C11 and portable tests: accepted. Video entries suppressed in `app.videoModels`, not in `profile.js`; one module `src/not-yet.js`; Krea gate in the `require.main` branch; gated set narrowed to the paid and Krea paths, the picker and the plugin install; affected tests listed in A5.
8. Major, shared files and order: accepted. Order A1, A2, A3, A4, A5; A1's verify runs only the master-key tests of `backend.test.js`.
9. Major, `0755` and backups copying `0644`: accepted (`0700`; backups `0600` on macOS).
10. Major, C6 realism: accepted (real executable by full path, `-ww`, `realpath`, missing path).
11. Major, C13: accepted. Windows CI runs `main`'s CLI from a worktree against this one and the reverse; characterization, cannot be red first.
12. Major, modes on Windows and the call site: accepted (macOS only; `src/cli.js`; C10 applies to commands that use the data folder).
13. Nit, C7/C8 tests through the real program and CLI: accepted, in A1.
14. Nit, C2/C3: accepted (C2 by hand and a CI step; `checksums.txt` lines as a fixture; test count step).
15. Nit, `profile.test.js:535`: accepted (a read-only folder on macOS).

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
