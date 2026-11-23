# 0012 — DSHProxy on macOS: gateway and command line

Status: revised after spec review and after the proof on two GitHub Macs; not approved. Written 2026-11-23.

## Goal

A person with a Mac (Apple Silicon or Intel) and DeepSeek Harness installed can run the DSHProxy gateway from Terminal and use it from the Harness as on Windows: sign in to providers, save API keys, apply the routes to the Harness profiles, chat through a lane, stop the gateway, and move the backend to a newer release.

The user asked for this on 23 Nov ("we need to adjust DSH proxy so it can work on mac", then "macos", then "it's the same setup dsh + dsh proxy").

The work is two releases. **Release A** is the gateway without video and is what this document specifies. **Release B** is video on the Mac; it is outlined at the end and gets its own criteria once A runs on the user's Mac.

## Not in this change

- A settings window, a menu-bar icon, or starting at login on the Mac. The C# app under `app/` stays Windows-only.
- `dshproxy dsh bundle install` (the optional video tools plugin for the Harness) on macOS. It needs the layout of the Harness's Mac application, which cannot be read from the Windows install.
- Video on macOS in Release A: every `dshproxy video` command and the video entries of the model picker.
- iPhone and iPad. Linux.
- Any change to what DSHProxy does on Windows, with one addition that is the same on both systems: the new command `dshproxy backend update`.

What is not there yet says so: on macOS each of these commands prints one sentence that it is not available on macOS yet, exits non-zero and changes nothing; the gateway does not answer on the video path.

## Must stay unchanged

- On Windows: every file format, file location, message and existing command; both existing ways `master.key` and the Krea sign-in are protected with DPAPI, each left exactly as it is; which backend releases an update accepts; existing data folders work with no migration.
- Decision 0001: the backend is a pinned, unmodified CLIProxyAPI release, checked against its SHA-256 before it is run.
- The gateway listens on this computer only.
- No test that runs on Windows today is removed, skipped or weakened on Windows.

## Terms

- **Data folder**: `~/.dshproxy` (or `DSHPROXY_HOME`). Same on both systems.
- **Harness home**: `~/.dsh` (or `DSH_HOME`). Same on both systems; read in the Harness source.
- **Backend**: the CLIProxyAPI program DSHProxy downloads and runs.
- **Key wrapper**: what wraps and unwraps a file's key for the current user of the computer. On Windows it is DPAPI through PowerShell, written twice in two different ways (`src/secrets.js` passes the key in the child's environment; `src/krea-helper/oauth.js` passes it on standard input).

## What is Windows-only today

From a survey of the code (`research/facts.md`):

1. The key wrapper. `src/secrets.js` has no way to supply another one.
2. The backend: the lock file names Windows downloads only; the program name ends in `.exe`; unpacking calls `tar.exe` in the Windows folder; a leftover backend is found through PowerShell; the updater knows Windows assets only and can be started only from the Windows app.
3. The Harness plugin install (`src/dsh/bundle.js`): registry, `cmd.exe`, `taskkill`.
4. Video: child processes are given environment variables that exist only on Windows; the Krea sign-in store insists on Windows.
5. Files are written without a mode. On Windows the user's folder protects them. On a Mac that leaves them readable by other accounts on the computer, and the Harness refuses to read a `.credentials.yaml` that others can read.
6. `package.json` allows Windows only; CI runs on Windows only; about ten test files assume Windows.

Everything else (the gateway, lanes, failover, limits, models, the profile writer, the control API) has no Windows dependence that the survey found.

## Design of Release A

### 1. A key wrapper for macOS, chosen by system

- **Windows:** nothing moves. `loadMasterKey` in `src/secrets.js` keeps its DPAPI code as it is.
- **macOS:** `loadMasterKey` uses a new module, `src/keywrap-darwin.js`, with `protect(mode, bytes)`. It keeps one 32-byte key per user in a Keychain, as a generic password (service `DSHProxy`, account `key-wrapper`, the key written as 64 hex characters), created on first use. `Protect` and `Unprotect` are AES-256-GCM with that key, done in Node. `master.key` then holds the wrapped master key, as it holds a DPAPI blob on Windows.
- The Keychain is reached through `/usr/bin/security`, which is part of macOS. To write, DSHProxy starts `security -i` and sends the one command on its standard input, so the key is in no argument list and no environment. To read, `find-generic-password -w` prints it on standard output. Every call ends after 10 seconds, as the DPAPI calls do today.
- Which Keychain: the user's login Keychain, or the keychain file named in `DSHPROXY_KEYCHAIN`. Tests use a throwaway keychain file that they create and delete. No test reads, writes or deletes anything in a login Keychain.
- The rule "a key that cannot be read is never replaced" holds: when the Keychain cannot be read (locked, refused, timed out, `security` missing), DSHProxy says so in one sentence, writes nothing, and does not create a second key.
- A locked Keychain: macOS puts up its own dialog asking for the Keychain password and `security` waits for it. DSHProxy ends the call after 10 seconds, says that the Keychain is locked, and writes nothing. The dialog can stay on the screen afterwards; it is macOS's. Seen on both GitHub Macs. There is no way to see "locked" without waiting: the command that shows a keychain's settings waits for the same dialog. Not seen: what happens over SSH with nobody logged in at the screen.
- Two processes that both find no key at first use end with one key: creation without overwriting fails for the second, which then reads the first's.

### 2. The backend for the Mac's processor

- `backend.lock.json` gains `darwin-arm64` and `darwin-x64` beside the two Windows entries. Release 8.0.72 publishes both as `.tar.gz` (checked on GitHub on 23 Nov).
- Unpacking uses the system's own `tar` on each system. On macOS the program is the file `cli-proxy-api` in the archive (seen in the proof, already marked executable there; DSHProxy sets the mark itself as well).
- A backend left by a gateway that died is recognised by its program path, read with `ps -o comm=` on macOS, both paths resolved with `realpath` and compared exactly, and ended only if it is DSHProxy's own copy. `ps` shows the path a program was started with; DSHProxy always starts the backend by its full path, so its own is recognised and anything else is left alone.
- **Updates.** An update needs the assets of the system it runs on, for both processors, and keeps the other system's entries when the release has them. On Windows that is exactly today's rule. A new command, `dshproxy backend update`, asks the running gateway to check for a newer release and apply it, through the control routes the Windows app already uses; it exists on both systems. `dshproxy backend rollback` works on macOS as on Windows.

### 3. Nothing DSHProxy writes on macOS is readable by other accounts

- On macOS each program under `bin/` sets its file-creation mask to `077` before it does anything else, so every file and folder it creates, temporary files included, is private from the first byte, and the backend it starts inherits that.
- At start the data folder is set to `0700`.
- `dshproxy dsh apply` sets the Harness's `.credentials.yaml` to `0600` every time, also when it has nothing to add to it. `dshproxy dsh verify` reports a `.credentials.yaml` that group or others can read, because the Harness will refuse it.
- Windows is untouched.

### 4. What is not available says so

On macOS, `dshproxy video ...`, `dshproxy dsh bundle ...` and the Krea helper each print one sentence, exit non-zero and change nothing. The gateway does not mount the video picker. `dshproxy dsh apply` therefore writes no video route.

### 5. Packaging and checks

- `package.json` allows `darwin`.
- CI runs the whole suite on `windows-latest` and `macos-latest`.
- Tests of Windows-only code (the `cmd.exe` plugin install, DPAPI itself, `tar.exe`, video) run on Windows only and say why when they are skipped on macOS. Where macOS has its own code there is a macOS test of the same behaviour.
- The README gets a macOS section: requirements, install, what is not there yet, and what protects which secret. Decision 0009 records the key wrapper on macOS and its cost.

## Acceptance criteria of Release A

Automatic, on a macOS machine in CI and, where the same, on Windows:

- **C1.** `npm ci --ignore-scripts` and `node --test` succeed on macOS. On Windows `node --test` runs at least the tests it runs today (914) and all pass.
- **C2.** With an empty data folder on macOS, `dshproxy start` downloads the pinned backend for the machine's processor from the official release address, refuses it if its SHA-256 differs from the lock, unpacks it, starts it, and `GET /dshproxy/status` answers. `dshproxy stop --when-idle` ends the gateway and no backend process is left.
- **C3.** The shipped lock lists four assets, each under the official release address, each with the SHA-256 that the release's `checksums.txt` gives.
- **C4.** An update made on macOS from a release with all four assets writes a four-asset lock; from a release without a Windows asset it writes the two macOS ones; from a release without a macOS asset it is refused. On Windows, which releases are accepted is what it is today.
- **C5.** `dshproxy backend update` against a running gateway reports "up to date", or applies a newer release and the gateway answers on it afterwards; with no gateway running it says so and changes nothing. Tested with a stand-in for GitHub.
- **C6.** A leftover backend is ended on the next start only when its program path is DSHProxy's own; another program's process with the recorded id is left alone.
- **C7.** On macOS an API key saved with `dshproxy key set` is read back by a new process; `master.key` and `settings.json` do not contain it; the Keychain item is created once; a second process started at the same moment ends with the same key.
- **C8.** No secret is in the arguments or the environment of any process the macOS key wrapper starts. Shown twice: with a stand-in for `security` that records what it was given, and on the CI Mac against the real program with a throwaway keychain.
- **C9.** When the Keychain cannot be read (a locked throwaway keychain; a `security` that does not answer for 10 seconds; no `security`), every command that needs the key ends with one sentence and a non-zero exit within 15 seconds, and the data folder and the keychain are byte for byte what they were.
- **C10.** After any DSHProxy command on macOS, the data folder is `0700` and nothing that command created or replaced, there or in the Harness home, has a group or others bit. After `dshproxy dsh apply`, `.credentials.yaml` is `0600`, also when it was `0644` and already held the reference. `dshproxy dsh verify` reports one that is `0644`.
- **C11.** `dshproxy dsh apply`, `verify`, `status` and `remove` produce the same profile text on macOS as on Windows for the same input (the existing profile tests, run on both).
- **C12.** On macOS, `dshproxy video picker`, `dshproxy dsh bundle status`, `dshproxy dsh bundle install` and `dshproxy-krea status` each print the one sentence, exit non-zero and change nothing; a request to the gateway's video path is answered "not found".
- **C13.** On Windows, a data folder written by the current version is read by the new one, and the files the new one writes are read by the current one.

By hand, on the user's Mac (cannot be automated; needs sign-ins):

- **M1.** Install as the README says; `dshproxy start` runs.
- **M2.** `dshproxy login` for one provider opens the provider's page and the account is listed afterwards.
- **M3.** `dshproxy dsh apply`, restart the Harness, pick a lane, get an answer.
- **M4.** In normal use no Keychain dialog appears. After the Mac is restarted and the user has logged in, `dshproxy start` works without one.

## Riskiest assumption

That `/usr/bin/security` gives a background Node process a store that is per user, asks nothing while the Keychain is unlocked, and takes the secret on standard input.

Hardest case: on a machine nobody is sitting at (the CI Mac), two processes start at once with no key in a throwaway keychain; both must end with the same key, no secret in any argument list, and no prompt. Then the keychain is locked, and a read must end with an error, not hang.

This is proven first, with a throwaway script on the CI Mac, before any production code depends on it. The same script checks that the pinned backend's archive unpacks, what the program in it is called, and that it starts. If the Keychain part fails, the fallback below is put to the user; it is not chosen silently.

**Result, 23 Nov** (`spike/proof.js`, GitHub runs 45221540307 and 45221963088, Apple Silicon on macOS 26.7 and Intel on macOS 15.7; details in `research/facts.md` section 5):

- Holds: a key sent on standard input to `security -i` is stored and read back; the argument list shows only `-i`; a second write is refused and nothing is overwritten; four processes at once ended with one key in 15 of 15 rounds on both machines; the machine's own default keychain was written and read with no prompt; "no key yet" (exit 44) is distinct from every other outcome.
- Does not hold as first written: a read of a locked keychain does not end with an error. It waits for a dialog, on a machine with nobody at it too, and has to be ended. Design 1 and C9 say so now.
- The backend: both archives match their SHA-256, unpack with `/usr/bin/tar`, hold `cli-proxy-api`, start with the gateway's own configuration, answer on `/v1/models` in half a second, and end on SIGTERM. Both processors.

## What the Keychain does and does not protect

Stated plainly, because it bears on the choice below:

- The backend reads its API keys from `backend-config.yaml`, which holds them in plain text, and keeps the provider sign-ins as plain files under `auth/`. That is so on Windows today and stays so. On macOS both are private to the user's account (design 3).
- So in Release A the key wrapper protects only the copy of the API keys in `settings.json`. A copy of the disk or of a backup that includes the data folder holds the API keys either way.
- The key wrapper matters in Release B: the video provider keys and the Krea sign-in exist only in wrapped form.

## Rejected alternatives and risks

- **Key wrapper as a private file** (`0600`, no Keychain). Simpler, no dependence on `security`, works with nobody logged in at the screen. Not the first choice because it would have to be replaced, with a migration, when video comes and the wrapper starts to protect something that is nowhere else in plain text. It is the fallback if the Keychain cannot be used unattended.
- **Merging the two Windows DPAPI paths into one module.** Rejected: it rewrites working Windows code the port does not need to touch.
- **A mode on every file write.** Rejected for the file-creation mask: about a dozen places write files, and a write added later would miss it.
- **A native helper** (Swift, or a Node add-on) for the Keychain. Rejected: a compiled part to build, sign and ship for one read and one write.
- **Requiring all four assets for every update.** Rejected: a release without a macOS archive would stop reaching Windows users.
- **Porting the plugin install now.** Rejected for this change: the Mac application's folder layout, program name and command launcher are only inferred from the Windows install.
- **Risk: the pinned backend may not start on a Mac** (processor, signing). The proof showed it starting on Apple Silicon and on Intel. On a GitHub Mac nothing marks the downloaded file as coming from the internet; whether the user's Mac objects to a program that is not signed by a known developer shows at M1.
- **Risk: a Keychain that is locked while the user is logged in** (a setting some people use) makes macOS ask for the login password whenever the gateway needs the key. Design 1 and C9 are the behaviour; the README says it.
- **Risk: tests split by system drift apart.** Kept small: only the key wrapper, unpacking, the process lookup and the file modes differ in Release A.

## Release B, outline only: video on macOS

Not built until Release A has passed M1 to M4 on the user's Mac. It gets its own criteria then. Known now:

- The Krea sign-in store: `~/Library/Application Support/DSHProxy/KreaOAuth/` (folder `0700`), wrapped by the macOS key wrapper through the `protect` option the store already has; the Windows store unchanged.
- The video picker's child and the Krea helper pass `HOME`, `TMPDIR` and `DSHPROXY_HOME` on macOS where they pass the Windows names today, plus the provider key on API routes.
- To check before building: that the purchase journal's rules about a file's creation time hold on APFS, and that what Node does for `fsync` on macOS reaches the disk (the reviewer says it does not; libuv's source is believed to use `F_FULLFSYNC` there; not checked).
- The Harness plugin's runner is left alone until the plugin install is ported.

## Open decisions for the user

1. **Video on the Mac: after the core is confirmed on your Mac (proposed), or built straight after it without waiting.**
2. **Keychain, or a private file, for the key wrapper.** Proposed: Keychain if the first proof passes, the private file if it does not. See "What the Keychain does and does not protect".
3. **Pushing the `macos-port` branch to GitHub so that CI can run on a Mac.** Nothing in this change can be shown to work without it. The repository is public, so macOS CI minutes cost nothing.
