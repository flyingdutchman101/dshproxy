# Part 1: mechanics (fetched 2026-11-22)

| Provider | Idempotency on submit | Look up or list after unclear submit | Cancel | Charged when, and on failure | Pre-submit price or balance call | Sources |
|---|---|---|---|---|---|---|
| fal.ai queue | not documented (no key among submit parameters) | status by server `request_id`; docs index lists "List requests by endpoint(s)" | `PUT …/cancel`: queued is removed; in progress "can still complete"; charge not documented | "Server errors (HTTP 500+) are never charged"; 422 "may still be charged" | index lists "Estimate cost", "Account Billing" | [queue](https://fal.ai/docs/documentation/model-apis/inference/queue.md), [submit](https://fal.ai/docs/api-reference/inference-api/queue/submit.md), [FAQ](https://fal.ai/docs/documentation/model-apis/faq.md), [index](https://fal.ai/docs/llms.txt) (undated) |
| Replicate | not documented (headers shown: `Prefer`, `Cancel-After`) | `GET /v1/predictions`, get by id | cancel URL; `Cancel-After` 5 s to 24 h; aborted "No charge", canceled pays time run | "if a run fails, we don't charge you"; private models and deployments billed anyway | not documented | [create](https://replicate.com/docs/topics/predictions/create-a-prediction.md), [lifecycle](https://replicate.com/docs/topics/predictions/lifecycle.md), [billing](https://replicate.com/docs/topics/billing.md) (undated) |
| Runway | not documented in pages read | `GET /v1/tasks/{id}`; no task list in reference index | `DELETE /v1/tasks/{id}`; charge not documented | "Moderated generations cost the same as successful ones" | router `dryRun: true` returns estimated cost unbilled; `/v1/organization` credit balance | [primer](https://docs.dev.runwayml.com/ai-context.md), [routers](https://docs.dev.runwayml.com/_llms-txt/model-routers.txt), [reference](https://docs.dev.runwayml.com/api/) (undated) |
| Luma (legacy Dream Machine API) | not documented | get by id; list `?limit=&offset=` | only "Delete generation" | not checked | not checked | [guide](https://docs.lumalabs.ai/docs/video-generation) ("Updated 4 months ago") |
| Google Veo | not checked | not checked | not checked | not checked | not checked | docs unreachable, see below |
| OpenAI | no API: "shut down on September 24, 2026" | n/a | n/a | n/a | n/a | [guide](https://developers.openai.com/api/docs/guides/video-generation.md) |
| MiniMax | not documented (no such schema field) | by `task_id`; list not documented | not documented | not checked | not checked | [T2V](https://platform.minimax.io/docs/api-reference/video-generation-t2v.md) (undated) |
| Alibaba Wan | not documented; "Do not create the task repeatedly; just poll" | `GET /api/v1/tasks/{task_id}`, valid 24 h, then `UNKNOWN`; Java SDK sample lists tasks | `CANCELED` status exists; call not on page | billed per second; failures not on page | not checked | [Wan2.7-T2V](https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference) (Nov 20, 2026) |
| BytePlus ModelArk | not checked | not checked | `DELETE …/tasks/{id}`: `queued` becomes `cancelled`; `running` cannot | not checked | not checked | [cancel](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/cancel-or-delete-video-generation-tasks-api.md) (undated) |
| Krea API and MCP | not documented in pages read; "There is no Krea request-id header" | `GET /jobs/{id}`, `GET /jobs`; MCP `get_job` | `DELETE /jobs/{id}` while queued or processing; MCP `cancel_job` | "Failed and cancelled jobs are not billed. You only pay for completed jobs." | MCP `preflight: true` returns `compute_units`, `available_compute_units`, `affordable`; no job created | [lifecycle](https://www.krea.ai/docs/developers/job-lifecycle.md), [errors](https://www.krea.ai/docs/developers/errors-and-debugging.md), [MCP](https://www.krea.ai/docs/developers/mcp.md) (undated) |
| OpenRouter | not documented (no key in request table) | `GET /api/v1/videos/{jobId}`; no list endpoint | no endpoint; `cancelled` status exists | `usage.cost` on completed job; failures not documented | `GET /api/v1/videos/models` returns `pricing_skus` | [videos](https://openrouter.ai/docs/api_reference/videos.md) (undated) |
| LiteLLM | not documented | `/v1/videos/{id}`; list needs `custom_llm_provider` | not documented | provider's | not documented | [videos](https://docs.litellm.ai/docs/videos.md), [reliability](https://docs.litellm.ai/docs/router/learn/reliability.md) (2026-11-21) |
| Vercel AI Gateway | yes: "the SDK sends a stable `idempotency-key` header on the start request and AI Gateway deduplicates on it"; expiry not documented | `experimental_getVideoStatus` with persisted `operation` or `jobId` | not documented | not on page; needs $10 credit balance | not on page | [video](https://vercel.com/docs/ai-gateway/modalities/video-generation.md) (2026-09-08) |

## What this permits

- **Status polling is repeatable.** Observed: every provider read exposes a GET by job id. Inference: polling is the safe response to any unclear state once an id is held.
- **Blind resubmit is unsafe on every direct provider read.** Observed: only Vercel AI Gateway documents a submit idempotency key; Alibaba says not to create the task repeatedly. Inference: keep "send once" for fal, Replicate, Runway, Luma, MiniMax, DashScope, Krea and OpenRouter.
- **A lost submit response can be resolved by listing on some lanes.** Observed: Replicate, Luma, Krea and DashScope (SDK) list jobs; Runway and OpenRouter show no list. Inference: matching must use time and prompt, since no id is client-chosen.
- **Krea is the one lane where an HTTP error response permits a resubmit or lane switch.** Observed: "Request-time errors return a `4xx` or `5xx` status. No job is created." Inference: a timeout with no response is still unclear; check `GET /jobs` first.
- **Fallback after a confirmed terminal failure costs nothing extra only on some lanes.** Observed: Krea and Replicate public models do not bill failures, and fal does not bill 5xx. Runway bills moderated jobs, and fal 422 may be billed.
- **Content refusals should not be retried unchanged.** Observed: Krea says `content_policy` "will most likely be rejected again"; fal calls it non-retryable; OpenRouter says "do not retry without parameter changes".
- **Over-concurrency is usually a queue state.** Observed: Runway returns `THROTTLED`, fal queues, and Krea returns `backlogged` or a 429 `CONCURRENCY_LIMIT_REACHED` with no `Retry-After`. Quota rejections are Runway 429 (daily limit), [Replicate 429](https://replicate.com/docs/topics/predictions/rate-limits.md) (600 creates per minute), Krea 402, MiniMax `1002`/`1008`/`1026`. [Runway](https://docs.dev.runwayml.com/errors/errors.md) marks 429/502/503/504 "May retry? Yes" and [limits concurrency per tier](https://docs.dev.runwayml.com/usage/tiers.md). Inference: treat queue states as waiting; a Runway 504 on submit may still have created a task.
- **Existing routers do not model double purchase, except Vercel.** Observed: LiteLLM lists `/videos` "Fallbacks ✅" under generic rules that retry 408, 429 and 5xx. Runway's router picks a model before submit only. fal has an `x-app-fal-disable-fallback` header. Inference: automatic fallback is defensible only before a job is accepted.

## Unverified or contradicted

- **Google Veo:** `ai.google.dev` redirected to a sign-in and the Vertex Veo reference redirected to a generic predict page. Nothing verified.
- **Replicate contradicts itself** on [billing](https://replicate.com/docs/topics/billing.md): "if a run fails, we don't charge you" versus "If the model fails, you will be billed for the duration of the run" for models that call other models.
- **fal:** list-requests, estimate-cost and billing APIs were seen only as index entries. The [concurrency page](https://fal.ai/docs/documentation/model-apis/concurrency-limits.md) was not opened.
- **Runway and Krea:** the full API references were not read, so the absence of an idempotency header is unconfirmed. A REST equivalent of Krea's `preflight` was not checked.
- **BytePlus:** create, list, limits and charging were not read; a list endpoint appeared only in a search snippet.
- **Luma:** the page read is the older API; its banner points to [Luma Agents API docs](https://docs.agents.lumalabs.ai/), not checked.
- **OpenRouter:** whether `provider.order` re-routes a job after a provider failure is not stated.
- **LiteLLM:** no page says whether video creation is exempt from router retries.
- **Result expiry (read but not tabled):** DashScope URLs and task ids last 24 hours, fal media at least 7 days, Runway URLs are "temporary".

## Follow-up

Fetched 2026-11-22, 10 fetches. The two rows above for Google Veo and BytePlus ModelArk are superseded by this section.

### (a) Google Veo long-running operations

Prose documentation could not be read. `ai.google.dev/gemini-api/docs/video` redirects to `aistudio.google.com`; [aistudio.google.com/docs/video](https://aistudio.google.com/docs/video) returned only its title ("Video generation in the Gemini API"). The Vertex AI page redirects to [docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-text](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-text), which returned navigation only. No sign-in was attempted.

The only readable primary source was the machine-readable [Gemini API discovery document, v1beta, revision 20261121](https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta). The fetch was truncated, so only the method list below was read.

| Question | Observed in the discovery document |
|---|---|
| Submit | `models.predictLongRunning`, `POST v1beta/{+model}:predictLongRunning`, marked `"deprecated": true`: "Deprecated: Same as Predict but returns an LRO. Use the Interactions API instead." |
| Idempotency on submit | The only declared parameter is the path parameter `model`. No request-id query parameter. The body schema `PredictLongRunningRequest` was past the truncation and was not read. |
| Look up | `models.operations.get`, `GET v1beta/models/{model}/operations/{operation}`: "Gets the latest state of a long-running operation." |
| List | `models.operations.list`, `GET v1beta/models/{model}/operations` with `filter`, `pageSize`, `pageToken`: "If the server doesn't support this method, it returns `UNIMPLEMENTED`." |
| Cancel | No `cancel` method under `models.operations`. In the part read, `cancel` appears only under `batches`. |
| Charged when | not verified |
| Price or balance call | not verified |

- Inference: an unclear Veo submit on the Gemini API may be resolvable by listing operations for the model, but the document itself allows the server to answer `UNIMPLEMENTED`, so this must be tested before a lane depends on it.
- Inference: a submitted Veo operation cannot be cancelled through this API surface.
- Not checked: the "Interactions API" that replaces `predictLongRunning`. A lane built on `predictLongRunning` targets a deprecated method.
- Vertex AI: the [Vertex discovery document](https://aiplatform.googleapis.com/$discovery/rest?version=v1) was fetched but truncated before any publisher-model method. Nothing verified for Vertex (submit, `fetchPredictOperation`, cancel, charging).

### (b) BytePlus ModelArk video generation

| Question | Observed | Source |
|---|---|---|
| Submit | `POST https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks`; response is `{"id": "cgt-…"}` | [create](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/create-video-generation-task-api.md) (undated) |
| Idempotency on submit | None. The full request parameter list is `model`, `content`, `omni_reference_task_type`, `resolution`, `ratio`, `duration`, `frames`, `generate_audio`, `watermark`, `output_format`, `seed`, `camera_fixed`, `return_last_frame`, `draft`, `service_tier`, `callback_url`, `execution_expires_after`, `priority`, `safety_identifier`. No client token or request id. | create |
| Client-chosen fields echoed back | `seed` and `safety_identifier` are returned on each task. `safety_identifier` "must be fixed and unique for a single user", so it is an end-user id, not a request id. | create, [list](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/list-video-generation-tasks-api.md) |
| List | `GET …/contents/generations/tasks` with `page_num`, `page_size` (1 to 500), `filter.status`, `filter.task_ids`, `filter.model`, `filter.service_tier`. No time or prompt filter. Items carry `id`, `model`, `status`, `created_at`, `updated_at`, `seed`, `resolution`, `ratio`, `duration`, `usage`. The input prompt is not among the documented item fields. | list (undated) |
| Retention | Task ids "Valid for seven days" (draft task ids 14 days). "Video URLs are valid for 24 hours." Seedance 2.5 output URLs "can be downloaded up to 100 times". "Canceled task records are automatically deleted after 24 hours." | list |
| Timeout | `execution_expires_after` default 172800 s (48 h), range `[3600, 259200]`; the task is then "automatically terminated and marked as `expired`". | create |
| Webhook | `callback_url` receives a POST on each status change; for `succeeded` and `failed`, if no confirmation "within 5 seconds, the callback is retried three times". | create |
| Cancel | Only `queued` tasks; `running` cannot be cancelled (already in the table above). | [cancel](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/cancel-or-delete-video-generation-tasks-api.md) |
| Charged when | "You are only charged for successfully generated videos. No fee is charged if generation fails due to reasons such as content moderation." Actual cost follows `usage.completion_tokens`. | [pricing](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing.md) (undated) |
| Pre-submit price or balance | No API. A published formula: `(Input video duration + output video duration) × output video width × output video height × output video frame rate / 1024` tokens, times the token price. Seedance 2.0 and 2.5 apply a minimum token consumption when the input includes video. Calculators are external web forms. | pricing |
| Limits | RPM and TPM per model, shown per account on the console; service is suspended after 2 hours in arrears. Error codes were not read. | pricing |

- Inference: BytePlus is a second lane, after Krea, where fallback after a confirmed `failed` or `expired` task costs nothing extra, because only successful videos are charged.
- Inference: an unclear submit can be resolved without resubmitting by listing with `filter.model` and comparing `created_at`. If the router sends an explicit `seed`, the echoed `seed` gives a stronger match; the documentation does not say seeds are unique, so this is a correlation aid, not an idempotency key.
- Inference: a blind resubmit is unsafe, since nothing deduplicates two identical create calls.
- Not verified: whether an `expired` or cancelled task is ever charged (the pricing sentence names only failure), the error codes for quota and concurrency, and the concurrency numbers (on the model list page, not read).
