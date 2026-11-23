# First-time setup: ledger

| Gate | Status | Evidence |
|---|---|---|
| Research: how Harness installs a bundle from outside | done 22:58 | `research/bundle-install.md` |
| Spike: the command in a throwaway home | done 23:05 | below |
| User decisions (Harness open; how much of a first-run screen) | done 23:19 | below |
| Pictures of the new dialogs shown to the user | shown 00:12 | awaiting the user |
| Spec frozen | done 23:20 | `spec.md` |
| F1 command line (`first-setup-cli`) | done 23:50, lead-verified | `reports/F1.md`; 603 pass |
| F2 app (`first-setup-app`) | done 23:58, lead-verified | `reports/F2.md` |
| F3 merge, real run in a throwaway home | done 00:05 | below |
| Independent review | done 00:08 | no critical or high; below |
| The user's go to ship | given 01:23 ("Ship!") | |
| Merged, pushed, CI, swapped | done 01:27 | below |

Next step: none for this change. Open: the three items under "Not verified by anyone"; the README does not name `dsh bundle status|install` (the user has uncommitted edits to it).

## Spike (lead, 23:02 to 23:05)

`dsh.cmd plugin --profile desktop add <copy of integrations\dsh-video>` with `DSH_HOME` set to a new folder under `%TEMP%` and every other `DSH_*` variable removed:

- Profile with `package.json` only: exit 0 in 1 s, no network; `dependencies["@local/dshproxy-video"] = "link:<folder>"`, the name appended to `dsh.profile.bundles`, a symbolic link in `node_modules\@local`, `pnpm-lock.yaml` and `.plugin-manager` created.
- Second run: exit 0, `package.json` byte-identical.
- Home with no profile: exit 1, "Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.", nothing created.
- A folder that is not a bundle: exit 0, installed as a plain dependency with a warning, not selected.
- The real profile's `package.json` hash was the same before and after; the spike folder was removed.

Not tried: the command while Harness is open on the same profile; a machine without the right to create symbolic links; Harness then loading the bundle from a profile set up this way.
## User decisions (23:19)

- Harness open when Apply is pressed: "Ask me to close it, then continue". Apply writes the routes, asks to quit Harness, waits, installs; the wait can be skipped.
- How much first-run: "Apply does both, with a short checklist". No separate welcome screen in this change.

## Rulings

- Ruling: DSHProxy never writes a Harness profile's `package.json` or `node_modules` itself; it runs Harness's own command — because Harness documents hand edits as unsupported and its rollback relies on the lock file agreeing — cost if wrong: none, this is the stricter choice.
- Ruling: only profile `desktop` — because `web` and others are started differently and the user's Harness is the Desktop app — cost if wrong: a person using `dsh web` installs the plugin by hand.
- Ruling: a plugin switched off in Harness is left off — because that was the person's choice — cost if wrong: one more click in Harness.
- Ruling: no spec-review lenses and no clickable prototype before building; the layout harness pictures stand in for the prototype and go to the user before shipping — because the change is one confirmation, one waiting dialog and one status row built from existing controls — cost if wrong: texts are redone after the user sees them.
## F3 (lead, 23:58 to 00:10)

- Branch `first-setup-app` at `fc7ba69` = `ed0f03b` + F1 (`53e7bae`) + F2 (`2ad71fc`) + merge + the lead's integration commit. Reports are kept on this docs branch only (they name local folders).
- Contract amended by the lead: `canInstallAfterQuit` (true only when a running Harness is the one thing in the way). Before it, the app took "not installable while Harness runs" as "only because it runs" and would have asked the person to quit Harness for an install that is then refused. Red: 4 tests in `test/dsh-bundle.test.js`; the confirmation case `cannot-other-reason-open` failed against the previous app (`-Source`), "program checks: 25 of 26".
- `node --test`: 603 pass, 0 fail. `node scripts/check.js`: 72 files OK. `app\build.ps1`: exit 0. Layout check: 335 captures, 3023 of 3023, never the foreground window.
- Real run on the merged branch (`test\manual\dsh-bundle-real-run.ps1`, throwaway home, real `dsh.cmd`, process list injected empty): installed in 777 ms, second run "already installed", real profile hashes unchanged.
- The app's parser on the real command line's answers (`SetupParseCheck`): Harness open gives plan InstallAfterQuit; never opened and not found give Cannot; a refused install gives ok False with the reason.
- The user's real profile, read only, with the main checkout as root: `bundle: installed`, version 0.1.0, Harness running, `canInstall: false`, no reason. So on this machine Apply will say "already installed" and will not ask to quit Harness.

## Independent review (reviewer lane, 00:08; family not confirmed, not GPT)

- No critical or high finding. Medium: the layout check's throwaway rig (with its own key file and the local user name) sat untracked and unignored while the check ran. Fixed: the rig is removed and the harness folder has ignore rules.
- Accepted, not changed: the app's wait matches a Harness process by name, not by folder (a second Harness elsewhere keeps the wait open; the person can skip). The command-line tests use the real process reader (need PowerShell and CIM on the runner; CI will show).
- Residual: a profile that points at this folder through a junction or short name reads `other-folder`; `DSHPROXY_HARNESS_DIR` and the `dsh:` registry entry are trusted as the same user's.

## Not verified by anyone

- DeepSeek Harness loading the video tools from a profile set up by this command on a machine where they were never installed.
- The whole flow with a real Harness quit (the wait closing by itself, then the install).
- A machine without the right to create symbolic links.
## Shipped (01:24 to 01:27)

- `main` = `origin/main` = `fc7ba69` (fast-forward; the user's three uncommitted files have the same hashes before and after). `node --test` in the main checkout: 604 pass. CI on `fc7ba69`: success, which also shows the command-line tests' real process reader works on a clean runner.
- App replaced at an idle moment at 01:24:32; gateway answering 3.6 s later; log `.tmp\restart-log-3.txt`, previous program in `.tmp\previous-app-3` (both in the `video-routing` worktree).
- Live, read only: `dshproxy dsh bundle status` says "The video plugin is installed in DeepSeek Harness (version 0.1.0)."; `dsh verify` ready; 27 models; the real profile's `package.json` hash unchanged.
- Not done on the live install: pressing Apply (it writes the routes; the user's to press), and any install.