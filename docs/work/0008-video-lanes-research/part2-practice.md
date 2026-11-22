# Part 2: practice (fetched 2026-11-22)

Budget used: 11 search queries, 41 fetches. Pages are undated unless a date is given.

## 1. Products

| Product | What the user picks first | Draft and final options | Model exposed or hidden | Cost shown how and when | Sources |
|---|---|---|---|---|---|
| Runway Dev (API) | A model on a task endpoint (text, image or video to video), or a router config ID instead of a model | Seedance 2.5 `draft: true` gives a 480p preview at 20 credits/s; `draftTaskId` enhances it to 1080p at 68 credits/s, charged separately, within 7 days. Sibling tiers: `gen4_turbo` 5 vs `gen4.5` 12 credits/s | Exposed; a router hides it, and the response names the model | Credits per second, $0.01 each, published table; router dry run gives estimated cost before, realised cost after | [pricing](https://docs.dev.runwayml.com/guides/pricing/), [models](https://docs.dev.runwayml.com/guides/models.md), [routers](https://docs.dev.runwayml.com/model-routers/) |
| ComfyUI partner nodes | A node, which is provider plus task ("Flux 3 Image to Video"), then model and resolution | "Seedance 2.5 Draft" 480p, then a "Draft to Final Video" node (4 s 1080p final 693.43 credits). Pruna P-Video-2 `draft` flag: 4.53 vs 7.54 credits/s at 720p | Exposed | Credits; a live badge on the node before the run, a range when inputs are unknown | [pricing](https://docs.comfy.org/tutorials/partner-nodes/pricing.md) |
| Krea | App menu lists tools by task (Video, Image to Video, Lipsync, Motion Transfer, Upscaler); API and MCP take a model ID such as `video/google/veo-3.1` | None on fetched pages; Upscaler is a separate tool | Exposed | Compute units; `preflight` quotes before submitting | [MCP docs](https://www.krea.ai/docs/developers/mcp.md), [site menu](https://www.krea.ai/mcp) |
| Luma | API: `model`, Ray 2 Flash or Ray 2. MCP: a pre-set workflow | Pair named; price difference not fetched | API exposed; the MCP page names workflows, not models | Plans in credits (10,000 to 150,000 a month) | [API](https://docs.lumalabs.ai/docs/video-generation.md) (updated 2026-07-10), [pricing](https://lumalabs.ai/pricing), [MCP](https://lumalabs.ai/mcp) |
| Kling | One model, Kling 4.0, with a capability table (text, image, first and last frame, keyframes, omni reference) | "4.0 Flash Mode", faster and cheaper. On Runway: `kling_4_flash` 9.4 vs `kling_4` 15.7 credits/s list at 720p | Exposed | Not on fetched page | [guide](https://kling.ai/quickstart/kling-4-model-user-guide) (2026-11-04), [Runway pricing](https://docs.dev.runwayml.com/guides/pricing/) |
| Magnific API (docs.freepik.com redirects here) | Docs group endpoints by task, then model (`image-to-video/kling-v2-6-pro`) | "Gen4 Turbo: fast video generation"; no linked draft | Exposed | "Credit-based pricing"; detail not fetched | [index](https://docs.magnific.com/llms.txt) |
| OpenArt | Plan, then "100+ premium" models; discounts are listed per model name | Fast and Mini variants listed | Exposed | Credits; "up to ~50 videos" for 4,000 credits | [pricing](https://openart.ai/pricing) |
| fal | API: an endpoint ID. fal Agent: an "Auto" chip unless a model is pinned with `@` | No linked draft seen; Sandbox compares models and estimates cost before running | Agent hides it unless pinned; API exposes | USD per video second, image or request; approval alert before, spend chip after | [index](https://fal.ai/docs/_llms/documentation.txt), [model choice](https://fal.ai/docs/documentation/agent/models-and-generation.md), [caps](https://fal.ai/docs/documentation/agent/spending-caps.md) |
| Replicate | A need ("for start/end frame control", "for fast iteration with draft mode"), then a model | PrunaAI p-video draft mode, "4× faster" previews; Fast, Lite and Turbo siblings | Exposed | Not on fetched page | [collection](https://replicate.com/collections/text-to-video) |

## 2. Patterns

- **Model is exposed; auto is opt-in.** Observed: Runway says to use a base model "when a use case should always run on one specific model"; fal Agent states "A pinned model is final. The agent does not substitute another model for it." Inference: a lane must never swap a pinned model.
- **Task travels with the model.** Observed: Runway endpoints, Magnific docs and Comfy nodes are per task; [Comfy Router](https://docs.comfy.org/development/comfy-router/quickstart.md) derives the operation from content roles. Inference: filter by capability before ranking.
- **Two "cheap first" mechanisms.** Observed: a linked draft (Seedance 2.5 on Runway and Comfy) reuses the draft's prompt, seed and duration; a sibling tier (Flash, Fast, Lite, Turbo, Mini on Runway, Kling, Luma, Replicate) is a fresh generation. Contradicting case: "Seedance 2.5 Flash has no draft mode". Inference: only a linked draft keeps the chosen take.
- **Siblings lose options.** Observed: Runway and Comfy both limit Seedance 2.5 Flash to 720p.
- **Quotes come with stated gaps.** Observed: Krea returns `is_estimated`; Comfy says an estimate of `0` means not priced rather than free; fal says "runs with an unknown cost never ask"; Runway `duration: "auto"` reserves 15 s, then settles. Inference: a confirmation needs a ceiling and an "unknown" state.
- **Units compare inside a platform, not across.** Observed: Runway and Comfy each price every model in one credit unit; Krea uses compute units, fal USD.
- **Automatic choice is filter, then rank.** Observed: the Runway router keeps enabled models that support the request under the price cap, then optimises cost, latency or quality, and fails with "no eligible model"; fal Auto follows "the task, the media type, the resolution, and whether references are attached". Inference: neither describes re-routing because a result looked weak.

## 3. Parameters that differ between models

- **Duration:** Kling 4.0 3–30 s; Seedance 2.5 4–30 s or `auto`; Gen-4 Turbo 5 or 10 s; Vidu Q1 fixed 5 s.
- **Resolution:** hailuo3 768P or 2K; Seedance 2.5 4K on Runway is set through a pixel `ratio`, not a `resolution` field.
- **Aspect ratio:** Runway routers take `aspectRatio: "16:9"`, direct endpoints `ratio: "1280:720"`, "not interchangeable". Seedance 2.5 first-frame requests refuse a concrete ratio with a 400.
- **Audio:** on by default at Runway; Kling 3.0 is cheaper without it; "Kling 4.0 includes audio and has no audio toggle"; `veo3.1` doubles from 20 to 40 credits/s.
- **Billed inputs and minimums:** `seedance2_5` charges per second of reference video; `seedance2` has a 56-credit minimum.
- **Camera:** Luma uses prompt language plus `concepts` keys; Kling 4.0 multi-shot is written in the prompt.
- **Dropped fields:** Comfy Router reports them in `X-Comfy-Router-Dropped-Params`.

## 4. Agent and automation guards

- **Krea MCP:** `list_models` and `get_model_schema` before `generate`; `preflight: true` creates no job and returns `compute_units`, `available_compute_units`, `affordable`. OAuth bills the workspace chosen at consent; an API token bills a separate balance. No allow-list or budget is documented.
- **Runway:** routers have an allow or deny list and a "maximum credits per generation" per modality. `dryRun: true` is not billed; the [tool loop](https://docs.dev.runwayml.com/model-routers/generating.md) keeps dry-run and live payloads identical. The [Dev MCP](https://docs.dev.runwayml.com/guides/mcp/) says: "Do not ask an agent to automate the sign-in".
- **fal Agent:** safety cap default $5; confirmation on for video and audio, off for images; no further submits while one awaits approval. Organisations have model access controls and spending controls that "block new requests".
- **[Comfy Cloud MCP](https://docs.comfy.org/agent-tools/mcp.md):** `estimate_credits` prices API nodes only; the live balance tool is off by default. No confirmation or budget is documented.
- **Replicate [MCP](https://replicate.com/docs/reference/mcp.md):** exposes the whole HTTP API; model choice is left to the assistant, guided by [skills](https://replicate.com/docs/reference/skills.md) such as `compare-models`. No spend guard is documented.
- **Failover:** fal's index describes fallback chains for "one synchronous request"; Comfy Router states "the queued route has no fallback".

## 5. Unverified

- Google Flow and Veo in Gemini, Adobe Firefly partner models, Higgsfield, and Luma Ray3 draft mode: the fetched pages returned a title or navigation only, so nothing is reported.
- Runway, Kling, Freepik and OpenArt consumer apps: per-generation costs and any "Auto" picker.
- Replicate and Magnific per-model prices.
- Negative prompt, prompt enhancement and variation count for video: not seen on any fetched page.
- n8n and the generation MCP at mcp.runwayml.com: not fetched.
