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
