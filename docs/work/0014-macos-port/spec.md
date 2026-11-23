# 0014 — DSHProxy on macOS

Status: goal set by the user on 23 Nov; stage A specified and reviewed; stages B to D outlined. The document as a whole has not been read and approved by the user. Written 2026-11-23 on Windows; the work continues on the user's Mac.

## Goal

DSHProxy on a Mac (Apple Silicon or Intel) does what it does on Windows, **exactly the same functionality**: the gateway and the command line, video (the `dshproxy video` commands, the paid entries in the Harness model picker, the Krea sign-in), the video tools plugin for the Harness, and the app with its window, its icon beside the clock, and starting at login.

The user's words, 23 Nov: "we need to adjust DSH proxy so it can work on mac"; "macos"; "it's the same setup dsh + dsh proxy"; "you can push the thing and i'll continue developing it on mac np, it does need same fuctionality, exactly the same as win".

It is built in four stages, each usable when it is done:

| Stage | What works on the Mac afterwards | State of this document |
|---|---|---|
| **A** | The gateway and the command line, without video: sign in to providers, save API keys, apply the routes to the Harness, chat through a lane, stop, update the backend. | Specified below, with criteria. Reviewed. Riskiest part proven on two Macs. |
| **B** | Video, as on Windows. | Outlined. Criteria are written on the Mac before it is built. |
| **C** | `dshproxy dsh bundle install`: the video tools plugin for the Harness. | Outlined. Needs facts that can only be read on a Mac. |
| **D** | The app: accounts, API keys, lanes, the Harness page, the log; icon in the menu bar; start at login. | Outlined. Starts with a decision and a prototype. |

## Not in this change

- iPhone and iPad. Linux.
- Any change to what DSHProxy does on Windows, with one addition that is the same on both systems: the new command `dshproxy backend update`.

Until a stage is done, what it covers says so on macOS: the command prints one sentence that it is not available on macOS yet, exits non-zero and changes nothing.

## Must stay unchanged

- On Windows: every file format, file location, message and existing command; both existing ways `master.key` and the Krea sign-in are protected with DPAPI, each left exactly as it is; which backend releases an update accepts; existing data folders work with no migration.
- Decision 0001: the backend is a pinned, unmodified CLIProxyAPI release, checked against its SHA-256 before it is run.
- The gateway listens on this computer only.
- No test that runs on Windows today is removed, skipped or weakened on Windows.
- The rules of the paid video path (decisions 0002 to 0008): one purchase per confirmed quote, nothing sent twice, the ceilings.

## Terms

- **Data folder**: `~/.dshproxy` (or `DSHPROXY_HOME`). Same on both systems.
- **Harness home**: `~/.dsh` (or `DSH_HOME`). Same on both systems; read in the Harness source.
- **Backend**: the CLIProxyAPI program DSHProxy downloads and runs.
- **Key wrapper**: what wraps and unwraps a file's key for the current user of the computer. On Windows it is DPAPI through PowerShell, written twice in two different ways (`src/secrets.js` passes the key in the child's environment; `src/krea-helper/oauth.js` passes it on standard input).

## What is Windows-only today

From a survey of the code (`research/facts.md`, sections 3 and 4):

1. The key wrapper. `src/secrets.js` has no way to supply another one.
2. The backend: the lock file names Windows downloads only; the program name ends in `.exe`; unpacking calls `tar.exe` in the Windows folder; a leftover backend is found through PowerShell; the updater knows Windows assets only and can be started only from the Windows app.
3. The Harness plugin install (`src/dsh/bundle.js`): registry, `cmd.exe`, `taskkill`.
4. Video: child processes are given environment variables that exist only on Windows; the Krea sign-in store insists on Windows.
5. Files are written without a mode. On Windows the user's folder protects them. On a Mac that leaves them readable by other accounts on the computer, and the Harness refuses to read a `.credentials.yaml` that others can read.
6. `package.json` allows Windows only; CI runs on Windows only; about ten test files assume Windows.
7. The app (`app/`, C#, about 8,000 lines) is Windows-only by nature. It reaches the gateway through the control API (`/dshproxy/control/`), which is not.

Everything else (the gateway, lanes, failover, limits, models, the profile writer, the control API, the logic of the video picker) has no Windows dependence that the survey found.

## Stage A: design

### 1. A key wrapper for macOS, chosen by system

The Keychain is the counterpart of what Windows does (DPAPI ties the key to the user's login), which is why it is chosen here and not a plain file.

- **Windows:** nothing moves. `loadMasterKey` in `src/secrets.js` keeps its DPAPI code as it is.
- **macOS:** `loadMasterKey` uses a new module, `src/keywrap-darwin.js`, with `protect(mode, bytes)`. It keeps one 32-byte key per user in a Keychain, as a generic password (service `DSHProxy`, account `key-wrapper`, the key written as 64 hex characters), created on first use. `Protect` and `Unprotect` are AES-256-GCM with that key, done in Node. `master.key` then holds the wrapped master key, as it holds a DPAPI blob on Windows.
- The Keychain is reached through `/usr/bin/security`, which is part of macOS. To write, DSHProxy starts `security -i` and sends the one command on its standard input, so the key is in no argument list and no environment. To read, `find-generic-password -w` prints it on standard output. Every call ends after 10 seconds, as the DPAPI calls do today.
- Which Keychain: the user's login Keychain, or the keychain file named in `DSHPROXY_KEYCHAIN`. Tests use a throwaway keychain file that they create and delete. No test reads, writes or deletes anything in a login Keychain.
- "No key yet" is exit code 44 of the read, and only that. Every other outcome of a read is "cannot be read": DSHProxy says so in one sentence, writes nothing, and does not create a second key.
- A locked Keychain: macOS puts up its own dialog asking for the Keychain password and `security` waits for it. DSHProxy ends the call after 10 seconds, says that the Keychain is locked, and writes nothing. The dialog can stay on the screen afterwards; it is macOS's. There is no way to see "locked" without waiting: the command that shows a keychain's settings waits for the same dialog. Not seen: what happens over SSH with nobody logged in at the screen.
- Two processes that both find no key at first use end with one key: the second write is refused (exit 45), and each uses what it then reads.

### 2. The backend for the Mac's processor

- `backend.lock.json` gains `darwin-arm64` and `darwin-x64` beside the two Windows entries (release 8.0.72 publishes both as `.tar.gz`; digests in `research/facts.md`).
- Unpacking uses the system's own `tar` on each system. On macOS the program is the file `cli-proxy-api` in the archive; DSHProxy marks it executable.
- A backend left by a gateway that died is recognised by its program path, read with `ps -o comm=` on macOS, both paths resolved with `realpath` and compared exactly, and ended only if it is DSHProxy's own copy. `ps` shows the path a program was started with; DSHProxy always starts the backend by its full path, so its own is recognised and anything else is left alone.
- **Updates.** An update needs the assets of the system it runs on, for both processors, and keeps the other system's entries when the release has them. On Windows that is exactly today's rule. A new command, `dshproxy backend update`, asks the running gateway to check for a newer release and apply it, through the control routes the Windows app already uses; it exists on both systems. `dshproxy backend rollback` works on macOS as on Windows.

### 3. Nothing DSHProxy writes on macOS is readable by other accounts

- On macOS each program under `bin/` sets its file-creation mask to `077` before it does anything else, so every file and folder it creates, temporary files included, is private from the first byte, and the backend it starts inherits that.
- At start the data folder is set to `0700`.
- `dshproxy dsh apply` sets the Harness's `.credentials.yaml` to `0600` every time, also when it has nothing to add to it. `dshproxy dsh verify` reports a `.credentials.yaml` that group or others can read, because the Harness will refuse it.
- Windows is untouched.

### 4. What is not available yet says so

Until stages B and C are done: on macOS, `dshproxy video ...`, `dshproxy dsh bundle ...` and the Krea helper each print one sentence, exit non-zero and change nothing; the gateway does not mount the video picker; `dshproxy dsh apply` writes no video route. Each sentence is removed by the stage that brings the function.

### 5. Packaging and checks

- `package.json` allows `darwin`.
- CI runs the whole suite on `windows-latest` and `macos-latest`.
- Tests of Windows-only code (the `cmd.exe` plugin install, DPAPI itself, `tar.exe`) run on Windows only and say why when they are skipped on macOS. Every such skip names the macOS test of the same behaviour, or the stage that will bring it.
- The README gets a macOS section: requirements, install, what is not there yet, and what protects which secret. Decision 0009 records the key wrapper on macOS and its cost.

## Stage A: acceptance criteria

Automatic, on a Mac and, where the same, on Windows:

- **C1.** `npm ci --ignore-scripts` and `node --test` succeed on macOS. On Windows `node --test` runs at least the tests it runs today (914) and all pass.
- **C2.** With an empty data folder on macOS, `dshproxy start` downloads the pinned backend for the machine's processor from the official release address, refuses it if its SHA-256 differs from the lock, unpacks it, starts it, and `GET /dshproxy/status` answers. `dshproxy stop --when-idle` ends the gateway and no backend process is left.
- **C3.** The shipped lock lists four assets, each under the official release address, each with the SHA-256 that the release's `checksums.txt` gives.
- **C4.** An update made on macOS from a release with all four assets writes a four-asset lock; from a release without a Windows asset it writes the two macOS ones; from a release without a macOS asset it is refused. On Windows, which releases are accepted is what it is today.
- **C5.** `dshproxy backend update` against a running gateway reports "up to date", or applies a newer release and the gateway answers on it afterwards; with no gateway running it says so and changes nothing. Tested with a stand-in for GitHub.
- **C6.** A leftover backend is ended on the next start only when its program path is DSHProxy's own; another program's process with the recorded id is left alone.
- **C7.** On macOS an API key saved with `dshproxy key set` is read back by a new process; `master.key` and `settings.json` do not contain it; the Keychain item is created once; a second process started at the same moment ends with the same key.
- **C8.** No secret is in the arguments or the environment of any process the macOS key wrapper starts. Shown twice: with a stand-in for `security` that records what it was given, and against the real program with a throwaway keychain.
- **C9.** When the Keychain cannot be read (a locked throwaway keychain; a `security` that does not answer for 10 seconds; no `security`), every command that needs the key ends with one sentence and a non-zero exit within 15 seconds, and the data folder and the keychain are byte for byte what they were.
- **C10.** After any DSHProxy command on macOS, the data folder is `0700` and nothing that command created or replaced, there or in the Harness home, has a group or others bit. After `dshproxy dsh apply`, `.credentials.yaml` is `0600`, also when it was `0644` and already held the reference. `dshproxy dsh verify` reports one that is `0644`.
- **C11.** `dshproxy dsh apply`, `verify`, `status` and `remove` produce the same profile text on macOS as on Windows for the same input (the existing profile tests, run on both).
- **C12.** On macOS, until stages B and C: `dshproxy video picker`, `dshproxy dsh bundle status`, `dshproxy dsh bundle install` and `dshproxy-krea status` each print the one sentence, exit non-zero and change nothing; a request to the gateway's video path is answered "not found".
- **C13.** On Windows, a data folder written by the current version is read by the new one, and the files the new one writes are read by the current one.

By hand, on the user's Mac (needs sign-ins):

- **M1.** Install as the README says; `dshproxy start` runs. Noted: whether macOS asks anything about the downloaded backend.
- **M2.** `dshproxy login` for one provider opens the provider's page and the account is listed afterwards.
- **M3.** `dshproxy dsh apply`, restart the Harness, pick a lane, get an answer.
- **M4.** In normal use no Keychain dialog appears. After the Mac is restarted and the user has logged in, `dshproxy start` works without one.

## Riskiest assumption of stage A, and what the proof showed

Assumption: `/usr/bin/security` gives a background Node process a store that is per user, asks nothing while the Keychain is unlocked, and takes the secret on standard input.

Proven before any production code, 23 Nov, with `spike/proof.js` on two GitHub Macs (runs 45221540307 and 45221963088; Apple Silicon on macOS 26.7 and Intel on macOS 15.7; details in `research/facts.md` section 5):

- Holds: a key sent on standard input to `security -i` is stored and read back; the argument list shows only `-i`; a second write is refused and nothing is overwritten; four processes at once ended with one key in 15 of 15 rounds on both machines; the machine's own default keychain was written and read with no prompt; "no key yet" (exit 44) is distinct from every other outcome.
- Did not hold as first written: a read of a locked keychain does not end with an error. It waits for a dialog, on a machine with nobody at it too, and has to be ended. Design 1 and C9 are written to that.
- The backend: both archives match their SHA-256, unpack with `/usr/bin/tar`, hold `cli-proxy-api`, start with the gateway's own configuration, answer on `/v1/models` in half a second, and end on SIGTERM. Both processors.

The proof can be repeated on any Mac: `node docs/work/0014-macos-port/spike/proof.js`. Off GitHub it touches only a keychain file it creates in the temporary folder.

## What the Keychain does and does not protect

- The backend reads its API keys from `backend-config.yaml`, which holds them in plain text, and keeps the provider sign-ins as plain files under `auth/`. That is so on Windows today and stays so. On macOS both are private to the user's account (design 3).
- So in stage A the key wrapper protects only the copy of the API keys in `settings.json`. A copy of the disk or of a backup that includes the data folder holds the API keys either way.
- From stage B on it protects what exists only in wrapped form: the video provider keys and the Krea sign-in.

## Stage B, outline: video

Criteria are written on the Mac first; the Windows tests of each part are the model.

- The Krea sign-in store: `~/Library/Application Support/DSHProxy/KreaOAuth/` (folder `0700`), wrapped by the macOS key wrapper through the `protect` option the store already has (`windowsStore({protect})`); the Windows store unchanged. Renewal as in decision 0007.
- The video picker's child and the Krea helper pass `HOME`, `TMPDIR` and `DSHPROXY_HOME` on macOS where they pass the Windows names today, plus the provider key on API routes. Nothing else.
- The video provider keys use `loadMasterKey`, which stage A has made work.
- To establish before building, because a purchase depends on them: (1) what `fsync` in Node does on macOS. The spec reviewer said it does not reach the disk; libuv's source is believed to ask for a full flush on macOS; neither was checked. Read `src/unix/fs.c` of the libuv version Node reports. (2) The purchase journal's rules about a file's creation time (`src/video/picker/store.js:298-305`). The proof saw that a file made again 60 ms after its deletion has a new creation time on a Mac; the journal's own tests have not been run there.
- By hand: a Krea sign-in, a quote, a rehearsal in the model picker with purchases off; then, on the user's word only, one real purchase.

## Stage C, outline: the plugin install

- First read, on the Mac, what could only be inferred from the Windows install (`research/facts.md` section 2): where the Harness application is, that its command launcher is `<application>/Contents/Resources/runtime/cli/bin/dsh` with a link at `/usr/local/bin/dsh`, and what its process is called in `ps`.
- Then `src/dsh/bundle.js` gets a macOS way for its three Windows parts: finding the Harness (the `DSHPROXY_HARNESS_DIR` override stays first), seeing that it is running, and running `dsh plugin --profile desktop add <folder>`. On macOS the launcher is started directly with its arguments as a list, so nothing passes through a shell; a run that takes too long is ended together with what it started.
- The plugin's own runner (`integrations/dsh-video/lib/config.js`) gets the macOS environment list and finds `node` on a Mac.
- The rule "not while the Harness is running" and the checks before and after the install stay as they are.

## Stage D, outline: the app

The Windows app has five pages (Accounts, API keys, Lanes, DeepSeek Harness, Log), keeps the gateway running in the tray when its window is closed, quits from the tray menu, and can start with Windows (README, "Windows app"). Everything it does to the gateway goes through the control API.

- First an inventory: every page, button, dialog and notification of the Windows app, from `app/DSHProxyApp.cs` and the README, as a checklist. "Exactly the same" is measured against it.
- Then a decision by the user, with a clickable prototype before any production code:
  - **A window drawn by the gateway as a local web page**, opened from a small menu-bar item, with a login item for starting at login. One interface for both systems later; the menu-bar item is the only native part. Recommended by the author of this document.
  - **A native Mac app** (Swift). Looks and behaves most like a Mac program; a second interface to keep in step with the Windows one, and a build that needs Xcode and, for other people's Macs, signing.
- Not known: whether the app must be signed and notarised for the user's purposes, and whether an Apple developer account exists.

## Rejected alternatives and risks

- **Key wrapper as a private file** (`0600`, no Keychain). Simpler and works with nobody logged in at the screen. Rejected: it is not what Windows does, and from stage B on the wrapper protects secrets that exist nowhere else in plain text. It stays the fallback if the Keychain proves unusable on the user's Mac.
- **Merging the two Windows DPAPI paths into one module.** Rejected: it rewrites working Windows code the port does not need to touch.
- **A mode on every file write.** Rejected for the file-creation mask: about a dozen places write files, and a write added later would miss it.
- **A native helper** (Swift, or a Node add-on) for the Keychain. Rejected: a compiled part to build, sign and ship for one read and one write.
- **Requiring all four assets for every update.** Rejected: a release without a macOS archive would stop reaching Windows users.
- **Risk: the user's Mac may object to the downloaded backend.** On GitHub's Macs it ran; nothing there marks a file downloaded by Node as coming from the internet. The Intel build is not signed at all, the Apple Silicon build only by the linker. Shows at M1.
- **Risk: a Keychain that is locked while the user is logged in** (a setting some people use) makes macOS ask for the login password whenever DSHProxy needs the key. Design 1 and C9 are the behaviour; the README says it.
- **Risk: tests split by system drift apart.** Kept small: only the key wrapper, unpacking, the process lookup, file modes, and later the child environments and the plugin install differ.
- **Risk: stage D is the largest part and the least known.** It is last, and starts with a decision.

## Decisions

1. Scope: the same functionality as on Windows. **Decided by the user, 23 Nov.**
2. Pushing the `macos-port` branch. **Decided by the user, 23 Nov: yes.**
3. Key wrapper: the Keychain. Not decided by the user in so many words; taken from "exactly the same as win" and from the proof having passed. Say so if a plain private file is preferred.
4. Stage D: web page or native app. **Open**, for the user, at the start of stage D.
