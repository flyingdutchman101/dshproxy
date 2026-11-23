# First-time setup: Apply also installs the video plugin

Frozen 2026-11-22 23:20 after the user's two answers (ledger). Asked: "Does Apply to DeepSeek Harness, when it's first downloaded, also put a video model plugin into DeepSeek?" (it does not), then "Yes, on the first time experience".

## Where it stands

- Apply writes the four chat routes into every DeepSeek Harness profile and nothing else. The video tools reach Harness through the bundle `integrations/dsh-video`, which someone has to install in Harness by hand; the app says it "cannot tell whether the bundle is installed".
- Harness Desktop ships a command that installs a local bundle from outside a session: `resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add "<folder>"` (research: `research/bundle-install.md`, DSH 0.2.2-rc.3). It needs no Node or pnpm of its own. Its stated condition: Harness was opened once and is fully closed.
- Whether it is installed can be read from `profiles\desktop\package.json` without running anything.

## Goal

After one press of Apply on a machine where Harness has been opened once, Harness has the chat routes and the video tools, and the app says truthfully what is in place and what the person still has to do.

## Non-goals

- Getting DSHProxy itself onto a machine (today: clone, `npm ci`, build). No installer in this change.
- Signing in to a provider, saving a key, switching a video model on: these stay the person's own steps.
- Closing or restarting DeepSeek Harness for the person.
- Profiles other than `desktop`.

## Must stay unchanged

- Apply's chat-route behaviour, backups and confirmation.
- No write to a Harness profile's `package.json` or `node_modules` by DSHProxy's own code: only Harness's command does that.
- Nothing is installed without the confirmation saying so.

## Acceptance criteria

1. The app shows, read from the profile, one of: installed and selected; installed but switched off in Harness; installed from another folder; not installed; Harness never opened; Harness not found.
2. Apply's confirmation lists what will happen: routes, and the video plugin when it is not installed.
3. With Harness closed: Apply installs the plugin with Harness's command, then reads the profile back and reports the state from criterion 1. A failure shows the command's last line and the manual way (Plugins > Add plugin, folder path copied).
4. With Harness open: Apply writes the chat routes, then asks the person to quit DeepSeek Harness, waits until no Harness process is left, and installs the plugin. The wait can be ended with "Skip the video tools"; nothing is installed then, and the result says so. DSHProxy never closes or starts Harness.
5. A second Apply changes nothing and says so. A bundle the person switched off in Harness is left off.
6. A moved DSHProxy folder (the profile points at a folder that is gone) is reported, with the repair.
7. Tests: the detection and the command line through a seam with a throwaway `DSH_HOME` and a stand-in for `dsh.cmd`; no test touches the real profile.

## Riskiest assumption

That Harness's command stays where it is and behaves as today: it is an installation detail of a release-candidate build. Hardest case: Harness is open. Proven so far in a throwaway home (ledger): install in 1 s offline, repeat is a no-op, a home never opened is refused with exit 1 and nothing written.

## Known risks

- The plugin is a link to the DSHProxy folder: moving the folder breaks it until Apply repairs it.
- The command installs any folder with a `package.json`; DSHProxy passes only its own `integrations\dsh-video`.
## The contract between the command line and the app

`dshproxy dsh bundle status --json` prints one JSON line and exits 0 whenever it could look:

```
{"harness":"found"|"not-found","harnessRunning":true|false,"profile":"desktop","profileExists":true|false,
 "bundle":"installed"|"switched-off"|"other-folder"|"folder-missing"|"not-installed",
 "folder":"<this DSHProxy's integrations\\dsh-video>","linkedTo":"<folder the profile points at>"|null,
 "version":"0.1.0"|null,"canInstall":true|false,"reason":"<one sentence, or empty>"}
```

- `installed`: the profile's `dependencies["@local/dshproxy-video"]` is a `link:` to this folder (compared as resolved paths, case-insensitively), the name is in `dsh.profile.bundles`, and the profile's `cordis.patch.yml` has no entry with `id: dshproxy-video` and `disabled: true`.
- `switched-off`: linked to this folder, but not in `dsh.profile.bundles` or disabled in the patch. Never changed by DSHProxy.
- `other-folder`: linked to another folder that exists. `folder-missing`: linked to a folder that does not exist.
- `canInstall` is true when Harness is found, the profile exists, Harness is not running, the folder's path is safe to pass, and `bundle` is `not-installed`, `other-folder` or `folder-missing`.

`dshproxy dsh bundle install [--json]`: looks again; when `bundle` is `installed`, says so and exits 0; when `canInstall` is false, exits 1 with the reason and runs nothing; otherwise runs Harness's command once (`dsh.cmd plugin --profile desktop add "<folder>"`, at most 120 s), looks again, and exits 0 only when `bundle` is now `installed`. With `--json` one line: `{"ok":true|false,"bundle":"...","message":"...","log":"<path>"|null}`. Without it, the message as text.

Where Harness is: `%DSHPROXY_HARNESS_DIR%` when set, else `%LOCALAPPDATA%\Programs\DeepSeek Harness`, else the folder of the program registered for `dsh:` links under `HKCU\Software\Classes\dsh\shell\open\command`. The command is `resources\runtime\cli\bin\dsh.cmd` in it. Harness is running when a process `DeepSeek Harness.exe` from that folder exists; a process list that cannot be read counts as running.