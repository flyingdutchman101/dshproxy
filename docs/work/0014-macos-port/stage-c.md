# Stage C — the video tools plugin on macOS: criteria and plan

Status: written on the Mac on 23 Nov; built the same evening after the user's "go" (C1 to C4). Not reviewed yet. Facts: `research/facts.md` section 7 (the Harness on this Mac, read 23 Nov); the code: `src/dsh/bundle.js`, `integrations/dsh-video/`.

## What works afterwards

`dshproxy dsh bundle status` and `dshproxy dsh bundle install` on macOS as on Windows: find the Harness, refuse while it runs, run the Harness's own `dsh plugin --profile desktop add <folder>`, check the profile before and after, keep a log. The plugin's runner, inside the Harness, starts DSHProxy's video commands with the macOS environment and finds `node` on a Mac.

## What is Windows-only today, and what changes on macOS

| Part | Windows today | macOS |
|---|---|---|
| Finding the Harness | `DSHPROXY_HARNESS_DIR`, then `%LOCALAPPDATA%\Programs\DeepSeek Harness`, then the `dsh:` URL handler in the registry | `DSHPROXY_HARNESS_DIR` (a `.app` folder), then `/Applications/DeepSeek Harness.app`, then `~/Applications/DeepSeek Harness.app`. Each must hold `Contents/MacOS/DeepSeek Harness` and the launcher |
| The command | `<dir>\resources\runtime\cli\bin\dsh.cmd`, run through `cmd.exe` | `<app>/Contents/Resources/runtime/cli/bin/dsh` (a `sh` script inside the application; seen on this Mac). Started directly with its arguments as a list: no shell of DSHProxy's, no `/usr/local/bin/dsh` (not there on this Mac) |
| Is it running | PowerShell lists `DeepSeek Harness.exe` and its path | `/bin/ps -ww -axo comm=`: a process whose program is `<app>/Contents/MacOS/DeepSeek Harness` (seen in `ps` on this Mac), paths compared with `realpath` |
| A run that takes too long | `taskkill /T /F` | the command is started in its own process group and the group is ended (`SIGTERM`, then `SIGKILL`) |
| Characters refused in a folder name | those `cmd.exe` would read (`% " ^ & | < > !`), a line break, a trailing backslash | the same set (decided while building: one rule on both systems; nothing passes through a shell on macOS, so the refusal is caution, not need) |
| The runner's environment (`integrations/dsh-video/lib/config.js`) | `SystemRoot, LOCALAPPDATA, TEMP, TMP, USERPROFILE` (+ `DSHPROXY_HOME`) | `HOME, TMPDIR, DSHPROXY_KEYCHAIN` (+ `DSHPROXY_HOME`); macOS adds `__CF_USER_TEXT_ENCODING` to every process, which the tests allow as they allow Windows' additions |
| Finding `node` for the runner | `PATH`, then `%ProgramFiles%\nodejs` | `PATH`, then `/opt/homebrew/bin` and `/usr/local/bin`: an application started from the Dock gets a short `PATH` without Homebrew |

## Acceptance criteria

Automatic, on a Mac and in CI:

- **CC1.** Every test of `test/dsh-bundle.test.js` that runs on Windows has a macOS counterpart that runs on macOS against a stand-in Harness application (a folder with `Contents/MacOS/DeepSeek Harness` and a launcher script that records its arguments and environment), and passes: locate, running or not, install once and a second time changes nothing, refuses while running, a failing command, a command that changes nothing, a relinked plugin, a command that hangs is ended with its children, the result after a time limit, `--json` contracts, the help.
- **CC2.** The command is started with exactly `plugin --profile desktop add <folder>` as its arguments, no shell, and the environment the Windows install gives it, in macOS names.
- **CC3.** The runner gives the video commands only the macOS list of variables (and `DSHPROXY_HOME`), and finds `node` in `PATH` or the two Homebrew folders; `integrations/dsh-video/test/dsh-video.test.mjs` passes on macOS with no skip.
- **CC4.** `test/not-yet-darwin.test.js` and `src/not-yet.js` are gone.
- **CC5.** Windows: unchanged, as for stages A and B.

By hand (needs the user): **CM1.** With the Harness quit, `dshproxy dsh bundle install` installs the plugin into the user's Harness; the Harness shows it under Plugins after a start; `dshproxy dsh bundle status` says installed. This changes the user's Harness profile, so it waits for the user's word.

## Plan

- **C1 — find the Harness and see it running.** `src/dsh/bundle.js`: `locateHarness`, `harnessProcesses`/`harnessRunning` by system; tests with stand-in applications and `ps` through the existing `deps.processes` seam.
- **C2 — run the command.** `runCommand` by system: direct start, process group, the same time limit and log; `childEnv` by system. Tests with a stand-in launcher that records, fails, changes nothing, hangs with a child.
- **C3 — the runner.** `integrations/dsh-video/lib/config.js`: environment and `findNode` by system; the integration test's allowance for macOS.
- **C4 — the gate goes; review; the check by hand.** `src/not-yet.js` and its test removed; one independent review; CM1 with the user.

## Not known

- Whether the Harness 0.2.2-rc.1 on this Mac accepts `dsh plugin --profile desktop add` the same way rc.5 does on Windows. Shows at CM1; the stand-in tests cannot tell.
- Whether a Harness installed elsewhere than the two `Applications` folders needs finding through its bundle id (`com.deepseek.dsh`, for example with `mdfind`). Not built unless needed.
