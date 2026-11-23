# Krea's live interface, as observed on 2026-11-22

Recorded by the lead from the user's signed-in workspace (PLAN-REMOVED) between 14:50 and 15:46 local time, with one-off scripts that printed shapes and numbers only. No token, session id, workspace id or e-mail is in this file. The sign-in expired at 15:48, so nothing here can be re-read without a new sign-in.

Purpose: the test fixtures for the helper fix must be built from these shapes, not from the synthetic responses the shipped helper was tested against (which did not match).

## Why the shipped helper fails

`dshproxy video quote MODEL krea --prompt ...` answered "Krea refused the request; the exact schema, budget, or workspace requirements were not met." for all four models, each within one second.

| Shipped helper assumes | Live interface |
|---|---|
| tool `generate` | no such tool; video is `generate_video` (images `generate_image`, others `generate_3d`, `generate_audio`, `enhance_video`) |
| model ids `video/bytedance/seedance-2-5` and so on | ids have no `video/` prefix; the prefixed form is the schema's `endpointPath` |
| protocol version `2025-06-18` | the server answers `initialize` with `protocolVersion: 2025-11-25` (it accepted a request that asked for `2025-06-18`, and later calls sent with the returned version worked) |
| closed schema check on tool arguments | `generate_video.inputSchema.properties.input` is `{type: object, propertyNames: {type: string}, additionalProperties: {}}`; tools carry `title`, `annotations`, `outputSchema`, `execution`, some `_meta`; `inputSchema` carries `$schema` |
| every model has `resolution` | `minimax/hailuo-3` has none |

## Transport

- `POST https://api.krea.ai/mcp`, JSON-RPC 2.0, `authorization: Bearer`, `accept: application/json, text/event-stream`.
- Every answer observed was `application/json` (never an event stream), HTTP 200. `notifications/initialized` answered HTTP 202 with an empty body and no content type.
- `initialize` returns a `Mcp-Session-Id` header; later answers do not repeat it. Result keys: `protocolVersion`, `capabilities` (`tools`, `prompts`, `resources`, `extensions`), `serverInfo` (`name`, `title`, `version`, `websiteUrl`, `icons`), `instructions`.
- `tools/list`: 95 tools in one answer of about 210,000 characters, no `nextCursor`. The helper's 1 MB limit is enough today.
- A tool result has `content` (one `text` item) and `structuredContent`; `isError: true` appears on refusals, and is absent (not `false`) on success.

## Tools used

`list_models` — arguments: optional `category`, enum `image | video | enhance | 3d | audio`. Result `{models: [{id, category, name, description}]}`, 115 models in all, 44 with `category: video`, no cursor.

Video ids seen for the families of interest: `bytedance/seedance-2-5`, `bytedance/seedance-2-5-flash`, `bytedance/seedance-2`, `bytedance/seedance-2-fast`, `bytedance/seedance-2-mini`, `minimax/hailuo-3`, `minimax/h3-max`, `minimax/h3-max-turbo`, `alibaba/wan-3.0`, `alibaba/wan-3.0-prime`, `black-forest-labs/flux-3-video`, `black-forest-labs/flux-3-max`, `black-forest-labs/flux-video-edit`.

`get_model_schema` — argument `model` (string, required). Result keys `model`, `category`, `name`, `description`, `endpointPath`, `inputSchema`, `outputSchemas`. An unknown id gives `isError: true` with `{error, model}`.

`generate_video` — arguments: `model` (required), `input` (required object), `sync` (boolean, default false), `timeoutSeconds` (integer 1 to 300, default 30), `preflight` (boolean, default false). Tool text: preflight returns "a compute-unit cost quote and the available balance instead of submitting. Nothing is queued or charged"; with `sync` and a timeout "call get_job with that job_id instead of submitting again, because every submission is charged". `annotations: {readOnlyHint: false, openWorldHint: true, destructiveHint: false}`, `execution: {taskSupport: forbidden}`.

Output properties declared: `mode` (`async | sync | preflight`), `completed`, `timedOut`, `job_id`, `job` (`job_id`, `status`, `type`, ...), `message`, `next_tool_call`, `model`, `category`, `compute_units` (number or null), `is_estimated`, `available_compute_units`, `affordable`, `error`, `status` (integer).

- Preflight answer, keys exactly: `mode, model, category, compute_units, is_estimated, available_compute_units, affordable`. `mode: preflight`, no job field.
- Submit answer (`preflight: false`, async), keys exactly: `mode, completed, timedOut, job_id, job`. `mode: async`. `job.status` was `scheduled` on two Seedance 2.5 jobs and `queued` on the Flux 3 job. `job_id` is a UUID.
- A bad input gives `isError: true` with `error` text such as `Invalid input for black-forest-labs/flux-video-edit: ✖ Invalid input: expected string, received undefined → at start_video`, and no job field.

`get_job` — argument `jobId` (string, required; note the camel case, while results use `job_id`). `readOnlyHint: true`. Result required keys `job_id`, `status`, `type`; also `created_at`, `completed_at`, `position`, `result`, `error`, `progress`.

- Statuses seen: `scheduled`, `queued`, `processing`, `completed`. `progress` rises from 0 to about 0.75 as a number and is `null` when completed. `position` was `0` once right after queueing and otherwise absent.
- Completed: `type: videoV2`, `result: {urls: [one https link to an mp4 on app-uploads.krea.ai/public/]}`. No cost field anywhere in the job.
- `error` is declared as `{code, ...}`; `invalid_request` is one documented code. No failed job was observed.

`get_balance` — no arguments, `readOnlyHint: true`. Result: `{plan: {id, name, tier, billing_period, is_paid, monthly_compute_units}, compute_units: {total, plan, purchased, free}}`. Observed: name PLAN-REMOVED; units total BALANCE-REMOVED = plan BALANCE-REMOVED + purchased BALANCE-REMOVED + free 0. No reset date, no history, no per-model limit.

`list_workspaces` — no arguments. `{workspaces: [{id, name}], selected_workspace_id}`; one workspace here. `select_workspace` (`workspace_id`, a UUID) changes the billing context of the connection; not called.

## Model input schemas (fields relevant to a text-only clip)

All four below have `type: object`, `additionalProperties: false`, and optional reference fields (`start_image`, `end_image`, `reference_images`, `reference_videos`, `reference_audios`) written as `anyOf: [{type: string, maxLength, format: uri, description}, {type: null}]` or arrays with `maxItems`.

| Model id | required | `resolution` | `duration` | `aspect_ratio` | other |
|---|---|---|---|---|---|
| `bytedance/seedance-2-5` | none; a top-level `anyOf` is present | enum `480p, 720p, 1080p, 4k`, default `720p` | number, 4 to 30, default 5 | enum `16:9, 4:3, 1:1, 3:4, 9:16, 21:9`, default `16:9` | `prompt` string; `seed`, `generate_audio` (deprecated), `effects`, `enhance_prompt` (default false), `draft`, `draft_job_id` |
| `bytedance/seedance-2` | `prompt` | enum `480p, 720p, 1080p, 4k`, default `720p` | number, 4 to 15, default 5 | same enum, default `16:9` | `seed`, `generate_audio` (deprecated), `effects`, `upscale`, `enhance_prompt` |
| `minimax/hailuo-3` | `prompt` (1 to 7000 chars) | absent | integer, 5 to 15, default 5 | enum `adaptive, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16`, default `16:9` | `reference_video_seconds`; described as "Frontier 2K model" |
| `alibaba/wan-3.0` | `prompt` (1 to 5000 chars) | enum `480p, 720p, 1080p`, default `720p` | integer, 2 to 30, default 5 | enum `adaptive, 16:9, 4:3, 1:1, 3:4, 9:16`, default **`adaptive`** | `seed`, `generate_audio` (default true), `enable_prompt_expansion` (default true) |
| `black-forest-labs/flux-3-video` | `prompt` | enum `720p, 1080p, 1440p, 2160p`, default `720p` | integer, 5 to 20, default 5 | enum `21:9, 2:1, 16:9, 4:3, 1:1, 3:4, 9:16`, default `16:9` | `start_image`, `start_video`, `end_image`, `generate_audio` (default true) |
| `black-forest-labs/flux-3-max` | `prompt` | enum `720p, 1080p`, default `720p` | integer, 5 to 20, default 5 | enum with `auto`, default `16:9` | `seed`, `reasoning_level`, `keyframes` |

## Quotes (free preflights), 5 s, 16:9, text only

Input sent: `{prompt, duration: 5, aspect_ratio: "16:9", resolution}` (no `resolution` for `minimax/hailuo-3`). All answers `is_estimated: false`, `affordable: true`.

| Model id | 480p | 720p | 1080p |
|---|---|---|---|
| `alibaba/wan-3.0` | 277.77777777777777 | 555.5555555555555 | 1111.111111111111 |
| `bytedance/seedance-2` | 248.8111111111111 | 560 | 1385.9999999999998 |
| `bytedance/seedance-2-5` | 380.33333333333326 | 856 | 2106 |
| `minimax/hailuo-3` | 481.48148148148147 (no resolution setting) | | |
| `black-forest-labs/flux-3-video` | not offered | 629.6296296296297 | 1074.0740740740741 |
| `black-forest-labs/flux-3-max` | not offered | 629.6296296296297 | 1074.0740740740741 |

Compute units are fractional numbers, not integers.

## Paid jobs and what was charged

| Job | Quote | Balance before | Right after submitting | After completion | Net charge | Time to complete | Clip (ffprobe) |
|---|---|---|---|---|---|---|---|
| `bytedance/seedance-2-5`, 720p, fox prompt | 856 | BALANCE-REMOVED | not read | BALANCE-REMOVED | 830.32 | 2 min 20 s | 1280x720, 24 fps, 5.04 s, H.264 + AAC |
| `bytedance/seedance-2-5`, 720p, "A cat eating ice cream." | 856 | BALANCE-REMOVED | BALANCE-REMOVED | BALANCE-REMOVED | 830.32 | 2 min 19 s | 1280x720, 24 fps, 5.04 s, H.264 + AAC |
| `black-forest-labs/flux-3-video`, 720p, same prompt | 629.63 | BALANCE-REMOVED | BALANCE-REMOVED | BALANCE-REMOVED | 629.63 | 70 s | 1280x704, 24 fps, 5.04 s, H.264 + AAC |

- The quote is held at submission. Seedance 2.5 returned 25.68 units (3.00%) at completion, twice; Flux 3 returned nothing. A cap has to be compared with the quote, and the final charge can only be read as a balance difference.
- The Krea app shows the same 856 units for Seedance 2.5 at 5 s 720p (user's check).

## Sign-in

- Public metadata: one authorization server `https://www.krea.ai`, endpoints under `/auth/v1/oauth/` (`authorize`, `token`, `clients/register`), `code_challenge_methods_supported: S256`, `response_types_supported: code`, `grant_types_supported: authorization_code, refresh_token`, `token_endpoint_auth_methods_supported: client_secret_basic, client_secret_post, none`, scopes `profile email`.
- The helper's registration (public client, loopback redirect), consent and token exchange worked on the user's first try from the app.
- The token lasted exactly one hour (`expires_in` 3600). The helper registers with `grant_types: [authorization_code]` only, so no renewal was possible. Whether the token answer carried a `refresh_token` was not looked at.

## Not observed

- A failed, cancelled or rejected-by-moderation job; an unaffordable preflight; an expired token's answer; a rate limit; a second workspace.
- `sync: true`. Event-stream answers.
- What a refresh grant returns.
