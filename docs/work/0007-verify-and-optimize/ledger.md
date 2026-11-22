# Ledger: stress tests, responsive pass, CPU and memory

Requested 2026-11-22: "run stress tests, make sure everything actually works. Make sure design is responsive and has no flaws. Make sure app is optimized and uses no more memory or cpu than needed." Runs after the layout (0004), credential pages (0005) and restart work (0006) are in.

## Baseline, running install (before any optimisation)

2026-11-22, between 04:18 and 04:27 (exact minute not recorded), 60 s sample, 28 logical cores, app build `3f6eb33`, window visible and not minimised on the 3440x1440 display, app up 60 minutes, sessions active through the gateway at the time.

| Process | CPU, % of one core | Working set | Private bytes | Handles | Threads |
|---|---|---|---|---|---|
| `DSHProxy.exe` (app) | 0.16 | 143.4 MB | 163.5 MB | 634 | 25 |
| `node` (gateway) | 1.19 | 230.3 MB | 244.2 MB | 291 | 13 |
| `cli-proxy-api` (backend) | 0.91 | 164.5 MB | 178.9 MB | 547 | 31 |

App CPU per 5 s window, % of one core: 0.31, 0, 0, 0, 0.31, 0.31, 0, 0, 0, 0, 0, 0.94. App GDI objects 135, USER objects 369.

**Corrected between 04:50 and 05:01: the reading below was wrong about CPU.** It counted only the three long-lived processes; the cost is in short-lived children, see "Finding 1". Original reading: idle CPU of the app is already negligible. Memory is the candidate: 164 MB private for a WinForms window. Not yet known: how much is bitmaps for the backdrop and resize preview, how it scales with window size, whether it grows over time or with workspace and section switching, and what it is when hidden in the tray. The gateway and backend were serving requests during the sample, so their numbers are not idle numbers. The backend is a third-party binary and is not ours to optimise.

## Plan (not started)

1. App memory by state: fresh start, each page visited, after 200 workspace and section switches, after 200 resizes, hidden in tray, at 1280x880 versus maximised on 3440x1440. GDI, USER and handle counts at each point to catch leaks.
2. App CPU by state: visible idle, hidden, during a drag resize, with the Log page open while the gateway is busy.
3. Stress: concurrent `video settings set` and `video key set` from several processes (no cross-process lock today); damaged and oversized files; Harness bundle under concurrent, cancelled and timed-out calls; gateway stop-when-idle under held and aborted requests.
4. Responsive pass over every page of both workspaces at all nine sizes, including the new credential pages and pages with real rows.
5. Fix what is found, then repeat the measurements for before and after numbers.

No test spends quota or contacts a paid service.

## Finding 1: the status poll costs about a fifth of a core, around the clock

Measured 2026-11-22 between 04:50 and 05:01 (session clock) on the running install (build `3f6eb33`), and the same code is in the worktree.

- The app runs `node bin\dshproxy.js status --json` every 3 seconds (`timer.Interval = 3000`, `RefreshStatusCore`), whether the window is visible or hidden in the tray. Observed on the running app: 10 polls in 30 s.
- Each poll starts 4 processes and uses 563 ms of CPU on average (six runs: 500 to 641 ms; job-object accounting, so children are included). Node alone starts in 36 ms. The rest is Windows PowerShell, started by `secrets.loadMasterKey` to unlock the master key through DPAPI, only so the status can say which saved API keys are readable.
- 563 ms every 3 s is 18.8% of one core, continuously, and 4,800 process starts an hour. The first baseline missed it because none of it is charged to `DSHProxy.exe`.
- The running gateway already answers `GET /dshproxy/status` over HTTP with no child process.

## Finding 2: memory

- Preview build of the worktree (`29693af` plus the credential pages), window off screen and painted with `PrintWindow`: private bytes 40.1 MB at 1280x880, 44.1 at 1920x1040, 55.4 at 3440x1392, 64.9 at 5120x1392, back to 43.1 at 1280x880. GDI 44, USER 115, handles about 325, all flat. So the window itself is modest and gives memory back.
- 120 painted resizes added 6 MB (43.1 to 49.1) with flat GDI, USER and handle counts. Not yet known whether that levels off.
- The running app: 163.5 MB private at 60 minutes up, 179.5 MB at 93 minutes, about 0.5 MB a minute, with GDI 135, USER 369 and handles about 630 unchanged. A preview window that does not poll sits at 40 MB. The growth therefore comes with the live data path; the poll (660 runs in those 33 minutes, each a 16 KB JSON document parsed and applied) is the first suspect, the log box the second. Not yet separated.
- A first attempt measured the window fully off screen without forcing a paint and showed no change with size; discarded as invalid.

## Fix planned for finding 1 (app only)

1. Fast check, no child process: HTTP `GET <origin>/dshproxy/status`, 2 s timeout, every 3 s while the window is visible and not minimised, every 15 s otherwise. It gives running or not and `inFlight`.
2. The full `status --json` runs only: once at start; when the fast check's answer changes in anything but `inFlight`; after an action in this window that changes settings; when the window is shown again; and otherwise at most once a minute while visible and once every ten minutes while hidden, to notice changes made outside the app.
3. Evidence required: child processes started and CPU used by them over 5 minutes visible and 5 minutes hidden, before and after; private bytes over a 20 minute run, before and after; the window still follows a gateway stop, start, account change and key change within a few seconds.
## Finding 3: saves from several processes at once lose data and still report success

Stress run 2026-11-22 between 04:50 and 05:01, real CLI of the worktree, a temporary data folder per round, synthetic keys, no network. Eight rounds each.

| Case | Result |
|---|---|
| A. Fresh data folder, `video key set` for three providers at the same moment | 8 of 8 rounds bad. Commands answered `saved: true`, but typically only 1 of 3 keys could be read afterwards, and in one round none. Each process created its own `master.key`; the last one written wins and the other keys are encrypted with a key that no longer exists. |
| B. Master key already there, three providers at the same moment | 7 of 8 rounds lost one or two keys although the commands answered `saved: true`. Read, change, write without a lock. |
| C. `video settings set` for four models at the same moment | 8 of 8 rounds: commands reported success, 2 or 3 of 4 models were enabled afterwards. One command failed with `EPERM ... rename`. |

No plain key in any file, no temporary file left behind.

Assessment: case A is the serious one. It is the first-time creation path of `secrets.loadMasterKey` (`existsSync`, then `writeFileSync`), shared with the Chat keys and older than this work; the video key command adds a second way to reach it. This machine's `master.key` already exists, so its saved keys are not exposed to it. B and C answer "saved" for something that was not saved. The earlier review rated B low as "re-runnable"; that missed that the command reports success. The app runs its own commands one at a time, so the exposure is an agent or script running commands in parallel, which agents do.

The same read, change, write pattern is in `src/settings.js` (chat `settings.json`), `src/dsh/profile.js` and `src/control.js`; not stressed yet.

### Fix contract

1. `master.key` is created so that exactly one creator wins: write a temporary file, then link it into place, which fails if the file exists; the loser discards its key and unlocks the winner's. An existing file is never replaced (unchanged rule).
2. Every read, change, write of `video-keys.json` and `video-settings.json` runs under a lock file next to it, taken with exclusive create. The DPAPI call happens before the lock is taken. Waiting is bounded (10 s); on expiry the command refuses with a sentence that says nothing was saved, exit 1. A lock left by a dead process is taken over after its holder is gone or it is older than 30 s.
3. A command answers `saved: true` or success only when a read after the write, still under the lock, shows the change.
4. Tests, red first: in-process concurrent calls with an injected slow master key, and one test with real child processes for each of A, B and C as above. Whole suite green.
5. Out of scope here, to be listed for the user: the same pattern in chat `settings.json`, the Harness profile and the control token.
### Finding 3: fix delivered (05:51)

- By `video-settings`, uncommitted: new `src/filelock.js` (`withLock`, `replaceFile`, `createIfAbsent`) and `test/filelock.test.js`; `src/secrets.js` creates `master.key` through `createIfAbsent`; `src/video/keys.js` and `src/video/settings.js` do read, change, write and read-back under the lock. `src/app.js`, `src/settings.js`, the gateway files and the five files of the 0006 review are unchanged (lead checked: 0 differ from `29693af`).
- Lead reran: `node --test` 552 of 552, 0 skipped, 18.7 s; `node scripts/check.js` 69 files OK; own stress script, real CLI and real DPAPI in temporary folders: case A 0 bad rounds of 8 (was 8), B 0 of 8 (was 7), C 0 of 8 (was 8); new case D, 12 `video key set` at once on one folder: 12 of 12 succeeded in about 1 s, 3 of 3 readable; no refusals, no lock, claim or temporary file left behind, no plain key in any file.
- Worker evidence not rerun by lead: red-first list (13 tests, among them "the file was overwritten" for `master.key` appearing during creation); 240 of 240 changes counted with 58 holders dying while holding the lock; 60 hand mutants, 4 survivors closed by stronger tests.
- New refusals: lock not free within 10 seconds; file could not be replaced; change could not be confirmed by read-back; own lock taken over meanwhile ("may not have been kept").
- Limits stated by the worker: without hard links a reader may for an instant see an empty `master.key` and get the unlock error (nothing is replaced); a holder alive after 30 s can be taken over and then reports failure although its write may have happened; a reused process ID makes a dead lock look held until it is 30 s old; a process killed under the lock leaves the lock file until the next command takes it over.
- Still unprotected, same pattern: chat `settings.json` (11 load, change, save sites in `src/app.js`, `src/cli.js`, `src/daemon.js`; the gateway also holds settings in memory), the Harness profile files (the Harness itself would not honour the lock), `backend.lock.json`, the model list cache. Not fixed here; for the user to decide.
- Reviewer `lock-review` started; main question put to it: can any path damage an existing `master.key`.
## Repeat runs (about 06:05)

- Whole suite five times in a row: 552 of 552 each time, 21.9 to 23.3 s, no leftover `dshproxy.js` process from the worktree.
- Harness bundle tests (`integrations/dsh-video`, run from its folder) ten times in a row: 40 of 40 each time, 0 skipped, 19.2 to 20.0 s. They include the test that a second `video_submit` is refused while one is waiting for the user or being sent.
- A first attempt passed the test folder as an argument to `node --test`; that runs nothing useful on this Node version and was discarded.
- Still to run: the app under a long visible and hidden run (with `desktop-ui`'s polling change), the responsive pass over every page, and a live check of the Harness tools after the bundle is reinstalled.
### Finding 3: review and commit (06:03 to about 06:10)

- Review `lock-review` (reviewer lane; ran 70 tests of the lock, key, master key and concurrency files, read the rest; did not run the whole suite): no path found that can replace, truncate, delete or corrupt an existing `master.key`; nothing above low; no reachable case of "saved" for something not saved.
- Low findings, left as known limits by lead's ruling (all need a freeze or clock jump of more than 30 s at one exact point, or a full disk): release of a lock is check-then-unlink, so a process frozen for more than 30 s between the two could remove its successor's lock; staleness uses the wall clock, so a clock set forward by more than 30 s during a save lets a live holder be taken over (it then reports failure); without hard links an empty `master.key` can be seen for an instant (unlock error, nothing replaced); a failed temporary write can leave a `.tmp` file; cleanup blocks for up to 50 ms in the command-line path only.
- Committed locally as `0afa72a` (18 files under `src`, `bin`, `test`): video keys and Krea status, stop-when-idle, locked saves. Staged diff checked by pattern for private keys and tokens: 0 hits. gitleaks and TruffleHog are not installed on this machine, so that pattern check is the only secret scan.
- README updated, uncommitted: `stop --when-idle` in the command table, the waiting restart in the backend update steps, video provider keys, the Video workspace and window sizing in the app section, and two known limits (the reset of an unread connection at an idle stop; chat settings, Harness profile files and `backend.lock.json` not locked).
## Findings 1 and 2: fixed in the app (delivered 07:09)

By `desktop-ui`, uncommitted, `app/DSHProxyApp.cs` and one line of `app/Skin.cs`; the batch alone is in the git-ignored `.tmp\desktop-ui-0007-batch.diff`. Evidence files and method: `evidence/app-status-and-memory/notes.md`. Measured by the worker on a rig (the app's real main window in a job object, a temporary data folder with one synthetic Chat key, a stand-in gateway on a spare port), not on the running install. Lead rebuilt (`app\build.ps1` exit 0) and reran the suite (552 of 552, 69 files OK); the measurements were not rerun by lead.

| | Before (`29693af`) | After |
|---|---|---|
| Processes started in 5 min, window visible | 400 | 20 |
| Processes started in 5 min, window hidden | 400 | 0 |
| CPU with children, 5 min visible | 59.0 s (19.7% of a core) | 7.4 s (2.5%) |
| CPU with children, 5 min hidden | 46.1 s (15.4%) | 0.08 s (0.03%) |
| Private bytes after 30 min visible, after a forced collection in the rig | 118.0 MB | 47.5 MB |
| USER objects after 30 min | 1,899 | 128 |

- The before figures agree with the lead's measurement on the running install (18.8% of a core, 10 polls in 30 s).
- The visible figures of both runs include a forced repaint every 5 s and a card rebuild every minute, which a real install does less often.
- Memory: the growth was the account cards, not the status path. Each rebuild left the old cards alive (`Controls.Clear()` does not dispose, and a static list of glass surfaces kept them with their cached bitmaps): about 2.4 MB and 59 USER objects per rebuild. The lead's guess that the poll was the first suspect was wrong; the lead's note that USER objects were flat on the running install is explained by cards being rebuilt only when a limit number changes there.
- The window still follows the gateway: stop shown after 4.6 s, start after 3.3 s, account change 3.0 s, update change 2.5 s, in-flight count 0.4 to 3.0 s without a process.
- A full status still costs 4 processes and about 0.5 s of CPU; it now runs once a minute while visible and once in ten minutes while hidden. Not changed: the status command still unlocks the master key through PowerShell each time.
- Restart after a Chat key change waits through `stop --when-idle --wait 300` with a Cancel (46 scenario checks against the worktree's real daemon on spare ports with a stand-in backend); Quit cancels a waiting helper off the UI thread (0.25 to 0.36 s); the in-flight count resets on start and stop.
- Painted resizes level off (37 to 41 MB over 1,200). No `GC.Collect` or working-set trimming in the product (lead checked: 0 matches).
- Not verified: the running install, a real backend, real sign-in; the keyboard part of the six-tab check (needs focus, not taken); the 300 s wait itself (exit 2 was driven with 2 s); the long runs used a source three lines older than the final one.

## Finding 4: `stop --when-idle` can report "connection lost" after the gateway has stopped

- Seen once in five whole-suite runs by `desktop-ui` under machine load, at `test/daemon.test.js:1123`: exit 1 with the "not known whether the gateway stopped" sentence, although the gateway had stopped. Lead's runs: 6 of 6 passed without load.
- Why it matters: the app's waiting restart trusts this command. An answer of "not known" after a real stop could leave no gateway running.
- Lead read `src/daemon.js` 415 to 445: the process exits on the response's `close`, which Node raises a tick after `finish` and before the socket has finished closing. Hypothesis only.
- Handed to `video-settings` between 07:10 and 07:20: reproduce, root cause, the process not ending before the answer's connection has closed in order (bounded), and the command establishing the real outcome when its connection is lost (port refuses and token gone means stopped).
- Reviewer `app-batch-review` started on the app batch; first question put to it: any sequence that ends with no gateway running after the user only asked for a restart.
## App batch: review (07:20)

- `app-batch-review` (reviewer lane, by reading only; it did not build or run the app, and did not verify the CPU and memory figures): the batch diff matches the working tree. Clean by reading: the socket reader (framing, large bodies, disposal, nothing trusted beyond running or not and one number), threading, the timer ceilings, the disposal change (the static surface list is cleaned on every removal path, no shared object disposed), Quit, and no key, token or consent address in any new text.
- Medium 1: Cancel pressed as the gateway commits to its idle stop. The 1.5 s probe misses the exit, the app logs "keeps running" and returns, the gateway then exits: no gateway and no restart. This is the outcome the first review question asked about.
- Medium 2: `IdleStop.Cancel` can touch a disposed `Process` outside its lock; `ProcessTree.Kill` does not catch `ObjectDisposedException`, which would end the app from a background thread.
- Low 3: the sign-in dialog keeps a disposed button as its accept button after "Add another". Low 4: three missed fast checks zero the in-flight count, so Stop or Quit can cut a busy gateway whose status answers were merely slow.
- All four handed back to `desktop-ui`. For medium 1 the fix is stated as a rule: after this window has asked a gateway to stop when idle for a restart, if that process exits within 30 s for any outcome but a user Stop or Quit, start it again once.
## Finding 4: root cause and fix (delivered 08:14, addition 08:25)

- Root cause, by `video-settings`: the gateway ended its process on the response's `close` event, when the socket is still open; Windows resets the open connections of a process that ends and the reset discards what the caller has not read. Proof by a late-reading client: answer lost 9 of 9 on the committed code, received 14 of 14 after; moving only the exit later gave 28 of 28. The natural failure was not reproduced with the real command (0 of 100 stops under load), so it is not proven that the one observed failure was this mechanism; the symptom matches.
- Fix, uncommitted, `src/daemon.js`, `src/cli.js`, `test/daemon.test.js`: the gateway keeps the answer's connection open until the caller hangs up, then ends; a caller that does not hang up is cut off after 2 s. The command, when its connection is lost after the stop request was sent, looks at the address for about 3 s: port refuses and token file gone gives `{"stopped":true}` exit 0; status still answered gives "still running ... Nothing was stopped." exit 1; otherwise "not known" exit 1.
- Second defect found by the worker under overload (4 of 80 commands): the command said "The gateway is not running" when its status look only timed out. Fixed: only a refused connection means not running; on a timeout or unreadable answer the stop request is sent anyway when a token can be read, else a refusal that says the gateway did not answer in time.
- Not fixed, reported: `status --json` says `running: false` after about 2.2 s for a gateway that accepts and does not answer. The app ignores that while its own fast check answers, but not at its first status after opening. A real fix needs a third state in the JSON and in the app.
- Lead: a first repeat run showed 1 failure in 6 and a second one 2 failures in its first run; both ran while the worker was saving `src/cli.js` and `test/daemon.test.js` (file times 08:17 to 08:20), and the captured failures were the worker's new tests against half-edited sources. On the final sources (unchanged during the run, last saved 08:20:43): whole suite 561 of 561, `check.js` 69 files OK, the two files 10 runs in a row with 0 failures, no busy process left.
- Reviewer `stop-answer-review` started at about 08:30 on this change.

## App batch: review fixes delivered (about 08:30)

- By `desktop-ui`, uncommitted, diff of the fixes alone in `.tmp\desktop-ui-0007-review-fixes.diff` (+186 −32). Lead rebuilt: exit 0.
- Medium 1: every outcome of the idle stop except "stopped" leaves a 30 s watch on the process that was asked; if it ends, the gateway is started once ("The gateway had already begun to stop; it was started again."); Stop, Quit or a start by the user cancel the watch. Scenario table in `evidence/app-status-and-memory/review-fixes-scenarios-after.txt`: 94 checks pass; the same program on the old source fails 20, all in findings 1 and 4. Timed cases use a stand-in gateway and stand-in command.
- Medium 2: kill and dispose under one lock in `IdleStop` and `KreaLogin`. Not red first: 300 rounds per class produced no exception on either source; `ObjectDisposedException` derives from `InvalidOperationException`, which was already caught, so the crash the reviewer described could not happen through that catch. Fix kept as by construction.
- Low 3: no behavioural defect (the form already dropped the removed button); made explicit. Low 4: missed checks no longer zero the count while the window's own gateway process is alive; Stop from the tray and Quit ask with a sentence that says the gateway did not answer.
- Process count on the final build: 0 hidden, 16 visible in 5 minutes (four full statuses; the fifth fell just outside the window).
- Open from the worker's note: with its own gateway alive but silent the window says "Stopped", disables Stop and enables Start. Handed back as item A of the last batch (a third state), together with the responsive pass over every page and dialog at all sizes. One independent review follows over everything since the previous one.
- 08:41. Review `stop-answer-review` (reviewer lane; ran the 57 tests of the two files, read the rest): no critical, high or medium. Confirmed by reading: the process cannot end before the answer's socket has closed or been cut at 2 s, and cannot fail to end after a reported stop; `{"stopped":true}` after a lost connection needs both a refused port and a removed token file, which only a real stop produces (a crash leaves the token, giving "not known"); the origin is always a loopback address; a stale token has no value. Two lows left as known limits: the status look's time limit does not cover name resolution when the host is `localhost` (the default is the address `127.0.0.1`); with an unanswering program on the gateway's port and a readable token the command can wait up to the stop wait plus 60 s before saying "not known".
- Committed locally as `664530e` (3 files). Pattern check of the staged diff for keys and tokens: 0 hits.

## Merge preparation (read-only, about 08:45)

- `main` = `origin/main` = `9009235`. `video-routing` is 5 commits ahead and 0 behind; `fix-update-trial-race` 1 ahead and 0 behind; the two branches share no file. Dry merges with `git merge-tree`: both clean.
- Main checkout: every modified or untracked file other than the user's three (`README.md`, `src/gateway/server.js`, `test/gateway.test.js`) is byte-identical to its content in the pushed commit `3f6eb33` (30 files compared by object id). They are the copies the lead placed there for the running install and can be replaced by the merge without losing anything.
- The user's uncommitted `README.md` edit is one hunk at line 11; the branch's README changes start at line 26. `git apply --check` of the user's edit on the branch's README: clean.
- Plan for the last step: back up the user's three files and their diffs outside the working tree; build the merge commit in a temporary worktree and test it there with the user's three edits applied on top (uncommitted, never committed); push; in the main checkout set aside only the README edit, fast-forward, reapply it; rebuild; idle-wait restart.
## Finding 5: showing Chat > Models sends "offer this model" for every ticked row (09:04)

- Found by `desktop-ui` during the layout pass; present in `main`, not caused by this branch. Windows reports each tick again when the list window is built, and `OnModelChecked` acts on it: one `POST models/choose {"id":...,"offered":true}` per ticked row with no click. On a real gateway each call adds the ID to `settings.models.extra`, saves `settings.json` and runs a Harness profile sync.
- Worker's evidence: stand-in gateway logging the control call, four rows, three ticked: showing the page gave 3 calls; a tick removed by hand gave exactly one.
- Ruling: fix it (ignore a reported tick equal to the row's known state, as the Video models list does), red before green, and check the other ticked lists. Existing entries in a user's `settings.json` are not touched; what they contain and whether they have any effect is to be reported to the user.
## App: last batch delivered (10:30)

By `desktop-ui`, uncommitted; this batch alone in `.tmp\desktop-ui-0007-final.diff` (+475 −71). Lead rebuilt (exit 0, 10:31), reran the suite (561 of 561, 69 files OK) and looked at five captures (Chat Models, Lanes and "Not answering" at 860x600, Video API keys at 1920x1040, Video Accounts at 3440x1392): centred, nothing overlapping or outside the window; the open flaw below is visible as described.

- Header states: Running, Starting (own process alive, no answer yet; added by the worker, kept), Not answering (own process alive, answered before, misses checks; Stop enabled and asks), Stopped (no own process, nothing answers). 104 scenario checks pass; 8 fail on the source before this batch, all in the new states. Stand-in gateway only.
- Responsive pass: 231 captures in `evidence/responsive/`, 9 sizes plus two start sizes, every section of both workspaces, the Video Accounts and API keys states, update bar, dialogs. Program checks (margins, inside parent, text fits, no horizontal scrollbar, no overlap, columns sum, scroll range): 1615 of 1617 pass, 229 captures clean. Before the fixes the same program gave 1009 of 1272 and 2 clean captures of 212.
- Fixed there: two-line bottom row in a one-line space; suggestions row drawn over the top of the Models list; update bar 4 px off and its buttons outside the window at 860; the 1 px clip of "● Active"; long e-mail pushing plan and state out; lane names and ladders cut at 860 (ladders now wrap); model names cut at 860; Harness list column shares; text beside buttons 4.5 to 6 px off centre in six places; single-word last lines; rows without a logo starting further left; short-window header not relaid when its text changes; disabled button text brighter than enabled.
- Open: at 860x600 the Reasoning and Status columns of Chat > Models end in dots (12 failing lines in 2 captures); whole from 1177 wide. To be closed in the round after the review.
- Finding 5 fixed: a reported tick equal to the row's known state is ignored. Checks: page shown 0 calls (was 3 for 3 ticked rows), tick off 1, tick back 1, four refills 0. The Video models list already had the guard; no other ticked list sends a command.
- Not verified by anyone: the running install, real monitors and scaling other than 100%, a list whose columns the user dragged, keyboard focus order (needs focus). Self-review by the worker; `app-final-review` started at 10:31 on the two diffs since the previous review.

### What finding 5 left in the user's settings (read 10:32, read-only)

- `models.extra` holds 25 IDs. The live `status --json` lists 15 offered models, all with reason "new" or "known", so none is offered only because of that list today. The other 10 IDs (Gemini and `ag-` models) are not served by any account now.
- Effect of an entry (worker's reading of `src/daemon.js` and `src/models.js`): none while the model is offered by default; if it later counts as an older generation it stays offered. So the list can only matter later, by keeping models that would otherwise drop out. Nothing was changed in the file.
## App: review of the last two batches (10:41)

- `app-final-review` (reviewer lane, by reading only; it did not build, run or inspect the harness, and did not verify the worker's counts): both diff files match the working tree; nothing above low. Clean by reading: exactly one start in every ordering of the late-stop watch, the Exited handler, the Stopped path and the user's Start; no deadlock and no UI-thread wait on the cancel lock; no state with both buttons disabled; the tick map is refilled on every fill and consulted before any send; layout handlers are guarded against recursion; no key, token or consent address in any new text.
- Low 1: Stop and Quit ask the "did not answer" question after one missed check while the header still says Running (it changes after three). Low 2: Starting is never left when the window's own process stays alive and never answers. Low 3: the late-stop watch probes the address on the UI thread for up to 1.5 s.
- All three, plus the open Models columns at 860x600, handed to `desktop-ui` as the last round (`.tmp\desktop-ui-0007-last.diff`). Since these are low and the round is small, the lead will check that diff by reading and by the reruns instead of a further independent review; that last check is a self-review and will be labelled so.
## App: last round delivered (11:16) and read by lead

- `desktop-ui`, uncommitted, `.tmp\desktop-ui-0007-last.diff` (+119 −39). What is asked follows what is shown (the "did not answer" sentence only in Not answering); Starting becomes Not answering after 30 s without a first answer; the late-stop watch asks the address on its own thread (window thread held 1 to 3 ms instead of about 1.5 s); Chat > Models leaves the Service column out where six columns cannot show their text (service in the row's tip). Worker's reruns: 116 scenario checks, layout program 1617 of 1617 over 231 captures, ticks 14, seam 25, credentials 43, six sections 0 differing pixels, build exit 0.
- **Self-review by lead** (reading the whole diff; no independent review of this round): the column loop ends after at most two passes; the watch's thread touches no window state and catches what the address check can throw; the tick and state changes agree with the stated rules. One low edge left: if the user drags a column while Service is left out, it stays out for that list until the window is reopened.
- New finding by the worker, in the code since `e44910b`: after a resize the backdrop is never redrawn at the new size; the stretched bridge copy counts as "already this size", so a maximised window keeps a stretched sky and two runs of the same sources can differ. Ruling: fix it (one redraw per settled resize), then retake all 231 captures from one build. In progress.

## Restart preparation (11:18)

- Script `.tmp\restart-when-idle.ps1` written for the outside procedure of `0006/spec.md`: checks (one app from the main checkout, one gateway under it, status answers), keeps the old program in `.tmp\previous-app`, samples the gateway's connections to the backend port until none for 3 s in a row (limit 10 minutes, then exit 2 with nothing stopped), then `taskkill /T /F` on the app, copies the prebuilt program into place, starts it through Explorer, and measures the time until `/dshproxy/status` answers. Fallbacks: start the app directly after 20 s, the gateway alone after 90 s. Everything is logged to a file as it happens.
- Why through Explorer: the running app (started 03:23 from this session's shell) is inside a job object, as is this shell; started through Explorer it is neither a child of the session nor part of its job.
- Dry run (stops nothing): checks passed; app window visible, so the new one is started visible; 30 samples in 12 s all showed 1 or 2 connections to the backend while `desktop-ui` was working. To confirm before the real run: that the count reaches 0 when no agent is working (otherwise the script would only wait and give up).
- The Harness bundle `integrations/dsh-video` is unchanged since `3f6eb33` (the installed version): no reinstall.
## Backdrop redraw, final build, what is published (11:49 to 12:00)

- Backdrop: `desktop-ui`, `app/Skin.cs` only (+26 −2, `.tmp\desktop-ui-0007-backdrop.diff`). The stretched bridge copy is remembered per window and replaced by a scene drawn at the real size 160 ms after the last resize step; nothing is drawn for a hidden or minimised window. Worker's checks on the app's real window off screen: 12 size changes among 860x600, 1280x880, 3440x1392 and 5120x1392, 0 differing pixels against a fresh backdrop (before: 10,197 to 283,388); one redraw per settled resize; 300 resizes with GDI 44 before and after and private bytes 100.3 to 101.9 MB; two layout runs of the same sources now identical in 230 of 231 pictures (the other has a moving progress bar). **Self-review by lead** of the diff: the set of bridged windows is cleared where the cache is cleared; the timer is disposed when it fires; no path redraws repeatedly.
- Not seen by anyone: a maximise on a real monitor. Every paint in the checks was requested by the check program.
- Final app sources: lead rebuilt (exit 0, 11:49), suite 561 of 561, `check.js` 69 files OK. All 231 captures retaken by the worker from one build; layout program 1617 of 1617; six sections 0 differing pixels; seam 25; 5 minutes hidden 0 processes started.
- The repository is public. The 231 responsive captures show the data and program folders in the window's bottom line, which lie under the local user profile, so they are not committed (`evidence/responsive/.gitignore`, `README.md` there); they remain on disk in the worktree. In 11 text evidence files the profile folder was replaced by `%USERPROFILE%`. Pictures that are committed (the 0005 preview captures, two dialog captures) show no path.
- Reviews of the app work in this change: `app-cred-review`, `app-batch-review`, `app-final-review` (reviewer lane, independent); the last round and the backdrop change were checked by the lead only (self-review).
## Merge, push and restart (from 11:52)

- Everything to be published was scanned by pattern for private keys, tokens and the local user name: 0 hits in both branches. gitleaks and TruffleHog are not installed; that pattern scan is the only one.
- Merge built in a separate worktree (`.agents\worktrees\merge-main`, branch `merge-main`): `c56bc29` merges `video-routing`, `97b33e6` merges `fix-update-trial-race`. On the merge commit: `node --test` 564 of 564, `check.js` 70 files OK. With the user's three uncommitted edits applied on top (temporary copies, removed afterwards): 565 of 565, 70 files OK, Harness bundle tests 40 of 40, `app\build.ps1` exit 0 (stamp `2026-11-22 11:54 97b33e6`).
- Main checkout: the user's `README.md`, `src/gateway/server.js` and `test/gateway.test.js` backed up as files and as patches in `.tmp\main-user-files-backup` of the `video-routing` worktree and verified by hash. The 4 modified and 26 untracked copies the lead had placed there were each confirmed identical to their content in `3f6eb33` and replaced by the fast-forward to `97b33e6`. Afterwards: `server.js` and `gateway.test.js` byte-identical to the backup, the README edit reapplied with the same 6 changed lines, status shows only those three files. The running gateway kept answering.
- Pushed: `origin/main` `9009235..97b33e6`.
- The new command line against the still running old gateway: `running: true`, `inFlight: null`, as designed for an older gateway.
- Dry run of the restart script with no agent working: the gateway's connections to the backend went 1, then 0, and stayed 0 for 3 s (7 s in all). Nothing was stopped.
- Next: the real run of `.tmp\restart-when-idle.ps1`. Its log is `.tmp\restart-log.txt`; the program it replaces is kept in `.tmp\previous-app\DSHProxy.exe`.
### Restart result (11:56)

- Real run of the restart script, from its log: waited 6 s for an idle moment (15 samples, 5 with a request in flight, then none for 3 s); stop at 11:56:05.085; old processes gone after 216 ms; new program in place after 219 ms; the gateway answered its status again **3,551 ms after the stop**, backend running, same backend version 8.0.75. The previous replacement at 03:23 had left 32 s.
- This session's next model request went through the new gateway without an error. Whether any other open session had a request cut in those 3.5 s is not known; none was in flight at the stop by the connection count.
- Live after the restart: app started by Explorer; `/dshproxy/status` reports `inFlight`; 4 accounts and 15 offered models as before; in 60 s with the window as the user has it the app started 1 child process (one `status --json`) and used 94 ms of CPU (before this work: about 20 polls and 11 s of CPU with children per minute); private bytes 45.4 MB two minutes after start, GDI 46, USER 151.
- CI on `main` at `97b33e6`: success.
- Not done on the live install, on purpose: a Krea sign-in, saving a video key, a backend update, any paid request. The log shows CLIProxyAPI 8.1.0 offered again; the update-trial fix is live now but has not been run against a real update.
- Left in place: worktree `.agents\worktrees\merge-main` (branch `merge-main`, equal to `main` at the merge), the old program in `.tmp\previous-app`, the backup of the user's three files in `.tmp\main-user-files-backup`, the 231 captures on disk.