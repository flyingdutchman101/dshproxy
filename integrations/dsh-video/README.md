# DSHProxy video for DeepSeek Harness

A DeepSeek Harness bundle that offers the video models enabled in DSHProxy to the agent as tools. Video is an action here, not a chat model: nothing is added to the model picker or to the provider list.

**Status: not installed and not verified inside a running Harness.** The tests in this folder exercise the tools, the child process and DSHProxy's own video command offline, with synthetic jobs only. No real job was ever submitted and no real sign-in was used. Installing the bundle into a profile, and checking how the approval question looks and behaves there, is a separate step that needs the user's approval.

## What the tools do

| Tool | Does | Contacts a provider | Can spend |
|---|---|---|---|
| `video_options` | Lists the models that are enabled in DSHProxy and have a billing route chosen, with that route and whether a job can be started on it. | No | No |
| `video_quote` on an API route (`videorouter`, `videorouter-replicate`, `kovapi`, `callirra`) | Returns DSHProxy's dated published estimate for one five-second, 16:9, text-only clip, in the route's own unit (US dollars or plan credits). | No. The prompt is not used and not sent. | No |
| `video_quote` on the `krea` route | Asks the signed-in Krea workspace for a compute-unit preflight of the same clip. | **Yes. The prompt is sent to Krea.** | No |
| `video_submit` on the `krea` route | Starts one paid job, after the user approved that exact job. | **Yes. The prompt is sent to Krea.** | **Yes** |
| `video_status` on the `krea` route | Looks up one job by the model, route and job id `video_submit` returned. | Yes, read-only | No |

A quote or a job is refused unless the model is enabled in DSHProxy on exactly the requested route. The settings are read again for every call, so a change in the DSHProxy app applies to the next call.

## How a paid job is approved

`video_submit` takes a model, a route and a prompt. It has no argument for a cap or for approval. Each call does this, in order:

1. Refuses outright when it was not called directly by the agent in the user's own session: from code, from a subagent, or without a session.
2. Gets a fresh compute-unit quote from Krea for exactly this prompt. This sends the prompt to Krea and charges nothing.
3. Asks the user one question that this plugin writes: model, route, the clip preset DSHProxy lists for the model (duration, aspect ratio and resolution), the quoted amount, the spending cap (the quoted amount, exactly), a final-cost warning, and the prompt as it will be sent. There are two answers, "Do not generate" and "Generate once". There is no "always" answer.
4. Sends the job only if the answer is exactly "Generate once" with no typed text. Anything else, including no answer, an error or a cancelled question, sends nothing.
5. Reads the DSHProxy settings again. If the model is no longer enabled on that route, nothing is sent and the approval is not used.
6. Sends one request with the approved cap. DSHProxy's Krea helper asks Krea for the price once more and does not send the job if it is above the cap.

Only one request is handled at a time; a second call made meanwhile is refused. Each job needs its own approval.

The result is one of three outcomes:

- `submitted`, with the job id. The final debit is not read back.
- `declined`: nothing was sent.
- `unknown`: the request was handed over and its outcome could not be established, so the job may have been submitted and charged. The tool tells the agent not to call again and to have the user check their Krea history. The next approval question, for any job, carries a warning about it until the user goes on.

A failure is reported as "nothing was submitted" only where DSHProxy establishes that before its paid call: no sign-in, a price above the cap or an insufficient balance at submission, a changed setting, or a request it does not accept. Every other failure once the send has started is `unknown`.

## What this approval is and is not

It is a confirmation step in the Harness interface for the agent's `video_submit` tool. It is not a security boundary:

- An agent that can run shell commands as the same Windows user can start the DSHProxy command line directly, with no question asked. The user accepted this limit for this release.
- The child process of this bundle cannot tell whether a person approved; it trusts the plugin that starts it.
- The question's appearance is not verified. In the installed Harness, only two built-in question ids get the dedicated approval card; this question is expected to appear in the general question form, which also offers a free-text answer. A free-text answer is never treated as approval.
- The warning after an `unknown` outcome is kept in memory only and is lost when the Harness restarts.

## Limits you should know

- **API routes cannot generate or be checked here.** `video_submit` and `video_status` work on the `krea` route only. API routes need a provider key, and this plugin does not read provider keys; it refuses those routes before any quote or question. Use the DSHProxy command line for them.
- An API-route quote is a snapshot with a date, not a live price and not a promise of the final debit. A Krea preflight is in compute units, not US dollars, and the final debit can differ.
- An enabled model is a setting, not proof that the route works or that the workspace offers the model.
- The agent decides when to call `video_quote` and `video_submit`. On the `krea` route each call sends the prompt to Krea, before the user is asked anything. The tool descriptions tell the agent to do that only when the user asked, which is guidance, not enforcement.
- A prompt containing control, invisible or text-direction characters is refused by `video_submit`, because it could not be shown to the user exactly.
- No tool signs in. Without a Krea sign-in every `krea` call fails with "not signed in"; signing in stays a separate step the user takes in DSHProxy's Krea helper.
- A read-only call (`video_options`, `video_quote`, `video_status`) is stopped after `timeoutMs` (100 seconds unless set) or when the Harness cancels it. Stopping ends the one process this bundle started. On the `krea` route that process has started DSHProxy's Krea helper, which is a separate process and is not ended with it: the helper can keep running in the background until its own request finishes or fails, and its answer is then discarded. So after a stopped `krea` quote the prompt may already have been sent and the preflight may still complete at Krea. A preflight generates nothing and charges nothing.
- A `video_submit` send is not stopped when the Harness cancels the call, because stopping could not take a sent job back. (A cancellation that arrives before the request was handed to the child process sends nothing and is reported as cancelled.) The call returns `unknown` at once and the send finishes or fails in the background. With no answer after 110 seconds the outcome is `unknown` as well.
- A job id exists only in the tool result. If the Harness stops between the send and the result, the id is not recorded anywhere by this plugin; the job is then visible only in the Krea workspace.
- A failed call returns one of a fixed set of messages. Provider and file-system error text is dropped, so the DSHProxy app is the place to diagnose a failing route.
- Output links from `video_status` can be private and short-lived. They are returned as text.
- On Windows, Node copies a few machine and user variables (`PATH`, `USERNAME`, `WINDIR` and similar) into every child process. Provider keys and other variables of the Harness are not passed on.
- Not verified here: how the tools and the approval question look in the Harness Web UI, which agent presets and subagents see the tools, the question with a real live session, and all live Krea behavior.

## Requirements and settings

Node.js 22 or later must be installed. The Harness desktop runtime is not used to run DSHProxy; `node.exe` is looked up on `PATH` and then in `Program Files\nodejs`.

The bundle expects to stay where it is, in DSHProxy at `integrations/dsh-video`, and uses the DSHProxy folder two levels up. All settings are optional and go in the plugin row's `config`:

| Setting | Default | Meaning |
|---|---|---|
| `root` | two folders up from this bundle | Absolute path of the DSHProxy folder. Only a folder whose `package.json` is named `dshproxy` is accepted. |
| `node` | found as described above | Absolute path of `node.exe`. |
| `home` | `DSHPROXY_HOME`, else DSHProxy's default | Absolute path of the DSHProxy data folder holding `video-settings.json`. |
| `timeoutMs` | `100000` | Time limit for one read-only call, 1000 to 120000. |

## How it is built

`index.js` registers the tools with `ctx.tools.register` and removes them when the plugin unloads. `lib/tools.js` holds the two read-only tools; `lib/submit.js` holds `video_submit` and `video_status`, and asks the user through the Harness `userQuestions` service.

For each request, `lib/bridge.js` starts `runner.cjs` under Node with the DSHProxy folder as its only argument, writes one JSON request to its standard input and reads one JSON answer. The prompt travels only on standard input, never in a command line or an environment variable. `runner.cjs` loads DSHProxy's `src/video/command.js` and calls it with `settings`, `quote`, `status` and, for the `krea` route only, one `submit`. It reads no provider key and never signs in. The Krea sign-in stays inside DSHProxy's own Krea helper process. Every field of an answer is checked before it is returned.

## Tests

```sh
node --test integrations/dsh-video/test/dsh-video.test.mjs integrations/dsh-video/test/submit.test.mjs
```

Shared test helpers are in `testing/support.mjs`. The tests use temporary folders for settings and for the Windows profile, a stub DSHProxy folder where a provider answer is needed, a stand-in for the user's answer, and no network, account or real profile. Tests that run DSHProxy's real code use an empty temporary profile and no provider key, where it stops at "not signed in" before any request.
