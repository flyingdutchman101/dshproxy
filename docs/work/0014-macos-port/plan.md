# Plan — 0014 DSHProxy on macOS, stage A

Status: written on Windows on 23 Nov; **revised on the Mac on 23 Nov after the plan review** (2 Blocker, 9 Major, 4 Nit; findings and what was done in `ledger.md`). Stages B to D get their plans when they start; see the spec.

Mode: cheap. Slices in order, inline, one independent review of the branch at the end of stage A.

Rules that hold for every slice:

- Red before green: the test of the slice fails on the code before the slice, for the reason the slice is about. A characterization test that cannot be red first (C13) says so.
- Windows behaviour does not change. A test may be split by system; a Windows test is never removed or weakened. Where an existing Windows test needs an argument that today is implicit (the updater's `platform`), it gets it explicitly and keeps every assertion.
- Tests never touch a login Keychain. Every test file that can reach the key wrapper requires `test/support/keychain.js`, which on macOS creates a throwaway keychain file (unlocked, no automatic lock) in the temporary folder, puts its path in `process.env.DSHPROXY_KEYCHAIN` before anything else runs, so that every CLI child started with `...process.env` inherits it, and deletes it at exit. As a second line: on macOS the key wrapper refuses to run when `NODE_TEST_CONTEXT` is set (the test runner sets it, children inherit it) and `DSHPROXY_KEYCHAIN` is not. A child started by a test with a hand-made environment that names neither would use the login Keychain: such spawns are listed and checked in A1. On the macOS CI machine a step after the tests asserts `security find-generic-password -s DSHProxy -a key-wrapper` exits 44 (its own throwaway login keychain).
- **No Keychain dialog on the user's screen.** A test that locks a real keychain runs only on CI (`GITHUB_ACTIONS=true`) or with `DSHPROXY_TEST_LOCKED_KEYCHAIN=1`; on a developer's Mac it is skipped with that reason and the same behaviour is covered with a `security` stand-in that does not answer. Seen in A0: on a Mac with someone at the screen a pending dialog stays and blocks later calls on that keychain.
- `security create-keychain` and `delete-keychain` did not change the user's keychain search list on this Mac (checked 23 Nov); no test changes the search list.
- Checks on both systems: on the Mac, `node scripts/check.js` and `node --test`; on Windows, CI on the draft pull request #1.

## Slices

### A0 — Baseline on the Mac (done 23 Nov)
- files: `package.json`, `package-lock.json` (`"os"` gains `darwin`), ledger, `research/facts.md` section 6.

### A1 — The key wrapper (the risky part, first)
- depends-on: A0
- files: new `src/keywrap-darwin.js`; `src/secrets.js` (on `darwin` `loadMasterKey` uses the new module; the DPAPI code is not touched; an optional `keywrap` option for tests); new `test/support/keychain.js`; new `test/keywrap-darwin.test.js`; `test/backend.test.js`, `test/cli.test.js`, `test/video-command.test.js`, `test/video-concurrency.test.js`, `test/video-picker-callers.test.js`, `test/video-keys.test.js` (require the support file; no assertion changes).
- seam: `createKeywrap({ security, keychain, timeoutMs })` → `{ wrap(bytes), unwrap(text) }`, and `loadMasterKey(file, { create, keywrap })`.
- tests (stand-in `security`, a small script that records its arguments, environment and standard input): nothing secret in arguments or environment (C8, first half); exit 44 on the **create** path makes one key; 44 when unwrapping an existing `master.key` is "cannot be read" and creates nothing; any other exit, no program, or no answer within the time limit is one sentence, no file written (C9 at module level); a second write refused with 45 reads and uses the stored key (C7). With a real throwaway keychain: round trip; two processes at once end with one key (C7); `ps -ww -o args=,command=` during a real `security -i` call shows no secret (C8, second half); `dshproxy key set` read back by a new process, `master.key` and `settings.json` without the key (C7 through the CLI); locked keychain, CI or opt-in only: `key set` ends non-zero within 15 s, `status` within 15 s, data folder and keychain byte for byte unchanged (C9 through the CLI).
- the wrapping key is kept in memory for the life of the process once read; a "cannot be read" is kept for 60 s, so the two loads of one `snapshot` and the gateway's repeated syncs wait 10 s at most once a minute (`src/app.js` unchanged).
- verify: `node --test test/keywrap-darwin.test.js test/cli.test.js test/video-keys.test.js test/video-command.test.js test/video-concurrency.test.js test/video-picker-callers.test.js` and `node --test --test-name-pattern "master key" test/backend.test.js` (the archive tests in that file wait for A3).

### A2 — Private files
- depends-on: A0
- files: `bin/dshproxy.js`, `bin/dshproxy-krea.js` (mask `077` on `darwin`, first thing); `src/cli.js` (data folder `0700` on `darwin` after the home is known, near `cli.js:337`; a command that ends before touching the data folder, such as a not-yet sentence, does not create it); `src/dsh/profile.js` (on `darwin` only: `.credentials.yaml` to `0600` on every apply, backups `0600` because `copyFileSync` copies the source's mode, `verify` reports a `.credentials.yaml` with a group or others bit); new `test/modes-darwin.test.js`; `test/profile.test.js:535-549` split: Windows keeps today's test, macOS gets the same behaviour with a read-only directory (rename refused, profile and folder unchanged).
- tests: the real CLI in a throwaway home with the mask at 022, then walk the data folder and the Harness home: no group or others bit (C10); `.credentials.yaml` that was `0644` and already held the reference is `0600` after `dsh apply`; `dsh verify` reports one that is `0644`.
- verify: `node --test test/modes-darwin.test.js test/profile.test.js test/cli.test.js`

### A3 — The backend on a Mac
- depends-on: A0
- files: `backend.lock.json` (two macOS assets); `src/backend/install.js` (program name and system `tar` by system; on `darwin` the program is `chmod 0700`, not `0755`, so C10 holds); `src/backend/supervisor.js` (on `darwin`: `/bin/ps -ww -o comm= -p PID`, both paths through `realpath`, exact comparison; a path that no longer exists is not ours; `createSupervisor` passes `processPath`/`kill` through); `test/backend.test.js` (the archive fixture by system: `.zip` with `tar.exe` on Windows as today, `.tar.gz` with `/usr/bin/tar` on macOS); `test/backend-lock.test.js` (new: four assets, each URL official, each SHA-256 equal to the line of the release's `checksums.txt`, kept as a fixture; C3).
- tests: `install(lock, binDir, { download })` with an archive made by the test, program executable and `0700`; `reclaimOrphan` against a real process started by its full path from a temporary folder (a copy of `node`, a path longer than 100 characters, `/var` vs `/private/var`), against a process that is not ours, and with a program path that no longer exists (C6).
- verify: `node --test test/backend.test.js test/backend-lock.test.js`, then by hand `node bin/dshproxy.js start` in a throwaway `DSHPROXY_HOME` and `stop --when-idle` (C2; downloads 24 MB). C2 also runs in the macOS CI job as its own step (A6).

### A4 — Updates
- depends-on: A3
- files: `src/backend/updater.js` (asset table for four, with each system's archive extension; `lockFromRelease(release, sums, { platform })`, default `process.platform`; own system's assets required, the other's kept when present; `checkForUpdate` passes it); `src/daemon.js` (the test-only `backend` option of `start` also takes `checkForUpdate`); `src/cli.js` (`backend update` through `update/check` and `update/apply` of the control API; an error from the check is reported as such, not as "up to date"; help text); `test/updater.test.js` (today's calls gain `{ platform: "win32" }`, assertions unchanged; new cases for `darwin`), `test/cli.test.js` or new `test/backend-update.test.js`.
- tests: C4 for the three kinds of release on both values of `platform`; C5 against a real gateway on a free port with a stand-in for GitHub and the test install.
- verify: `node --test test/updater.test.js test/backend-update.test.js test/daemon.test.js`

### A5 — What is not there yet says so
- depends-on: A2 (both touch `bin/dshproxy-krea.js` and `src/cli.js`)
- files: new `src/not-yet.js` (the one place: which functions wait for which stage, and the sentence); `src/cli.js` (`video picker`, `video submit`, `video status`, every Krea route, `video krea`, `dsh bundle`); `bin/dshproxy-krea.js` (in the `require.main === module` branch, so `main()` stays testable); `src/daemon.js` (no video picker mounted on `darwin`); `src/app.js` `videoModels` (no video entries on `darwin`, so `dsh apply` writes no video route and the profile text of C11 is unchanged); new `test/not-yet-darwin.test.js`.
- open on macOS in stage A, because they need only the master key: `video help`, `video list`, `video quote` on API routes (offline), `video key set|list|remove`.
- the tests that reach a gated function on macOS get `skip` on `darwin` with "stage B" or "stage C" in the reason; they are listed here before the slice is committed, and each one is taken out again by its stage. Known from the review: `video-command.test.js` 13, 75, 326; `video-entry-settings.test.js` 231; `video-concurrency.test.js` 315; `video-picker-callers.test.js` 93-121; `daemon.test.js` 1371-1380; `video-picker-wired.test.js`; `dsh-bundle.test.js`; `krea-renewal-process.test.js`; `krea-oauth.test.js` 128; `integrations/dsh-video/test/dsh-video.test.mjs` 151.
- tests: C12 through the real CLI and a real gateway on a free port.
- verify: `node --test` on the Mac passes as a whole (C1).

### A6 — Packaging, words, cleaning up
- depends-on: A1 to A5
- files: `.github/workflows/ci.yml` (`macos-latest` beside `windows-latest`; on macOS a step for C2 and the step that checks the login keychain was not touched; on Windows a step for C13 and the test count, at least 914); new `test/compat-main.test.js` (C13, Windows only, characterization: `main`'s CLI from a worktree writes a data folder that this one reads, and the reverse; runs when `DSHPROXY_BASE_CHECKOUT` names that checkout); `README.md` (a macOS section); new `docs/decisions/0009-keys-on-macos-are-wrapped-through-the-keychain.md`; delete `.github/workflows/macos-proof.yml` and `docs/work/0014-macos-port/spike/` once their facts are in tests.
- verify: CI green on both systems for the pull request.

### A7 — Independent review, then the check by hand
- one review of the diff of stage A against `main`, with the spec's criteria and the test output; fix what it finds.
- M1 to M4 on the Mac, recorded in the ledger. The provider sign-in in M2 is the user's.

## Order and files shared between slices

A1, A2, A3 in that order, then A4 (after A3), then A5 (after A2), then A6, A7.

Files touched by more than one slice: `test/backend.test.js` (A1 master-key tests, A3 archive and reclaim tests); `test/cli.test.js` (A1 support file, A2, A4); `src/cli.js` (A2, A4, A5); `src/daemon.js` (A4, A5); `bin/dshproxy-krea.js` (A2, A5); `test/video-*.test.js` (A1 support file, A5 skips). Slices run one after the other, so this is ordering, not conflict.
