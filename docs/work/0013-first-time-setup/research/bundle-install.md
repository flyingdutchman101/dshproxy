# Installing the `@local/dshproxy-video` bundle into a Harness profile from outside a session

Read-only research, 2026-11-22. Nothing was changed on the machine except this file.

## Version examined and how

| Item | Value |
|---|---|
| Desktop app | `@deepseek-ai/dsh-desktop` 0.2.2-rc.3, build commit `6b729fedde0c8fd03af7afdf5a711aa64fe87c3b`, update channel `nightly` (`app.asar\package.json`) |
| CLI package | `@deepseek-ai/dsh` 0.2.2-rc.3 (`DSH_INSTALL_DIR\package.json`) |
| Plugin manager | `@deepseek-ai/dsh-plugin-manager` 0.2.2-rc.3 |
| Runtime | Electron 44.7.0, Node 24.21.0, bundled pnpm 11.28.5 (`resources\runtime\primary-runtime\runtime.json`) |
| Install location | `C:\Users\USER\AppData\Local\Programs\DeepSeek Harness` (also in `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\1bf39983-50d0-5fe0-9ef4-cece76f67c5e`, value `InstallLocation`) |

Path shorthand used below:

- `ASAR` = `C:\Users\USER\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
- `CLI` = `ASAR\dsh\node_modules\@deepseek-ai\dsh` (this is `DSH_INSTALL_DIR`; the CLI package is not directly at `ASAR\dsh\`)
- `PM` = `ASAR\dsh\node_modules\@deepseek-ai\dsh-plugin-manager`
- `AB` = `ASAR\dsh\node_modules\@deepseek-ai\dsh-app-boot`
- `HMR` = `ASAR\dsh\node_modules\@deepseek-ai\dsh-hmr`
- `DH` = `ASAR\dsh\node_modules\@deepseek-ai\dsh-desktop-host`
- `MAIN` = `ASAR\lib\main.js` (Electron main process, bundled JavaScript)
- `RES` = `C:\Users\USER\AppData\Local\Programs\DeepSeek Harness\resources` (ordinary folder, outside the archive)

What was executed: only read operations. The Electron executable was run as Node to list and search inside the archive, and the Desktop CLI carrier was run with `--version`, `--help` and `plugin --help` (all three print and exit 0 without touching a profile). No `plugin add` was run, so every statement about what the command-line route does to a profile comes from reading the source, not from observing a run. Statements about what `install_bundle` leaves behind are observed in profile `desktop`, where the bundle was installed that way earlier.

Not verified: the behaviour of `dsh plugin --profile desktop add` while Desktop is open; what pnpm does on a Windows machine without symbolic-link privilege (this machine has Developer Mode on); whether an absolute Windows path is accepted as a plugin `name` in a patch row.

---

## 1. Installing from outside a running session

### 1a. Command line: yes, and Desktop ships the command

Grammar (`CLI\src\args.ts:155`):

```
dsh [--profile] <name> [options] [app-args...]
dsh plugin --profile <name> <pnpm-args...>
```

`plugin` "manage[s] a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory" (`CLI\src\args.ts:188`). There is no `dsh bundle …`, `dsh plugin install-bundle …` or similar; the only DSH-owned sub-verbs are `version-exemptions`, `allow-version`, `revoke-version` (`CLI\src\plugin.ts:20`). Everything else is a pnpm verb, so installing a local folder is `add <dir>`. The documented example is `dsh plugin --profile demo add ./hello-plugin` (`CLI\docs\user\develop\basic\publish.md:82`), and `dsh plugin --profile sdk-minimal add file:C:/work/my-plugin-bundle` (`CLI\docs\user\guide\python-sdk.md:143`).

The executable on a machine with only Desktop installed is a five-line batch file, `RES\runtime\cli\bin\dsh.cmd`:

```
@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
```

So the exact call for our bundle is:

```
"C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "C:\Users\USER\Desktop\Development\DSHProxy\integrations\dsh-video"
```

Facts about this command:

- It is not on `PATH` by default. Desktop offers it through an application menu item, "Manage dsh Command…" (`MAIN:12873`), which adds `RES\runtime\cli\bin` to the per-user `PATH` (`RES\runtime\cli\command-manager.js:516-544`, `RES\runtime\cli\command-path.ps1:60-70`). On this machine it is not on `PATH` (`Get-Command dsh` finds nothing). The menu text also says "You can also run the Desktop command by its full path" (`MAIN:12878`).
- The profile name `desktop` is normally refused: `error: profile "desktop" is managed exclusively by the Electron application` (`CLI\src\args.ts:83-87`). The Desktop carrier lifts that for `plugin` only, by calling `runCli({ manageDesktopProfile: true, packageManager: … })` (`DH\lib\cli.js:57-70`; the check is `if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile)` at `CLI\src\args.ts:199`). Booting or dumping profile `desktop` from the command line stays refused (`CLI\src\args.ts:183`). The CLI README says the same: "The npm CLI also rejects its plugin-management requests; the Desktop-installed command can manage the initialized Desktop profile using that installation's runtime" (`CLI\README.md:20`).
- It uses the pnpm bundled with Desktop: command `DeepSeek Harness.exe`, arguments `--expose-internals RES\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs`, environment `ELECTRON_RUN_AS_NODE=1` (`DH\lib\cli.js:60-67`). No Node or pnpm has to be installed.
- Stated precondition for profile `desktop`: the profile must already exist and Desktop must be closed. The text is "Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop." (`CLI\src\plugin.ts:13`). The code enforces only the first half (it checks that `profiles\desktop\package.json` exists, `plugin.ts:11-15`, `72-77`); nothing checks whether Desktop is running. The command and the running app do share one writer lock (`package.json.lock`, see section 4).
- What it does for `desktop` (`CLI\src\plugin.ts:93-98`): takes the writer lock on `profiles\desktop\package.json`, then `runProfilePnpm(context, args, options)` with `execution: 'cli'`. That function (`PM\src\operations.ts:305-589`) reads `<dir>\package.json` and refuses an incompatible `engines.dsh` before pnpm starts (`:361-380`), runs `pnpm add <dir>` in the profile directory with the terminal inherited (`:386-393`), checks compatibility again after installation (`:496-542`), then selects the new bundle: `reconcile()` appends every newly added dependency that declares `dsh.bundle` to `dsh.profile.bundles` and saves the manifest (`:96-128`, called at `:566-567`).
- A dependency that was already in `package.json` before the run is not selected again (`if (beforeDeps.has(name)) continue`, `operations.ts:107`). So the command is safe to repeat, but it does not re-enable a bundle the user switched off.
- For any other profile name (`web`, a custom one) the same carrier works and also creates the profile on first use (`runPluginCommand`, `operations.ts:597-610`; "initialized on first use" in the help text).
- Exit codes: 0 on success; 1 with `dsh: plugin command failed; diagnostics: <log path>` on failure (`plugin.ts:103`); 127 when pnpm cannot be started (`plugin.ts:99`). The log is `profiles\<name>\.plugin-manager\logs\operation-XXXXXX\pnpm.log`.
- The Desktop README that the CLI README points to for this command (`../desktop/README.md#bundled-command-runtime`) is not in the archive, so the batch file's location is known from the installation itself, not from shipped documentation.

Observed: `dsh.cmd`'s underlying call with `--version` prints `0.2.2-rc.3` and exits 0; `plugin --help` prints the usage quoted above.

### 1b. HTTP endpoint of the running app: exists, but an outside program cannot authenticate

- The plugin manager's operations are remote methods of the Host (`@Remote installBundle`, `PM\src\index.ts:968-969`), used by the Plugins page. The only plain HTTP route the package documents is an image route, `GET /api/plugin-manager/detail-file?...` (`PM\README.md:112`).
- "Over the Web carrier, every Host RPC method and WebSocket stream requires an authenticated browser or API Peer; there is no method-specific loopback tier. Each process mints a random launch token." (`ASAR\dsh\node_modules\@deepseek-ai\dsh-client-connection\README.md:41`). API callers start with `GET /connect?token=...` (`:51`). "The HTTP carrier accepts query tokens only at the root exchange and `/connect`, and accepts no Authorization-header token" (`:41`).
- In Desktop the Host listens on `127.0.0.1` with `--port 0`, a random port (`DH\lib\index.js:364-369`), and hands the token-bearing URL to the Electron parent over process IPC only (`DH\lib\index.js:515-519`; the parent exchanges it for a cookie in `authenticateWebHost`, `MAIN:15298-15305`). The URL an agent shell sees, `DSH_WEB_URL`, has no token (checked: `http://127.0.0.1:60893`).
- The cookie signing secret is stored in `$DSH_HOME\.credentials.yaml` (`dsh-client-connection\README.md:43`). That file was not read, and forging a session from it is not a supported interface.

Conclusion: no supported HTTP route for an outside installer in Desktop.

### 1c. Deep link: only "focus the window"

`app.setAsDefaultProtocolClient("dsh")` and one handled URL: `if (url === "dsh://open" || url === "dsh://open/") focusPrimaryWindow();` (`MAIN:21634-21638`). The registry has `HKCU\Software\Classes\dsh\shell\open\command` = `"…\DeepSeek Harness.exe" "%1"`. No install link exists.

### 1d. Drop folder: not found

Bundles are loaded only from the names in the profile's `dsh.profile.bundles` (`AB\src\profile.ts:684-707`). No directory is scanned for bundles.

### 1e. Environment or configuration setting: no auto-install setting found; one related mechanism

- No setting that makes Harness install a bundle was found in the plugin manager's configuration table (`PM\README.md:87-103`) or in app-boot.
- `--patch <path>` adds a patch overlay at launch (`CLI\src\args.ts:170`), but Desktop starts its Host with `patchFiles: []` (`DH\lib\index.js:363`), so it is not available for the Desktop window.
- Related, and relevant because DSHProxy already writes `cordis.patch.yml`: a patch row can name a plugin by file path instead of by package. "Inserted plugin names may be absolute filesystem paths, file URLs, or package specifiers. Patch loading converts absolute paths and patch-relative `./` or `../` paths to file URLs within `insert` rows" (`AB\README.md:69`). Such a row loads the plugin module without any package installation, and the profile patch is watched for live reload (`HMR\src\index.ts:385`, `406`). It is not a bundle installation: the plugin would not appear as a bundle under Plugins, and "File paths and file URLs return no metadata" (`AB\README.md:91`), so no title, description or icon. Our `index.js` imports only `node:` modules and its own `./lib` files, so it has no package imports that would need the profile's resolution. Not verified with a Windows drive-letter path.

---

## 2. What `install_bundle` does for a local directory

Order of events, from `PM\src\tools.ts` and `PM\src\index.ts`, with what was observed in profile `desktop`.

1. Permission. The tool asks for `danger-full-access` or a per-call approval before anything else (`tools.ts:105-112`). Then `manager.installBundle(target, { enabled?, approvedBuilds?, registry? })` (`tools.ts:148-154`).
2. Writer lock. Every change runs inside `withFileLock(<profile>\package.json)` (`index.ts:1377`), a sibling file `package.json.lock` holding the process id, waited for up to `lockWaitMs` = 120000 ms (`PM\README.md:96`).
3. Spec checks. An empty spec or one starting with `-` is `invalid-spec` (`index.ts:978`). A local path "must be absolute" (`PM\src\install-spec.ts:74-78`); `file:` and `link:` prefixes are accepted; a path ending in `.tgz`/`.tar.gz` is a tarball, anything else is a directory.
4. Already installed. The package name is read from `<dir>\package.json` (`index.ts:263-280`). With live reload on, a name that is already a dependency fails with `already-installed` before pnpm runs (`index.ts:981-985`); the tool's advice is "call remove_bundle first, then install_bundle again" (`tools.ts:18`).
5. Build approval. Only when `approvedBuilds` is passed: the names are written as `allowBuilds: <name>: true` in the profile's `pnpm-workspace.yaml` (`PM\src\build-approval.ts:90-95`). Not applicable to a bundle without dependencies.
6. Snapshot. `package.json` and `pnpm-lock.yaml` are read so they can be put back (`RESTORED_FILES`, `index.ts:98`, `990`).
7. Network checks are skipped for a directory (`PM\src\github-connection.ts:41`, `PM\src\git-transport.ts:66-67`).
8. Package manager run: `runPnpm(['add', installSpec, …])` (`index.ts:1038-1041`). For a directory with default options the arguments are just `add <absolute dir>`; `--save-exact` and `--registry=<url>` are added only on request. Inside `runProfilePnpm` (`PM\src\operations.ts:305`):
   - a log file `.plugin-manager\logs\operation-XXXXXX\pnpm.log` is created (`:311-315`);
   - compatibility is checked from `<dir>\package.json` before pnpm starts; a refusal installs nothing (`:361-380`);
   - pnpm is started in the profile directory with a scrubbed environment, no stdin, captured output (`:336`, `:386-393`). In Desktop the command is `DeepSeek Harness.exe --expose-internals RES\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs add <dir>` with `ELECTRON_RUN_AS_NODE=1` (`DH\lib\index.js:371-379`, `MAIN:20202`). pnpm is bundled, version 11.28.5. Outside Desktop it is `pnpm` from `PATH` or the `pnpmCommand` setting (`PM\README.md:33`, `:89`);
   - `.plugin-manager\run.json` records the pnpm process while it runs and is removed afterwards (`:213-222`, `:446`, `:581`);
   - a run that prints nothing for `idleTimeoutMs` = 600000 ms is terminated (`PM\README.md:99`);
   - after a zero exit, every changed direct dependency is checked for compatibility again; a refusal restores both files and runs `pnpm install --frozen-lockfile` (`:496-565`).
9. What pnpm wrote (observed in `C:\Users\USER\.dsh\profiles\desktop`):
   - `package.json`: `"@local/dshproxy-video": "link:C:/Users/USER/Desktop/Development/DSHProxy/integrations/dsh-video"` under `dependencies`;
   - `pnpm-lock.yaml`: an importer entry with `specifier: link:C:/Users/USER/Desktop/Development/DSHProxy/integrations/dsh-video` and `version: link:../../../Desktop/Development/DSHProxy/integrations/dsh-video`;
   - `node_modules\@local\dshproxy-video`: a directory symbolic link with the relative target `..\..\..\..\..\Desktop\Development\DSHProxy\integrations\dsh-video` (`LinkType=SymbolicLink`). Nothing is copied. "Local directory installation links the checkout instead … `files` does not filter a linked directory" (`dsh-doc` skill, `references\host-plugin.md:36`);
   - `node_modules\.modules.yaml` (`"nodeLinker": "hoisted"`, `"packageManager": "pnpm@11.28.5"`) and `node_modules\.pnpm-workspace-state-v1.json`, pnpm's own state;
   - the log reads `+ @local/dshproxy-video 0.1.0 <- ..\..\..\Desktop\Development\DSHProxy\integrations\dsh-video`.
10. Bundle validation after pnpm (`index.ts:1073-1088`): exactly one dependency must have changed, otherwise `ambiguous-install`; the package must declare `dsh.bundle.patch`, otherwise `not-bundle`; `engines.dsh` (or, without it, the `@deepseek-ai/dsh*` peer ranges) must accept the running version, otherwise `incompatible-version`; every patch file must parse. Any failure up to here puts `package.json` and `pnpm-lock.yaml` back (`index.ts:1091-1095`); downloaded files may stay.
11. Selection (`index.ts:1102-1109`, `selectBundle` at `:1270-1291`): platform declaration checked, compatibility checked, rows composed, then the name is appended to `dsh.profile.bundles` and the manifest saved atomically as 2-space JSON with a trailing newline (`PM\src\operations.ts:91-93`). `enabled: false` skips the selection.
12. Application to the running app (`index.ts:1339-1359`): with live reload, `hmr.reconcileProfile(requiredIds)` recomposes the profile and the result says `application: 'applied'`; without it the result says `restart-required` with reason `no-hmr` (`index.ts:1381`). The shipped `web` template, which Desktop uses for its profile (`MAIN:11453`, `11538`), has live reload on (`AB\README.md:52`). "Installing a new bundle can activate through HMR; replacing an installed package requires restart to load a fresh JavaScript module generation" (`references\host-plugin.md:75`).

Not written by an installation: the profile's `cordis.patch.yml` (only switching a single plugin row on or off writes there, `PM\README.md:40`) and `compatibility.json` (only version exemptions, `PM\README.md:79`).

Manifest fields that matter: `name`; `dsh.bundle.patch` as one path or a list of paths (`AB\src\profile.ts:54-60`); optional `dsh.bundle.platforms`; optional `engines.dsh`. Our bundle declares no `engines.dsh` and no peers, which "imposes no constraint" (`AB\README.md:54`).

Build scripts: pnpm 11 blocks dependency scripts; a blocked run reports `pendingBuilds`, and `approvedBuilds` grants them per profile (`PM\README.md:72`). Not relevant to a bundle with no dependencies and no scripts that pnpm would run for a link.

---

## 3. Start-up with a missing package, and a link whose folder is gone

Harness does not install anything at start-up.

- Desktop's start-up step is described as "Load application metadata and prepare the external plugin profile without installing packages" (`MAIN:11490-11499`); it only creates missing profile files.
- Loading the profile (`loadProfileDirectory`, `AB\src\profile.ts:678-713`) resolves each name in `dsh.profile.bundles` "installation anchor first, then the profile directory" (`:651-662`). A name that resolves nowhere throws `dsh: cannot resolve profile bundle "<name>" from the dsh installation or <profileDir>; run 'dsh plugin --profile <name> install' if its dependency is not installed`, and the loop catches it: `skippedBundles.push({ packageName, reason: String(error) })` (`:704-706`).
- The launcher then prints one line per skip to stderr: `dsh: skipping profile bundle "<name>": <reason>` (`reportSkippedBundles`, `AB\src\profile.ts:114-118`; called by the Desktop Host at `DH\lib\index.js:354-355` and by the CLI at `CLI\src\profile-boot.ts:196-197`).
- "Bundle resolution, manifest, and patch-loading failures skip that bundle without changing its selection … Remaining bundles keep their order; profile and user-patch errors still fail startup" (`AB\README.md:52`). So the app starts, our tools are simply absent, and the manifest is left as it was.
- A dependency listed under `dependencies` but not under `dsh.profile.bundles` and missing on disk has no effect at start-up ("A declared-but-uninstalled dependency cannot be a loader-visible plugin; skip it rather than fail the whole boot", `AB\src\profile.ts:351-353`).

Link target gone (DSHProxy folder moved or deleted): the same path. Resolution tests `existsSync(<candidate>\package.json)` (`AB\src\profile.ts:632-635`), which is false through a dangling link, so the bundle is skipped as above. The linked-folder scan ignores it too: "A dangling link is not a package Node can load from the profile" (`AB\src\profile.ts:274-282`).

What the user sees: the stderr line is not shown in the Desktop window. In Plugins, "A selected bundle that cannot load remains in `listBundles` with an `error` and no row carrying an `entryId`; `enabled` records the saved selection, not successful loading. The plugin page marks it as not running and allows deselection" (`PM\README.md:44`). "Inactive dependencies with missing files remain removable" (`PM\README.md:180`).

Repair after a move: the old entry has to be removed first. With live reload an install of a name that is already a dependency is refused as `already-installed` (`PM\src\index.ts:981-985`), and "Moving a profile package needs its removal first" (`AB\README.md:205`).

---

## 4. Hand-editing the profile, and integrity records

Documentation that tells people not to do it:

- "You never write a profile manifest by hand: … `dsh plugin` creates a base-backed profile and maintains its installed bundle list." (`CLI\docs\user\develop\basic\publish.md:75`)
- "Manage the current profile's plugins without editing configuration by hand." (`PM\README.md:14`)
- For agents: "Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the profile directory: `install_bundle` performs those steps" (`references\plugin-development.md:5`) and "do not reproduce those steps with shell commands" (`references\host-plugin.md:73`).
- Profile `desktop` "is reserved for the Electron-owned profile" (`CLI\README.md:20`).
- Consequences that are documented: "A package relinked outside Plugin Manager while it is still installed waits for a restart" (`PM\README.md:177`); "an install performed outside Plugin Manager takes effect at the next recomposition or restart" (`HMR\README.md:118`); compatibility checks are skipped for "packages changed outside it, such as a manual `pnpm add` in the profile directory" (`HMR\README.md:114`).

The profile's own `cordis.patch.yml` is different: it is described as the user's layer ("your tweak layer", `AB\README.md:65`) and is meant to be edited.

Integrity records: none found. There is no hash, signature or manifest of installed bundles.

- `.plugin-manager\` holds only `logs\operation-XXXXXX\pnpm.log` (diagnostics) and, during a run, `run.json` (the pnpm process id, `PM\src\operations.ts:213-222`). On this machine it contains three log folders and nothing else.
- What a hand edit can violate is consistency, not integrity:
  - the writer lock. Manager and CLI serialize on `<profile>\package.json.lock` and replace `package.json` by atomic rename (`PM\src\index.ts:1377`, `PM\src\operations.ts:91-93`; lock protocol in `RES\runtime\cli\command-manager.js:193-222`). An editor that ignores the lock can lose its change to a concurrent read-modify-write, or overwrite the manager's;
  - `pnpm-lock.yaml`. It records `specifier` and `version` for each `link:` dependency. The manager's rollback path runs `pnpm install --frozen-lockfile` (`PM\src\operations.ts:549-557`), which needs manifest and lockfile to agree;
  - `node_modules`. "the next package operation prunes packages no manifest references" (`PM\README.md:198`), so a hand-made link without a matching dependency would be removed by the next pnpm run;
  - the running app. It watches `package.json` and recomposes when `dsh.profile.bundles` changes (`HMR\src\index.ts:384-407`; a change to `dependencies` alone does nothing, `:390`), so a hand edit of a running profile takes effect about two seconds later (`awaitWriteFinish`, `HMR\README.md:47`) whether or not the package is present yet.

---

## 5. Profiles

- Shipped templates: `acp`, `web`, `headless`, `sdk`, `sdk-minimal` (`ASAR\dsh\node_modules\@deepseek-ai\dsh-official-bundles\src\bundles.ts:10-24`). They "auto-initialize on first use" (`CLI\README.md:20`). `web` = `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`.
- `desktop` is not a template name. It is created by the Desktop app with the `web` bundle list (`MAIN:11453`, `11536-11539`) at `<DSH_HOME>\profiles\desktop` (`MAIN:7612-7616`) and is reserved for it.
- A profile is a directory `$DSH_HOME\profiles\<name>` with its own `package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml` and `node_modules` (`AB\src\profile.ts:5-14`, `198-217`). Bundles are therefore per profile. "The manager cannot disable its own management components, change another profile, or edit an agent preset's composition" (`PM\README.md:179`).
- Installing in `desktop` does not affect `web`. On this machine `profiles\web\package.json` has `"dependencies": {}` and only the two template bundles, and `profiles\web` has no `node_modules`.
- Shared between profiles: only the home-level patch `$DSH_HOME\cordis.patch.yml`, which applies to every profile after the profile's own patch (`AB\README.md:65`, `CLI\README.md:41-44`). It does not exist on this machine.
- On this machine only `desktop` and `web` exist under `C:\Users\USER\.dsh\profiles`.

---

## 6. Opening the window at Plugins > Add plugin from outside

Not found. Evidence:

- Command line of the Desktop executable: a second launch only focuses the existing window; its arguments are not read (`claimDesktopSingleInstance`, `MAIN:14459-14465`; the handler is `() => { focusPrimaryWindow(); }`, `MAIN:21771-21773`). The only argument the main process tests is `--updated` (`MAIN:20403`).
- Deep link: `dsh://open` focuses the window and nothing else (`MAIN:21634-21638`).
- Route: the window loads `dsh-app://app/` (`MAIN:1478`, `20470`), a private scheme of the app. The Plugins page is a panel with the id `plugins` (`ASAR\dsh\node_modules\@deepseek-ai\dsh-client-ui-plugin-manager\src\client\index.ts:83`), selected in memory by `ctx.layout.selectPanel(PANEL_ID)` (`:153-163`). A search for `location.hash`, `location.search`, `pushState`, `replaceState`, `hashchange`, `popstate` in the `src` folders and READMEs of `dsh-client-ui-layout`, `-ui-sidebar`, `-ui-session`, `-ui-workspace`, `dsh-web-frontend`, `dsh-client-modules`, `dsh-web-app` and `dsh-host-frontend-static` found nothing, so no URL selects a panel. The search covered those packages only.
- The local HTTP address is a random port and needs the session cookie (section 1b).

What an outside program can do: start or focus Harness (start `DeepSeek Harness.exe`, or open `dsh://open`) and tell the person to choose Plugins > Add plugin. The dialog "takes a package name with an optional version, a Git address, a tarball, or an absolute local path" (`dsh-client-ui-plugin-manager\README.md:65`), so putting the folder path on the clipboard is enough.

---

## 7. Detecting the bundle read-only

All from files; no Harness process is needed. `<home>` is `%DSH_HOME%` when set, otherwise `%USERPROFILE%\.dsh`.

| Question | File and field | Source of the rule |
|---|---|---|
| Installed (declared) | `<home>\profiles\<profile>\package.json`, key `@local/dshproxy-video` under `dependencies` (the manager also counts `devDependencies` and `optionalDependencies`) | `PM\src\index.ts:512-520`, `PM\src\operations.ts:258-261` |
| From which folder | the value, `link:<path>`; a relative path is relative to the profile directory, `~` is the home directory | `PM\src\install-spec.ts:147-159` |
| Selected (bundle switched on) | same file, `dsh.profile.bundles` contains `@local/dshproxy-video` | `PM\src\index.ts:251-253`, `:522` |
| Present on disk | `<home>\profiles\<profile>\node_modules\@local\dshproxy-video\package.json` can be read through the link and declares `dsh.bundle.patch` | `AB\src\profile.ts:629-662`, `PM\src\operations.ts:81-85` |
| Version | `version` in that same linked `package.json` (currently `0.1.0`); because it is a link, this is the version of the DSHProxy folder itself | `PM\src\index.ts:554`, `:562` |
| Plugin row not switched off | no entry `id: dshproxy-video` with `disabled: true` in `<home>\profiles\<profile>\cordis.patch.yml` or in `<home>\cordis.patch.yml` | `PM\README.md:40` |

Current state on this machine: `desktop` has the dependency, the selection (seventh of nine bundles) and a working link; no patch file mentions `dshproxy-video`; `web` has none of it.

Limits: these files say what is saved, not what is running. A skipped bundle is reported only on the Host's stderr and through `list_bundles` (`error` field); no file records it. `pnpm-lock.yaml` and the log files repeat the link target and version but are not what Harness reads.

---

## Options for a first-time setup button

| Option | Supported by Harness | Works with Desktop open | Main drawback |
|---|---|---|---|
| A. Run the Desktop-shipped `dsh.cmd plugin --profile desktop add <dir>` | Yes, this is the documented outside route; the same code and lock as the manager | Stated requirement is "fully quit" first; by source the running app would pick up the new selection through its manifest watch, but this was not run | Location of `dsh.cmd` is an installation detail of a release-candidate build; needs the profile to exist already |
| B. Focus Harness and guide the person to Plugins > Add plugin with the path on the clipboard | Yes | Yes | Not automatic |
| C. Write `package.json`, the lockfile and the link ourselves | No, documented as not to be done | Would be picked up live, without the manager's checks | Races with the manager's lock; rollback path depends on a consistent lockfile; symbolic-link creation needs privilege |
| D. Add an `insert` row with the absolute path of `index.js` to `cordis.patch.yml`, which DSHProxy already writes | Yes as a patch feature, but it is not a bundle installation | Yes, the patch file is watched | No entry under Plugins, no title or icon; Windows path form not verified |

Recommended: A, run only while Desktop is closed (or followed by asking for a restart), then confirm with the checks in section 7; fall back to B when `dsh.cmd` is missing, the profile does not exist yet, or the command exits non-zero. In every case the result is a link, so moving or deleting the DSHProxy folder leaves a selected bundle that Harness skips at start-up until it is removed and added again.
