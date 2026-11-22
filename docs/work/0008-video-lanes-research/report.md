# How video lanes should work in practice

Research of 2026-11-22. Parts: [mechanics](part1-mechanics.md), [practice](part2-practice.md), [failure economics](part3-economics.md). Nothing here is built; this is a recommendation.

## Answer

A video lane should not copy a chat lane. A chat lane is a ladder that moves down when a model is out of quota, and a repeated chat request costs little. A video job is a purchase: sending it twice can buy two clips. So a video lane should be a **purpose** (Draft, Final) holding an ordered list of model and billing route pairs, where the order is used only **before** a provider has accepted the job. After that, the lane tracks, resolves and downloads; it never resends on its own.

The current design (one route per model, one send, confirmation per job) is the right core. What is missing is everything around the send: a job record, a way to resolve an unclear send, result download, spend caps, and a choice of task and settings.

## Recommended behaviour

1. **A lane is a purpose.** Start with Draft and Final. Each holds ordered entries of model plus billing route. A model the user named is never swapped silently: Runway and fal's agent both treat a pinned model as final ([part 2](part2-practice.md)).
2. **Before sending: filter, then pick, then quote, then confirm.** Skip entries that cannot do the request, have no sign-in or key, or exceed the cap, and say which were skipped. This is how the documented automatic pickers work ([Runway routers](https://docs.dev.runwayml.com/model-routers/), fal Auto). Moving to another route needs a new quote and a new confirmation, because units do not compare across platforms (compute units, dollars, credits).
3. **One send per job.** No automatic move once the request has left. Only two sources document a safe repeat: [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/modalities/video-generation.md) and VideoRouter (below). Alibaba says "Do not create the task repeatedly; just poll for the result" ([reference](https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference)).
4. **Resolve an unclear send by route**, never by resending blind (table below). This needs a local job record written before the request leaves.
5. **A failed job is shown, not retried.** Show the cause and whether it cost anything, and offer "send again" with a new confirmation. For a content refusal, ask for a changed prompt: Krea says the same request "will most likely fail again" ([errors](https://www.krea.ai/docs/developers/errors-and-debugging.md)). Outages are long: of Runway's twelve latest incidents, three involving third-party models ran five to fifteen hours ([part 3](part3-economics.md)), so an automatic retry buys little.
6. **Download every result on completion and keep a local history.** Replicate removes API outputs "after an hour" ([retention](https://replicate.com/docs/topics/predictions/data-retention.md)); Alibaba and BytePlus links last 24 hours; Runway links "expire within 24-48 hours" ([outputs](https://docs.dev.runwayml.com/assets/outputs/)).
7. **Guards:** a daily cap per route in that route's own unit, fed by a local spend record (Krea: "There is no public endpoint for checking your balance programmatically", [billing](https://www.krea.ai/docs/developers/api-keys-and-billing.md)); a deadline per job with cancel while queued; one or two jobs in flight per route. No scheduler.
8. **Draft then final is two different things.** A linked draft keeps the take: Seedance 2.5 draft mode renders a 480p preview that can be finished later (VideoRouter `draft: true` with `draft_expires_at`; Runway and ComfyUI per [part 2](part2-practice.md)). A cheaper sibling model (Flash, Lite, Turbo) is a new clip. The Draft lane must say which one it is.
9. **Never switch on a provider's own hedging.** VideoRouter's `failover.on_timeout_sec` "resubmits to the next-cheapest untried host — both attempts get billed" ([provider selection](https://videorouter.sh/docs/provider-selection)). fal's fallbacks "are enabled by default for all accounts" ([reliability](https://fal.ai/docs/documentation/model-apis/inference/reliability.md)). DSHProxy already pins one host with `allow_fallbacks: false` and sends no `failover`.

## DSHProxy's five routes

Checked on each route's own pages on 2026-11-22. The three reseller routes were read as keyword excerpts, not in full; "not found" means not in those excerpts.

| Route | Resolving an unclear send | Charged on failure or refusal | Quote before send |
|---|---|---|---|
| `krea` | An error response at submit means "No job is created"; otherwise list jobs and match. No request id header exists. | "Failed and cancelled jobs are not billed." Cancel while queued or processing. | Preflight, flagged when estimated |
| `videorouter`, `videorouter-replicate` | `Idempotency-Key` header: same key and body replays the original job, "No new job, no new credit hold". A rejected create releases the key. | A created job that later fails "was refunded as usual"; exact rule not read | `max_price` ceiling; a job reports `output_expires_at` |
| `kovapi` | Nothing found | "Held at submit, refunded in full on failure." It may re-render on its own; "a job is charged once" | Not checked |
| `callirra` | "takes no idempotency key, so a dropped network can bill you twice"; reconcile with `GET /v1/videos` | Failed generations refunded automatically | `credits_reserved` in the submit answer |

Sources: [Krea errors](https://www.krea.ai/docs/developers/errors-and-debugging.md), [Krea lifecycle](https://www.krea.ai/docs/developers/job-lifecycle.md), [VideoRouter API](https://videorouter.sh/docs/api-reference-video), [KovAPI](https://docs.kovapi.com/minimax-h3), [Callirra contract](https://callirra.com/guides/minimax-h3/h3-api-mcp-cli-contract), [Callirra pricing](https://callirra.com/pricing).

Finding the three research parts missed: **VideoRouter documents an idempotency key**, so its route can repeat an unclear send safely. DSHProxy does not send that header today.

Upstream differences worth showing at confirmation: Runway keeps the credits on an input safety refusal ("credits are not refunded for SAFETY.INPUT", [task failures](https://docs.dev.runwayml.com/errors/task-failures/)); BytePlus charges only for "successfully generated videos" ([pricing](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing.md)); fal may charge a 422 ([FAQ](https://fal.ai/docs/documentation/model-apis/faq.md)).

## What not to build

- Automatic fallback to another model, or any move after a job is accepted.
- Switching route because a result looked weak. No product read describes it.
- Generic retry rules. LiteLLM lists "Fallbacks ✅ (Between supported models)" for [video](https://docs.litellm.ai/docs/videos.md) under its ordinary router rules; no page read says video creation is exempt.
- One cost unit across routes.

## The larger gap

Products are organised by task first (text to video, image to video, first and last frame, extend), and settings differ widely per model: durations, resolutions, whether audio costs extra, even how the ratio is written ([part 2](part2-practice.md)). DSHProxy has one preset: five seconds, 16:9, 720p, text only. Lanes will stay thin until a job can carry a task and settings, and each lane entry records what its model accepts.

## Suggested order

1. Job record, VideoRouter idempotency key, result download and local history.
2. Per-route facts at confirmation ("a refusal is charged here"), daily caps, deadline and cancel.
3. Draft and Final lanes with fallback before acceptance only.
4. Tasks and settings beyond the single preset.

## How far this was verified

- **Checked by the lead on the source page:** every quotation in this report, plus the Krea preflight, fal queue cancel and Replicate failed-run wording.
- **Workers only:** the product patterns in part 2, Runway incident lengths, concurrency ceilings, and the Replicate, Luma, MiniMax, Kling and Higgsfield rows.
- **Not verified:** Google Veo (documentation unreadable in all three parts); whether KovAPI has an idempotency key or a job list; cancel calls on the three resellers; output retention on Krea and KovAPI; the exact VideoRouter refund rule; Luma's newer API; Freepik, OpenArt, Adobe Firefly.
- **Contradiction:** Replicate's billing page says "if a run fails, we don't charge you" and, for models that call other models, "you will be billed for the duration of the run".
