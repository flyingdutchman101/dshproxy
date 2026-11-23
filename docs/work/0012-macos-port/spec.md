# 0012 — DSHProxy on macOS: gateway and command line

Status: draft, not approved. Written 2026-11-23.

## Goal

A person with a Mac (Apple Silicon or Intel) and DeepSeek Harness installed can run the DSHProxy gateway from Terminal and use it from the Harness exactly as on Windows: sign in to providers, save API keys, apply the routes to the Harness profiles, chat through a lane, stop and update the gateway.

The user asked for this on 23 Nov ("we need to adjust DSH proxy so it can work on mac", then "macos", then "it's the same setup dsh + dsh proxy").

## Not in this change

- A settings window, a menu-bar icon, or starting at login on the Mac. The C# app under `app/` stays Windows-only. That is the next change.
- `dshproxy dsh bundle install` (the optional video tools plugin for the Harness) on macOS. It needs the layout of the Harness's Mac application, which cannot be read from the Windows install. On macOS the command says so in one sentence and changes nothing.
- iPhone and iPad. Linux.
- Any change to what DSHProxy does on Windows.

## Must stay unchanged

- On Windows: every file format, file location, message and command; the DPAPI protection of `master.key` and of the Krea sign-in; existing data folders work with no migration.
- Decision 0001: the backend is a pinned, unmodified CLIProxyAPI release, checked against its SHA-256 before it is run.
- The gateway listens on this computer only.
- No test that runs on Windows today is removed, skipped or weakened on Windows.

## Terms

- **Data folder**: `~/.dshproxy` (or `DSHPROXY_HOME`). Same on both systems.
- **Harness home**: `~/.dsh` (or `DSH_HOME`). Same on both systems; read in the Harness source.
- **Backend**: the CLIProxyAPI program DSHProxy downloads and runs.
- **Key wrapper**: the one function that wraps and unwraps a file's key for the current user of the computer. Today it exists twice, both DPAPI through PowerShell (`src/secrets.js`, `src/krea-helper/oauth.js`).

## What is Windows-only today

From a survey of the code (`research/facts.md`):

1. The key wrapper: DPAPI through PowerShell, in two places; one of them has no way to supply another implementation.
2. The backend: the lock file names Windows downloads only; the program name ends in `.exe`; unpacking calls `tar.exe` in the Windows folder; a leftover backend is found through PowerShell; the updater knows Windows assets only.
3. The Harness plugin install (`src/dsh/bundle.js`): registry, `cmd.exe`, `taskkill`.
4. Child processes are given a list of environment variables that exist only on Windows.
5. The Krea sign-in store insists on Windows and lives under `%LOCALAPPDATA%`.
6. Files are written without a mode. On Windows the user's folder protects them. On a Mac that leaves them readable by other accounts on the computer, and the Harness refuses to read a `.credentials.yaml` that others can read.
7. `package.json` allows Windows only; CI runs on Windows only; about ten test files assume Windows.

Everything else (the gateway, lanes, failover, limits, models, the profile writer, the video picker's logic, the control API) has no Windows dependence that the survey found.

## Design

### 1. One key wrapper per system, behind one seam

A new module `src/keywrap.js` with one function, `protect(mode, bytes)`, `mode` being `Protect` or `Unprotect`. `src/secrets.js` and the Krea store both call it; both can be given another one (tests already do this for the Krea store).

- **Windows:** the existing DPAPI code, moved, not changed. What is written to disk stays byte-compatible.
- **macOS:** one 32-byte key per user, kept in the user's login Keychain as a generic password (service `DSHProxy`, account `key-wrapper`), created on first use. `Protect` and `Unprotect` are AES-256-GCM with that key, done in Node. The Keychain is reached through `/usr/bin/security`, which is part of macOS. The key is handed to `security` on its standard input, never as a command-line argument, and comes back on its standard output.
- The rule "a key that cannot be read is never replaced" holds on both: when the Keychain cannot be read (locked, refused, `security` missing), DSHProxy says so in one sentence, writes nothing, and does not create a second key.
- Two processes that both find no key at first use end with one key: the one that loses the creation reads the winner's.

### 2. The backend for the Mac's processor

- `backend.lock.json` gains `darwin-arm64` and `darwin-x64` beside the two Windows entries. Release 8.0.72 publishes both as `.tar.gz` (checked on GitHub on 23 Nov).
- Unpacking uses the system's `tar` on each system; the program is `cli-proxy-api.exe` on Windows and `cli-proxy-api` on macOS, where it is also marked executable.
- The updater reads all four assets of a release and refuses a release that lacks any of them, as it refuses one that lacks a Windows asset today.
- A backend left by a gateway that died is recognised by its program path, read with `ps` on macOS, and ended only if that path is DSHProxy's own copy.

### 3. Files that hold secrets are private on macOS

On macOS the data folder is created with mode `0700`, and these are written with mode `0600`: `master.key`, `settings.json`, `backend-config.yaml`, `video-keys.json`, `control.token`, the Krea sign-in file, and the Harness's `.credentials.yaml` (which the Harness refuses otherwise). The backend's own sign-in files under `auth/` are covered by the folder. A file that exists with a wider mode is narrowed when it is next written. Windows is untouched.

### 4. Child processes get the Mac's own short list

The video picker's child, the Krea helper and the Harness plugin's runner pass `HOME`, `TMPDIR` and `DSHPROXY_HOME` on macOS where they pass `SystemRoot`, `LOCALAPPDATA`, `APPDATA`, `TEMP`, `TMP`, `USERPROFILE` and `DSHPROXY_HOME` on Windows. Provider keys are added as today. Nothing else is passed.

### 5. The Krea sign-in on macOS

Stored in `~/Library/Application Support/DSHProxy/KreaOAuth/session.v1`, mode `0600`, wrapped by the key wrapper, renewed as on Windows (decision 0007).

### 6. Packaging and checks

`package.json` allows `darwin`. CI runs the whole suite on `windows-latest` and `macos-latest`. Tests of Windows-only code (the `cmd.exe` plugin install, DPAPI itself, `tar.exe`) run on Windows only and say why when they are skipped elsewhere; each has a macOS counterpart where macOS has its own code. The README gets a macOS section: requirements, install, what is not there yet.

## Acceptance criteria

Automatic, on a macOS machine in CI and, where the same, on Windows:

- **C1.** `npm ci --ignore-scripts` and `node --test` succeed on macOS. On Windows `node --test` runs at least the tests it runs today (914) and all pass.
- **C2.** With an empty data folder on macOS, `dshproxy start` downloads the pinned backend for the machine's processor from the official release address, refuses it if its SHA-256 differs from the lock, unpacks it, starts it, and `GET /dshproxy/status` answers. `dshproxy stop --when-idle` ends the gateway and no backend process is left.
- **C3.** The shipped lock lists four assets, each under the official release address, each with the SHA-256 that the release's `checksums.txt` gives. The updater makes a four-asset lock from a release and refuses a release that lacks one.
- **C4.** A leftover backend is ended on the next start only when its program path is DSHProxy's own; another program's process with the recorded id is left alone.
- **C5.** On macOS an API key saved with `dshproxy key set` is read back by a new process; `master.key` and `settings.json` do not contain it; the Keychain item is created once; a second process started at the same moment ends with the same key.
- **C6.** No secret is in the arguments or the environment of any process the key wrapper starts on macOS. Shown twice: with a stand-in for `security` that records what it was given, and on the CI Mac against the real program.
- **C7.** When the Keychain cannot be read, every command that needs the key ends with one sentence and a non-zero exit, and the data folder and the Keychain are byte for byte what they were.
- **C8.** After any DSHProxy command on macOS, the data folder is `0700` and every file listed in design 3 is `0600`. After `dshproxy dsh apply`, the Harness's `.credentials.yaml` is `0600`, also when it existed as `0644`.
- **C9.** `dshproxy dsh apply`, `verify`, `status` and `remove` produce the same profile text on macOS as on Windows for the same input (the existing profile tests, run on both).
- **C10.** `dshproxy dsh bundle status` and `install` on macOS print one sentence that the plugin install is not available on macOS yet, exit non-zero, and change nothing.
- **C11.** A real child process started by the video picker and by the Krea helper path on macOS sees `HOME`, `TMPDIR`, `DSHPROXY_HOME`, the provider key it was given, what the system itself adds, and nothing else.
- **C12.** The Krea sign-in store on macOS passes the same renewal tests as on Windows (one renewal between two helpers, a dead helper holds nothing up, refusal drops the renewal token), with the real file and the real lock.
- **C13.** On Windows, a data folder written by the current version is read by the new one, and the files the new one writes are read by the current one.

By hand, on the user's Mac (cannot be automated; needs sign-ins):

- **M1.** Install as the README says; `dshproxy start` runs.
- **M2.** `dshproxy login` for one provider opens the provider's page and the account is listed afterwards.
- **M3.** `dshproxy dsh apply`, restart the Harness, pick a lane, get an answer.
- **M4.** No Keychain prompt appears at any point. After the Mac is restarted and the user has logged in, `dshproxy start` works without a prompt.
- **M5.** With video in scope: a Krea sign-in, a quote, and a rehearsal in the model picker.

## Riskiest assumption

That `/usr/bin/security` gives a background Node process a store that is per user, asks nothing, and takes the secret on standard input.

Hardest case: on a machine nobody is sitting at (the CI Mac), two processes start at once with no key in the Keychain, and both must end with the same key, with no secret in any argument list, and no prompt.

This is proven first, with a throwaway script on the CI Mac, before any production code depends on it. If it fails, the fallback below is put to the user; it is not chosen silently.

## Rejected alternatives and risks

- **Key wrapper as a private file** (`0600`, no Keychain). Simpler and works with no one logged in at the screen. Rejected as the first choice because a copy of the disk or of a backup would then hold both the key and what it protects; with the Keychain the login password is needed, which is what DPAPI gives on Windows. It is the fallback if the Keychain cannot be used unattended.
- **A native helper** (Swift, or a Node add-on) for the Keychain. Rejected: a compiled part to build, sign and ship for one read and one write.
- **Porting the plugin install now.** Rejected for this change: the Mac application's folder layout, program name and command launcher are only inferred from the Windows install.
- **Rewriting the C# app as a cross-platform window now.** Rejected for this change: the gateway has to run on a Mac first.
- **Risk: the pinned backend may not start on a Mac** (processor, signing). C2 on the CI Mac shows it for Apple Silicon; Intel is covered by a second CI machine if GitHub still offers one, otherwise it stays unverified and the README says so.
- **Risk: a Mac reached only over SSH** has a locked Keychain. C7 is the behaviour there; the README says the gateway is started from a logged-in session.
- **Risk: tests split by system drift apart.** Kept small by the seam: only the key wrapper, unpacking, the process lookup and the environment list differ.
- **Known and unchanged:** `backend-config.yaml` holds the API keys in plain text for the backend to read, on both systems. On macOS it is `0600`.

## Open decisions for the user

1. **Video on the Mac in this change, or after?** Proposed: in this change, built after the core (criteria C11, C12, M5). Leaving it out removes design 4 and 5.
2. **Keychain, or a private file, for the key wrapper?** Proposed: Keychain, with the private file as the fallback if the first proof fails.
3. **Pushing the `macos-port` branch to GitHub so that CI can run on a Mac.** Nothing in this change can be shown to work without it. The repository is public, so macOS CI minutes cost nothing.
