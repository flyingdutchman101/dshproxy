# Facts for the macOS port

Gathered 2026-11-23, read-only. Line numbers are of `main` at `8efe918`.

## 1. CLIProxyAPI release 8.0.72 (GitHub API, release `v8.0.72`)

| Asset | SHA-256 (GitHub `digest`) |
|---|---|
| `CLIProxyAPI_8.0.72_darwin_aarch64.tar.gz` | `ae008afd4ad52603f220200afc6417102591ba0a847d128cb65e904f86ac7918` |
| `CLIProxyAPI_8.0.72_darwin_amd64.tar.gz` | `27591f4c829cd3a2ce9daed541328103f6439841d25aefca82207d79126a90af` |
| `CLIProxyAPI_8.0.72_windows_amd64.zip` | `9c98651a4a35e05fd87193bf722710f32ff87d13ff8b7177d0cfd200f4b51749` (as in the lock) |
| `CLIProxyAPI_8.0.72_windows_aarch64.zip` | `07666c498620f3f2825c30e9ff1b1b3b10abe6d00a998c9f8b59d437ed9bf225` (as in the lock) |

Also published: `checksums.txt`, Linux and FreeBSD archives. Not known: the name of the program inside the macOS archive, and whether it starts on a Mac.

## 2. DeepSeek Harness on macOS (installed 0.2.2-rc.5, a Windows build, sources read in the ASAR)

- The desktop shell allows `win32` and `darwin`, `x64` and `arm64` (`lib/main.js:21721`). The installed payload itself is Windows x64.
- Home: `DSH_HOME`, else `~/.dsh`, no branch per system (`lib/main.js:7558-7603`). Profiles `~/.dsh/profiles/<name>/cordis.patch.yml`; credentials `~/.dsh/.credentials.yaml`.
- `.credentials.yaml` on POSIX: the Harness creates it `0600` and **refuses to read it when group or others have any bit** (`dsh-credentials-local/lib/index.js:63-64, 80-104`). No Keychain is used by the Harness.
- Command line on macOS: `/usr/local/bin/dsh`, a link to `<Resources>/runtime/cli/bin/dsh` (`runtime/cli/command-manager.js:505-511`). Inferred; those files are not in the Windows payload.
- Plugin install is `dsh plugin --profile <name> <pnpm args>` on every system.
- Not readable from this install: the Mac application's bundle layout, the name of its program file, its bundle id.

## 3. Windows-only code in DSHProxy

**Key wrapper**
- `src/secrets.js:39-97`: DPAPI through `powershell.exe`; no injection point. Callers: `src/app.js:71,91,107,129` (direct), `src/video/keys.js:154,176,204` and `src/video/command.js:53` (injectable `loadMasterKey`).
- `src/krea-helper/oauth.js:85-97` (`dpapi`), `:123-157` (`windowsStore({protect, lockWaitMs})`): requires `win32` and `LOCALAPPDATA`.
- `bin/dshproxy-krea.js:12`: `main({makeStore, ...})` injectable. Off Windows the store throws and `status` prints `{"signedIn":false}`.

**Backend**
- `backend.lock.json`: `assets` keyed `win32-x64`, `win32-arm64`.
- `src/backend/install.js:11` `BINARY = "cli-proxy-api.exe"`; `:13` `assetFor(lock, platform, arch)`; `:36-44` unpack with `%SystemRoot%\System32\tar.exe`; no executable bit set; `:59` `install(lock, binDir, {download})`.
- `src/backend/updater.js:14` `ASSET_KEYS` Windows only; `:42-58` `lockFromRelease` needs both Windows zips.
- `src/backend/supervisor.js:43-50` `windowsProcessPath` (PowerShell); `:59-75` `reclaimOrphan({processPath, kill})`; `:52` paths compared lower-cased; `createSupervisor` does not pass the two through.

**Harness integration**
- `src/dsh/profile.js`: portable. Writes `.credentials.yaml` with no mode (`:208-227`).
- `src/dsh/bundle.js`: registry (`:63-71`), `dsh.cmd` (`:22`), process list through PowerShell (`:94-118`), `cmd.exe` and `taskkill` (`:301-356`). Seams: `locateHarness({env, registry})`, `deps.processes`, `deps.run`.

**Starting and stopping**
- No pid file for the gateway; `stop --when-idle` uses `settings.json`, `GET /dshproxy/status`, `control.token` and `POST /dshproxy/control/stop` (`src/cli.js:399-449`). `SIGINT` and `SIGTERM` handlers exist (`src/cli.js:392-396`).
- Start at login, the tray and the window are the C# app only.

**Child environments**
- `src/video/picker/child.js:50`: `SystemRoot, LOCALAPPDATA, APPDATA, TEMP, TMP, USERPROFILE, DSHPROXY_HOME`.
- `src/video/workspace.js:45`: `SystemRoot, LOCALAPPDATA, TEMP, TMP, USERPROFILE`.
- `integrations/dsh-video/lib/config.js:10`: the same five plus `DSHPROXY_HOME`; `findNode` looks for `node.exe` or `node`.

**Files and modes**
- Explicit modes only at `src/control.js:21` and `src/krea-helper/oauth.js:137` (`0o600`). Everything else takes the default.
- `backend-config.yaml` holds API keys and the management key in plain text (`src/backend/config.js:41,57`).
- `src/filelock.js`: portable; its retries on `EPERM`/`EBUSY`/`EACCES` are for Windows and do nothing on POSIX.
- `src/video/picker/store.js:298-305` relies on `birthtimeMs`; a comment says what Windows does for a recreated file. Behaviour on APFS not checked.

**Packaging and tests**
- `package.json`: `"os": ["win32"]`. CI: `windows-latest`, Node 22 and 24.
- 52 test files under `test/`, 3 under `integrations/dsh-video/test/`.
- Would fail on macOS as they are: `test/backend.test.js:103-135, 238-294` (`tar.exe`, real DPAPI); `test/dsh-bundle.test.js` (batch file stand-in, `cmd.exe`, `taskkill`); `test/profile.test.js:535-549` (expects a read-only file to refuse a rename); `test/krea-oauth.test.js:136-146`; `test/video-command.test.js:356-388` and `test/video-concurrency.test.js:341-352` (real DPAPI through the CLI); `test/krea-renewal-process.test.js` (the store refuses off Windows).
- Windows fixtures that are only strings: `test/updater.test.js`, `test/video-picker-child.test.js:620-682`.

## 4. Not known

- Whether `security` takes a secret on standard input from a process with no terminal, and whether the CI Mac's login Keychain is unlocked.
- Whether `os.homedir()` is right in a child that is not given `HOME` (not relied on: `HOME` is passed).
- What the C# app calls beyond the control API routes in `src/daemon.js:302-467`.

## 5. Proof on two GitHub Macs, 23 Nov

`spike/proof.js`, runs 45221540307 (commit `5682a61`) and 45221963088 (commit `d472bff`). Machines: `macos-latest` (arm64, macOS 26.7.2, Node 22.23.5) and `macos-15-intel` (x64, macOS 15.7.9, Node 22.23.2). Same results on both unless said.

**Keychain through `/usr/bin/security`**
- Default keychain `~/Library/Keychains/login.keychain-db`; search list is that and the System keychain.
- Absent item: exit 44 in about 25 ms. A keychain file that does not exist: also 44.
- Write with `security -i`, the command on standard input: exit 0, nothing printed. Read with `find-generic-password -w`: the value and a line break on standard output.
- Second write: exit 45 ("already exists"), also through `-i`, where the exit code is that of the command. The first value stays.
- `ps` shows `/usr/bin/security -i` while the command is in progress; the value sent is in neither the arguments nor the environment.
- A read works with an empty environment.
- Four processes at once, no item: one write succeeds, three get 45, all four read the same value. 15 of 15 rounds.
- A keychain path with a space works in the command on standard input when put in double quotes.
- The default keychain, no keychain named: written, read and removed with no prompt.
- **Locked keychain:** a read of the value does not end; ended after 10 s. A write does not end either. `show-keychain-info` does not end (ended after 5 s). Afterwards a `SecurityAgent` process is running, which was not there before: a dialog was put up. Reading the item's attributes without the value works at once (exit 0). `unlock-keychain` with no password and an empty standard input: exit 51 at once. After unlocking, the value is what it was.

**Backend 8.0.72**
- Both archives match the SHA-256 of the GitHub API and of `checksums.txt`.
- `/usr/bin/tar -xzf` unpacks: `LICENSE`, `README.md`, `README_CN.md`, `cli-proxy-api` (mode 755), `config.example.yaml`.
- arm64: ad-hoc signature by the linker. x64: not signed at all. No extended attributes after a download by Node.
- `-h` exits 0. Started with `-config` and the configuration `src/backend/config.js` renders: HTTP 200 on `/v1/models` after 0.5 s.
- `ps -o comm= -p PID` gives the full path for the backend, which was started by its full path. For the Node process, started as `node`, it gives `node`: it is the path a program was started with.
- SIGTERM: exit code 0 after 0.1 s; the port is closed afterwards.

**Files**
- The mask at start is 022. With 077: new file 600, new folder 700, a child process has 0077 and creates 600.
- A 644 file replaced by renaming a new file over it is 600 afterwards.
- Renaming over a read-only (444) file succeeds. `test/profile.test.js:535-549` expects a refusal; that is Windows behaviour.
- A file deleted and made again 60 ms later has a new creation time (for Release B).
- `os.homedir()` is right in a child that is given no `HOME`.

## 6. The proof and the tests on the user's Mac, 23 Nov

Machine: Apple Silicon (arm64), macOS 26.6.2 (25G83), Node 24.19.0, libuv 1.52.1. A user logged in at the screen. Proof output kept out of the repository (it names temporary paths only).

**Proof: 17 passed, 1 failed (K7, "after unlocking, the key is what it was").** Everything else as on GitHub's Macs.
- Locked keychain: the read was ended after 10 s, the write too, `show-keychain-info` after 5 s; afterwards a `SecurityAgent` process was running (a dialog on the user's screen). Then `unlock-keychain -p` and a read of the same throwaway keychain **also waited 10 s and was ended.** On GitHub's Macs that read answered. So on a Mac with someone at the screen, a pending Keychain dialog blocks later calls on that keychain until the dialog is answered; unlocking with the password from a program does not clear it. The `SecurityAgent` process was still running after the proof ended and its keychain had been deleted.
- Consequence for the tests: a test that locks a throwaway keychain puts a dialog on the developer's screen and can make the keychain tests that follow it wait. To be settled in the plan review (A1).
- The downloaded archive carries the extended attribute `com.apple.provenance` (empty), which GitHub's Macs did not show. Not `com.apple.quarantine`. The backend started and answered all the same (B4, 0.5 s).
- The proof's `create-keychain` did not leave the throwaway keychain in the search list (`login.keychain-db` and `System.keychain` only, afterwards).

**Tests (`node --test`, before any change, `npm ci --ignore-scripts --force`):** 914 tests, 877 pass, 35 fail, 2 skipped (two existing `skip` on non-Windows in `integrations/dsh-video/test/dsh-video.test.mjs`). `node scripts/check.js`: 104 files OK. Failing, by cause:

| Cause | Tests | Slice |
|---|---|---|
| Key wrapper: "Windows could not protect a new key" (PowerShell absent) | `backend.test.js` 238, 255, 270, 286; `cli.test.js` 25, 49; `video-command.test.js` 356; `video-concurrency.test.js` 341, 346; `video-picker-callers.test.js` 81 | A1 |
| Unpacking: `spawnSync C:\Windows/System32/tar.exe ENOENT` | `backend.test.js` 114, 125, 134, 145 | A3 |
| Rename over a read-only file succeeds on a Mac | `profile.test.js` 535 | A2 |
| Harness plugin install: process list, `cmd.exe`, batch stand-in | `dsh-bundle.test.js` 322, 497, 543, 574, 589, 601, 614, 631, 673, 693, 738, 778 | A5 (skip naming stage C), C |
| Krea store refuses off Windows (`KREA_REFUSED`) and `status` prints `{"signedIn":false}` without `canRenew` | `krea-oauth.test.js` 128; `krea-renewal-process.test.js` 83, 98, 116, 137, 158, 170 | A5 (skip naming stage B), B |
| macOS adds `__CF_USER_TEXT_ENCODING` to the environment of the plugin runner's child (Windows has its own allowance, `ADDED_BY_NODE_ON_WINDOWS`) | `integrations/dsh-video/test/dsh-video.test.mjs` 151 | not forecast; A5 or C |

Compared with the forecast (section 3): `cli.test.js` and `video-picker-callers.test.js` fail through the key wrapper as well; the plugin runner's environment test was not forecast.

## 7. DeepSeek Harness on the user's Mac, 23 Nov (read only, for stage C)

- Application: `/Applications/DeepSeek Harness.app`; bundle id `com.deepseek.dsh`; program `Contents/MacOS/DeepSeek Harness`; **version 0.2.2-rc.1** (the Windows computer has 0.2.2-rc.5; decision 0008 was read in rc.5).
- In `ps -axo comm=` while it runs: `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness` (twice), and `.../Contents/Frameworks/DeepSeek Harness Helper.app/...`, `DeepSeek Harness Helper (Renderer).app/...`.
- The command launcher exists: `Contents/Resources/runtime/cli/bin/dsh`, a POSIX `sh` script that follows its own links and runs `ELECTRON_RUN_AS_NODE=1 "<Resources>/../MacOS/DeepSeek Harness" --expose-internals "<Resources>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" "$@"`.
- **There is no `/usr/local/bin/dsh`** on this Mac (and no `dsh` on the `PATH`). The link the facts inferred is made only when the user installs the command line from the Harness, so DSHProxy cannot count on it.
- `Contents/Resources/runtime/versions.json`: Node 24.21.0, pnpm 11.28.5; `runtime/bin/` holds `node`.
- Harness home `~/.dsh` with `profiles/desktop`, `profiles/headless`, `profiles/web`. `~/.dsh/.credentials.yaml` is `-rw-------`.
- No `~/.dshproxy` on this Mac yet.
