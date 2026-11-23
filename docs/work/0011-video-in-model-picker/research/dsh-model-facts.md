# DSH model facts for a video entry in the chat picker

Read-only research, 2026-11-22: DSH Desktop 0.2.2-rc.3, pi-ai 1.3.0, profile `desktop`.

Path shorthand:

- `<pkgs>` = `C:\Users\USER\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai`
- `<pi>` = `...\app.asar\dsh\node_modules\@earendil-works\pi-ai\dist\api`
- `<profile>` = `C:\Users\USER\.dsh\profiles\desktop\cordis.patch.yml`

## 1. Model entry and route schema

No field marks a model as tool-incapable, hides it from subagents or auto-selection, or gives it a group, category, description or icon. A longer wait is a per-route setting.

- Fields: `<pkgs>\dsh-llm-pi-ai\src\config.ts:332-380`, `catalog.ts:604-640`. Only the model `id` is required.

```text
model: id (required), name, contextWindow, maxTokens, input [text|image],
       reasoningEfforts (false | dict), compat
route: apiKeyEnv, displayName, api, baseURL, models, modelOverrides, compat,
       defaultContextWindow (1,000,000), defaultMaxTokens (128,000),
       defaultInput ([text]), headers, reasoning, thinkingBudgets, cacheRetention,
       transport, timeoutMs, websocketConnectTimeoutMs,
       streamIdleTimeoutMs (300,000), five image limits, retryPolicy
```

- Smallest valid values: `contextWindow: 1`, `maxTokens: 1` (integers, `config.ts:334-335`).
  - A configured `maxTokens` also becomes the per-request cap (`catalog.ts:612-616`).
  - Compaction starts at 0.8 × `contextWindow` (`<pkgs>\dsh-compaction-basic\src\config.ts:20`), so keep the window large.
- `LlmModelInfo` has `description?` and `badge?` (`<pkgs>\dsh-llm\src\types.ts:369-385`), but the pi-ai adapter returns only `provider, id, name, inputModalities` (`<pkgs>\dsh-llm-pi-ai\src\adapter.ts:346-363`).
- A source search for `supportsTools|toolCalling|noTools` found nothing.

```yaml
dshproxy-video:
  displayName: DSHProxy · Video (paid)
  api: anthropic-messages
  streamIdleTimeoutMs: 900000
  retryPolicy: { mode: normal, maxRetries: 0 }
  models:
    - { id: seedance-2.5-720p-krea, name: "Seedance 2.5 - 720p - Krea", input: [text], reasoningEfforts: false }
```

Not verified: this excerpt was not loaded.

## 2. Picker

Models are grouped under the route's `displayName`; the name is shown verbatim.

- Order: DeepSeek providers first, then catalog order (`<pkgs>\dsh-client-ui-model-selection\src\client\ModelSelect.tsx:96-118`, `provider-order.ts`).
- Search appears above four entries; it matches model names only (`ModelSelect.tsx:115-118`).
- No character limit; CSS ellipsis at 420px menu and 360px trigger width (`ModelSelect.module.css:19,113,298-304`).
- A group disappears only when it has no models or its credential does not resolve (`adapter.ts:346-363`). No collapse or hide control was found.

## 3. What a normal turn sends

The typed text is its own user message, verbatim. The wire request does not say which message that is.

- Every request carries the system prompt and the full tool list (`<pkgs>\dsh-agent-loop\src\agent.ts:741-748`).
- DSH adds separate user-role messages after the prompt:
  1. workspace instructions, `<system-reminder>…` (`<pkgs>\dsh-agent-instructions\src\index.ts:351-355`);
  2. runtime context, `<system-reminder>…` (`agent.ts:304-310`, `runtime-context.ts:165-179`);
  3. `Time sampled while preparing turn N, step M: …` (`<pkgs>\dsh-time-context\src\index.ts:110`).
- Wire shape of a user message (`<pi>\anthropic-messages.js:1087-1120, 1218-1242`; `openai-completions.js:931-963`; `openai-responses-shared.js:146-173`):

```text
anthropic-messages : {role:"user", content:"<text>"}
                     last user message: content:[{type:"text", text, cache_control}]
openai-completions : {role:"user", content:"<text>"}
openai-responses   : {role:"user", content:[{type:"input_text", text}]}
```

- Prefix filtering is heuristic, not safe identification: typed text can imitate injected messages, and notices may also be user-role messages. Fail closed; do not authorize paid work from inferred text.
- A Host plugin can stamp `purpose` and session ID via `llm-pi-ai/request-headers` (`<pkgs>\dsh-llm-pi-ai\src\adapter.ts:249-267`, `index.ts:114,242`); it does not identify individual user messages.

Not verified: system prompt and tool schema sizes (this session carries about 60 tools).

## 4. Other calls to the picked model

Title generation hits the picked model on the first message. Compaction, retries and several injected messages can too.

| Occasion | Model | How to tell |
|---|---|---|
| Session title | same route as the first request, concurrent with it | no tools; system starts `Create a concise title for an AI coding-assistant session`; user text starts `Generate the session title from this JSON array of human messages:` |
| Compaction | session model unless configured | last user message starts `You are now acting as a compaction engine` |
| Goal round | session model | `<goal_round>` |
| Scheduled task | session model | `[SCHEDULE REMINDER]` |
| Subagent, fork | parent route unless pinned | none |
| Automatic retry, manual continue | same | can replay the original input; no reliable wire marker |

- Title: `<pkgs>\dsh-session-title-llm\src\index.ts:184-195, 252-272`; `<pkgs>\dsh-session-title-first-prompt-llm\src\index.ts:81-94`. The answer's first line becomes the title; single attempt, 60 s limit.
- Compaction: `<pkgs>\dsh-compaction-basic\src\summarizer.ts:32, 120-163`.
- Goal, schedule: `<pkgs>\dsh-goal-round-driver\src\prompt.ts`; `<pkgs>\dsh-schedule\src\domain.ts:1152-1168`.
- Subagents: `<pkgs>\dsh-tool-subagent\src\model-selection.ts:173-192`.
- Manual continue: an empty user message, dropped on the wire (`<pkgs>\dsh-api-session-controller\src\commands.ts:324-334`).
- Token counting, warm-up, probes: none found.

Not verified: when a model switch triggers compaction; whether `dsh-experimental-auto-review` is mounted.

## 5. Request handling

Streaming is required. The default silent limit is 5 minutes, and a failed request is resent up to five times.

- `stream: true` is hard-coded (`<pi>\anthropic-messages.js:926`, `openai-completions.js:581`, `openai-responses.js:258`).
- Idle timeout: `streamIdleTimeoutMs`, result `TIMEOUT` (`adapter.ts:441-442, 505`). It resets only when a stream chunk reaches DSH (`adapter.ts:487`; `<pkgs>\dsh-timeout\src\index.ts:135-195`).
- Keep-alive: SSE comments and `ping` events are dropped before the timer (`<pi>\anthropic-messages.js:228-235, 255-257, 357-359`). Content deltas reset it (`anthropic-messages.js:560-571`).
- Time to response headers: Anthropic SDK default 10 minutes, around the fetch only (`@anthropic-ai\sdk\client.js:103, 663-675`); route `timeoutMs` overrides it (`adapter.ts:161`). No total deadline was found.
- Retries: default five, backoff 0.5 s to 10 s, on `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT`; `maxRetries: 0` is valid (`<pkgs>\dsh-llm\src\retry-policy.ts:92`; `<pkgs>\dsh-llm-retry\src\index.ts:212-231`). SDK retries are off (`adapter.ts:164`).
- Cancel aborts the request signal (`commands.ts:538`; `agent.ts:192-201`); the gateway sees a disconnect.

Not verified: the OpenAI paths' header timer; a stalled gateway.

## 6. Plain-text answer

Yes, a text-only answer ends the turn (`agent.ts:592-593`).

Minimum for `anthropic-messages`:

- `message_start` with a `usage` object (`anthropic-messages.js:497`);
- one text block with content, otherwise `EMPTY_RESPONSE` and a retry (`<pkgs>\dsh-llm-pi-ai\src\stream.ts:104-116`);
- `message_delta` with a stop reason, then `message_stop`, otherwise `TRANSPORT` and a retry (`anthropic-messages.js:375-377`; `stream.ts:66`);
- usage below `contextWindow`, otherwise `CONTEXT_WINDOW_EXCEEDED` (`stream.ts:82-100`).

## 7. Rendering in the Web GUI

Markdown renders. An mp4 URL is only a link; `<video>` shows as text; `https` images render.

- Block kinds: `text`, `reasoning`, `image` (attachments), `tool-call`; no video or file kind (`<pkgs>\dsh-client-ui-chat\src\client\chat\AssistantMarkdown.tsx:83-146`).
- Minified bundle `<pkgs>\dsh-web-frontend\dist\assets\index-Ciz7DZxv.js`:
  - `case"html"` returns the raw string;
  - images accept `http:` and `https:` only (`qW`), as `<img referrerPolicy="no-referrer">`;
  - links render as `<a target="_blank">` (`nk`, `iK`);
  - `createElement("video"` occurs 0 times.
- The file preview lists `mp4` as unviewable (`<pkgs>\dsh-client-ui-sidebar-documentpreview\src\client\document\unviewable.ts:10-12`).

Not verified: rendering in a browser; CSP response headers.

## 8. Better-fitting extension points

Yes. The best fit is the tool bundle already in this repository.

- `integrations\dsh-video\` registers `video_options`, `video_quote`, `video_submit`, `video_status` and asks approval per job through `userQuestions` (`index.js`, `lib\tools.js`). README: "Video is an action here, not a chat model"; "not installed and not verified inside a running Harness". This session's tool list does contain the four tools.
- Next to the picker, without a fake model: client slot `conversation.input.model.options` (`<pkgs>\dsh-client-ui-model-selection\src\client\slots.ts`), or a `/video` command through `ctx.commandUi` (`<pkgs>\dsh-client-ui-commands\README.md:12, 32`).
- If the entry must be in the model list: a Host plugin that owns the route, through `ctx.llm.registerAdapter` (`<pkgs>\dsh-llm\src\index.ts:416`) or the `llm/stream` waterfall (`index.ts:76, 1193-1198`). It sees `purpose` and each message's `source.kind`, so no text heuristics are needed; its own `listModels` may return `description` and `badge`.

Not verified: none of these was built or loaded.

## 9. `allowedModels`

It lists the routes an agent may explicitly choose for a subagent. Keep the video route out.

- Config of `subagent-model-selection-settings`: `enabled`, `allowedModels: [{provider, model}]` (`<pkgs>\dsh-tool-subagent\src\model-selection-settings.ts`); copied into each new top-level session, inherited by children.
- Here: `<profile>:349-367`, `enabled: true`, 14 routes (`dshproxy-openai`, `dshproxy-claude`, `dshproxy-lanes`).
- Explicit unlisted routes are rejected (`model-selection.ts:142-148`); omission may still inherit the parent route.

## Facts that make a video entry in the chat picker risky

- Title generation hits the same route; retries and continue can replay input.
- Five-minute idle limit; pings do not count.
- No no-tools flag or reliable user-text wire marker.
- Compaction, goals, schedules and forks can call the route.
- No inline video.

## Facts that make it workable

- Per-route timeout and retry settings; `maxRetries: 0` is valid.
- A header waterfall can stamp `purpose` and session ID.
- Text-only answers finish; progress deltas reset the idle timer.
- Links and HTTPS poster images render.
- Routes get group headings and need not be in `allowedModels`.
