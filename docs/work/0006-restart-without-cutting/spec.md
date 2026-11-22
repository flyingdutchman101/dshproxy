# Restart the gateway without stopping sessions

Requested 2026-11-22: "Make sure the restart doesn't stop sessions in place." Base `3f6eb33`, worktree `video-routing`.

## Facts this rests on

- Today `stop` in `src/daemon.js` closes every connection at once, so a model request in flight is cut. The app stops the gateway with `taskkill /T /F`, and the gateway also dies when the app that started it is killed.
- The app replacement on 2026-11-22 at 03:23 left no gateway for about 32 seconds (last answer 03:23:07, listening again 03:23:39, from `dshproxy.log`).
- Installed DeepSeek Harness 0.2.2-rc.3, read from its packaged source by a scout (not run): a refused connection or a 5xx is retried 5 times with 0.5 s backoff doubling to a 10 s cap, about 14 s in total. A response cut mid-stream is not resumed; depending on how the cut surfaces it is retried from scratch or the turn fails and waits for the user. DSHProxy sets no `retryPolicy` on the providers it writes, so the default applies.
- A gateway start takes under a second once Node is running (backend start to listening: 0.3 s in the log).

So a restart leaves sessions alone when two things hold: no model request is in flight at the moment of the stop, and the gateway is listening again within a few seconds.

## Behavior

1. **In flight count.** The gateway counts requests in flight on its port, except its own `/dshproxy/` status and control requests. `status` reports it as `inFlight` (a number).
2. **Stop when idle.** `stop({ whenIdle: true, waitMs })` keeps serving, including new requests, until a moment with nothing in flight, then stops as today. If `waitMs` passes first it resolves `{ stopped: false, inFlight }` and the gateway keeps running unchanged. Plain `stop()` behaves as today.
3. **Restart after a backend update or rollback** (`restartGateway` in `src/cli.js`) waits for an idle moment, logging once a minute while it waits. After 15 minutes it restarts anyway and logs that requests were cut and how many.
4. **Command.** `dshproxy stop --when-idle [--wait SECONDS]` asks the running gateway, over the existing control interface, to stop when idle; default wait 300 seconds. Prints `{"stopped":true}` and exits 0, or `{"stopped":false,"inFlight":N}` and exits 2. The gateway process exits once stopped. Without a running gateway: says so, exits 1. `dshproxy stop` without `--when-idle` is a usage error; nothing new stops a gateway at once.
5. Nothing else changes: routing, failover, the control token, the listener, the backend supervisor.

Out of scope: zero-gap handoff between two gateway processes, keeping the lane position of a conversation across a restart (held in memory, lost as today), and the app's Stop and Quit buttons (follow-up in the app: confirm when `inFlight` is above zero).

## Constraint

Do not edit `src/gateway/server.js` or `test/gateway.test.js`: the main checkout has uncommitted edits to both that are not part of this work, and a change here would block the merge. Count requests from `src/daemon.js` on the server object. If that is not possible, stop and report.

## First restart, before this code is running

The running gateway does not have the command. For that one restart the same two conditions are met from outside:

- wait until no subagent or job of this session is running;
- sample established connections from the gateway process to the backend port until there are none for 3 seconds in a row (a model request holds one for its whole duration);
- stop the app and gateway and start the new app at once, everything built and copied beforehand; the command returns only after `/dshproxy/status` answers, and reports the measured gap;
- abort without stopping anything if the wait for idle exceeds 10 minutes.

A request that starts in the fraction of a second between the last sample and the stop would be cut at its start; the Harness retries that case.

## Verification

- Red before green at the daemon and CLI seams with a fake backend and held-open responses: count rises and falls, including on aborted requests; stop-when-idle does not cut a held request and stops right after it ends; new requests are served while waiting; timeout leaves the gateway running; control and status requests are not counted; exit codes of the command.
- Whole suite and syntax check green. No real backend, account or network in tests.
- Not verifiable in tests: the Harness retry behavior, and the gap of a real restart, which is measured when it happens.
