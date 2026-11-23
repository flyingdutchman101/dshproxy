# Plan — 0013 DSHProxy on macOS, stage A

Status: draft written on Windows on 23 Nov for the hand-over to the Mac. **Not reviewed** (the plan lens of `spec-review` has not run) and not started. Stages B to D get their plans when they start; see the spec.

Mode: cheap. Slices in order, inline, one independent review of the branch at the end of stage A.

Rules that hold for every slice:

- Red before green: the test of the slice fails on the code before the slice, for the reason the slice is about.
- Windows behaviour does not change. A test may be split by system; a Windows test is never removed or weakened.
- Tests never touch a login Keychain. They use `DSHPROXY_KEYCHAIN` with a keychain file they create and delete.
- Checks on both systems: on the Mac, `node scripts/check.js` and `node --test`; on Windows, CI. CI runs for pushes to `main` and for pull requests only (`.github/workflows/ci.yml`), so Windows results need a pull request from `macos-port`. Opening one is the user's call.

## Slices

### A0 — Baseline on the Mac
- depends-on: none
- files: `package.json` (`"os"` gains `darwin`), `docs/work/0013-macos-port/ledger.md`
- do: `npm ci --ignore-scripts`; `node docs/work/0013-macos-port/spike/proof.js` (repeats the proof on this Mac; off GitHub it uses only a keychain file in the temporary folder); `node --test`, and record in the ledger which test files fail and why. The survey's forecast is in `research/facts.md` section 3, "Packaging and tests".
- verify: the proof prints `0 failed`; the list of failing tests is in the ledger.

### A1 — The key wrapper (the risky part, first)
- depends-on: A0
- files: new `src/keywrap-darwin.js`, new `test/keywrap-darwin.test.js`; `src/secrets.js` (choose by system; Windows code untouched)
- seam/test: `protect(mode, bytes, { security, keychain })` and `loadMasterKey`. With a stand-in for `security` that records its arguments, environment and standard input: nothing secret in arguments or environment (C8); exit 44 creates a key, any other failure creates nothing (C9); a call that does not answer is ended after 10 s. On a Mac, with a real throwaway keychain: round trip, a second process gets the same key (C7), a locked keychain leaves the file and the keychain as they were (C9).
- note: `spike/proof.js` has the exact `security` calls that were seen to work (`write`, `read`, the quoting of the keychain path).
- verify: `node --test test/keywrap-darwin.test.js test/backend.test.js test/video-keys.test.js`

### A2 — Private files
- depends-on: A0
- files: `bin/dshproxy.js`, `bin/dshproxy-krea.js` (mask `077` on macOS, first thing); `src/settings.js` (data folder `0700` at start); `src/dsh/profile.js` (`.credentials.yaml` to `0600` on every apply; `verify` reports a readable one); new `test/modes-darwin.test.js`; `test/profile.test.js:535-549` split by system (on a Mac a rename over a read-only file succeeds)
- seam/test: run the real CLI in a throwaway home with the mask at 022, then walk the data folder and the Harness home: no group or others bit (C10); `.credentials.yaml` that was `0644` and already held the reference is `0600` after `dsh apply`.
- verify: `node --test test/modes-darwin.test.js test/profile.test.js test/cli.test.js`

### A3 — The backend on a Mac
- depends-on: A0
- files: `backend.lock.json` (two macOS assets; digests in `research/facts.md` section 1); `src/backend/install.js` (program name and `tar` by system, executable mark); `src/backend/supervisor.js` (`ps -o comm=`, `realpath`, exact comparison on macOS; pass `processPath` through `createSupervisor`); `test/backend.test.js` (the archive fixture by system)
- seam/test: `install(lock, binDir, { download })` with a `.tar.gz` made by the test; `reclaimOrphan` against a real child process started by its full path, and against a process that is not ours (C6); the lock's four assets (C3).
- verify: `node --test test/backend.test.js`, then by hand `node bin/dshproxy.js start` in a throwaway `DSHPROXY_HOME` and `stop --when-idle` (C2). This downloads 24 MB from GitHub.

### A4 — Updates
- depends-on: A3
- files: `src/backend/updater.js` (`ASSET_KEYS` for four; the rule "own system's assets required, the other's kept when present"); `src/cli.js` (`backend update`, through `update/check` and `update/apply` of the control API; help text); `test/updater.test.js`, `test/cli.test.js`
- seam/test: `lockFromRelease(release, { platform })` for the three kinds of release in C4, on both values of `platform`; the Windows cases are today's tests, unchanged. `backend update` against a gateway with a stand-in for GitHub (C5).
- verify: `node --test test/updater.test.js test/cli.test.js test/daemon.test.js`

### A5 — What is not there yet says so
- depends-on: A0
- files: `src/cli.js` (`video`, `dsh bundle`), `bin/dshproxy-krea.js`, `src/daemon.js` (no video picker mounted on macOS), `src/dsh/profile.js` (no video route written on macOS); new `test/not-yet-darwin.test.js`; the Windows-only tests of video and of the plugin install get a skip on macOS that names stage B or C
- seam/test: C12, through the real CLI and a real gateway on a free port.
- note: each of these is removed again by stage B or C. Keep them in one place so that removing them is one edit.
- verify: `node --test` on the Mac passes as a whole (C1).

### A6 — Packaging, words, cleaning up
- depends-on: A1 to A5
- files: `.github/workflows/ci.yml` (`macos-latest` beside `windows-latest`); `README.md` (a macOS section); new `docs/decisions/0009-keys-on-macos-are-wrapped-through-the-keychain.md`; delete `.github/workflows/macos-proof.yml` and `docs/work/0013-macos-port/spike/` once their facts are in tests
- verify: CI green on both systems for the pull request; C13 by a test that reads a data folder fixture written by `main`.

### A7 — Independent review, then the check by hand
- one `reviewer` call on the diff of stage A against `main`, with the spec's criteria and the test output; fix what it finds.
- M1 to M4 on the Mac, recorded in the ledger. The provider sign-in in M2 is the user's.

## Order and what can run side by side

A0, then A1. A2, A3 and A5 touch different files from A1 and from each other, except `src/dsh/profile.js` (A2 and A5) and `bin/dshproxy-krea.js` (A2 and A5): do A2 before A5. A4 after A3. A6 and A7 last.
