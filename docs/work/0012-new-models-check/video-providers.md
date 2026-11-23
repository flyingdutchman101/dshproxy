# Video providers: new text-to-video models and changes to our five

Checked on 2026-11-22 (evening, Europe/Paris). Read-only web research over public pages and public unauthenticated catalog files. No sign-in, no API key sent, no paid call. Catalog endpoints that need a key were requested once without one, answered 401, and were left alone.

Our catalog: Seedance 2.5, Seedance 2.0, Wan 3.0, MiniMax H3 (Hailuo 3), Flux 3 video (being added).

Every item below is marked **seen** (with the provider URL it was read from) or **not found / could not open** (with what was tried). Nothing is filled in from memory or from third-party pages.

## Read this first

1. **`https://videorouter.ai` is not the service.** It answers HTTP 200 with a "Buy Domain" landing page ("VideoRouter.AI ... First come, first served", a listed price and a countdown). It has no model list, docs or API. The service our catalog already points at is `https://videorouter.sh`; everything in the VideoRouter section comes from that host.
2. **None of our five was renamed or retired at any of the four providers.** All ids our code uses still resolve, and the per-clip prices recorded in `src/video/catalog.js` (verified 2026-11-21) still match today's pages.
3. **Newer siblings of our models exist at several providers:** Seedance 2.5 Flash, Wan 3.0 Prime, MiniMax H3 Max / H3 Max Turbo / H3 Lite, FLUX 3 Max. No provider page showed a successor generation (no Seedance 3, Wan 3.x, H4 or Flux 4 was seen).
4. **Two things worth a second look in our own code** (found while comparing, not changed):
   - Krea's `video/minimax/hailuo-3` ("MiniMax H3") request schema has **no `resolution` field** and Krea describes it as a "2K model", while `src/video/krea-preset.js` pairs it with `768p`. On Krea, 480p/768p/1080p belong to `minimax/h3-max` and `minimax/h3-max-turbo`. The MCP schema was not readable without sign-in, so this is from the public REST OpenAPI only.
   - Krea's Seedance 2.5 schema marks `generate_audio` as "Deprecated and ignored. Accepted until 2026-10-30T00:00:00Z, then rejected."
5. Krea prices below are **API-balance dollars** from Krea's public OpenAPI and API pricing page. Our Krea route uses the OAuth MCP, billed in **compute units**; no public page gives compute units per video model.

## 1. VideoRouter

Sources opened:

- seen: <https://videorouter.ai> (parked domain, see above)
- seen: <https://videorouter.sh/llms.txt> (index of public pages)
- seen: <https://videorouter.sh/pricing-index.json> (public, no key; `"generated":"2026-11-22"`, 186 video entries; prices are "each provider's list price BEFORE VideoRouter's platform fee")
- seen: <https://videorouter.sh/models?out=video> (catalog page; filter shows "Text-to-Video 111")
- seen: model pages under `https://videorouter.sh/video/<creator>/<model>` and host pages `.../<host>` for the models named below
- seen: <https://videorouter.sh/docs/video-generation>
- **401 without a key** (not retried): `https://videorouter.sh/api/v1/videos/models`, `/api/v1/models`, `/v1/models`, `/api/models`. Body: "Missing or invalid API key".

### 1a. Full text-to-video list (112 entries tagged `text-to-video` in the price index)

How to read the table:

- "Price" is the index's own `best_price` at its `reference_tier`, from the cheapest host that VideoRouter routes to.
- "5 s incl. fee" is the index's `best_price_with_platform_fee` times 5. It is at 720p only when the reference tier says 720p; otherwise the tier is the one shown.
- The mode tags are the index's. Several entries are tagged `text-to-video` although their names say otherwise (`...-i2v`, `...-r2v`, `wan-2.7-image`, `Wan2.2-I2V-A14B`, the HeyGen avatar entries). They are listed because the index lists them; treat those tags as unreliable.
- The catalog page counts 111 text-to-video models, the index 112. The one-entry difference was not traced.
- No release or listing date is shown on any VideoRouter page opened. The catalog has a "Release date: newest" sort but prints no dates.
- Durations: model pages do not state a per-model limit. The playground's duration field is `min=1 max=15 default=5` on all 16 model pages sampled, so it is a generic control, not a model limit.

| VideoRouter id | Creator | Mode tags (index) | Resolution tiers across hosts | Price (cheapest routed host) | 5 s incl. fee | Hosts | Catalog |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `heygen-avatar-6` | not stated | text-to-video | 1080p, 1440p | $0.1/second at 1080p, openrouter | $0.5125 (at 1080p) | 1 | no |
| `heygen-avatar-6-turbo` | not stated | text-to-video | 1080p, 1440p | $0.05/second at 1080p, openrouter | $0.2563 (at 1080p) | 1 | no |
| `seedance-2-5-flash-unrestricted` | not stated | text-to-video | 480p, 720p | $0.13608/second at 720p, opensand | $0.6974 | 1 | no |
| `alibaba/happyhorse-1.0` | Alibaba | text-to-video, image-to-video, reference-to-video | 720p, 1080p | $0.098/second at 720p, pika | $0.5023 | 3 | no |
| `alibaba/happyhorse-1.0-i2v` | Alibaba | text-to-video | 720p, 1080p | $0.14/second at 720p, together-ai | $0.7175 | 1 | no |
| `alibaba/happyhorse-1.0-r2v` | Alibaba | text-to-video | 720p, 1080p | $0.14/second at 720p, together-ai | $0.7175 | 1 | no |
| `alibaba/happyhorse-1.0-t2v` | Alibaba | text-to-video | 720p, 1080p | $0.14/second at 720p, together-ai | $0.7175 | 1 | no |
| `alibaba/happyhorse-1.1` | Alibaba | text-to-video, image-to-video, reference-to-video | 480p, 720p, 1080p | $0.098/second at 720p, pika | $0.5023 | 5 | no |
| `alibaba/happyhorse-1.1-i2v` | Alibaba | text-to-video | 720p, 1080p | $0.14/second at 720p, together-ai | $0.7175 | 1 | no |
| `alibaba/happyhorse-1.1-r2v` | Alibaba | text-to-video | 720p, 1080p | $0.14/second at 720p, together-ai | $0.7175 | 1 | no |
| `alibaba/happyhorse-1.1-t2v` | Alibaba | text-to-video | 720p, 1080p | $0.14/second at 720p, together-ai | $0.7175 | 1 | no |
| `alibaba/wan-2.1-t2v-480p` | Alibaba | text-to-video, image-to-video | single rate | $0.04/second at single rate, wavespeedai | $0.2110 (at single rate) | 1 | no |
| `alibaba/wan-2.2-a14b` | Alibaba | text-to-video | 480p, 720p | $0.036/second at 720p, machgen | $0.1845 | 1 | no |
| `alibaba/wan-2.6` | Alibaba | text-to-video | 720p, 1080p | $0.08/second at 720p, openrouter | $0.4220 | 1 | no |
| `alibaba/wan-2.7` | Alibaba | text-to-video, image-to-video, reference-to-video | single rate, 720p, 1080p | $0.1/second at 720p, alibaba | $0.5275 | 3 | no |
| `alibaba/wan-2.7-i2v` | Alibaba | text-to-video | single rate | $0.02/second at single rate, together-ai | $0.1025 (at single rate) | 1 | no |
| `alibaba/wan-2.7-image` | Alibaba | text-to-video | 720p, 1080p | $0.1/second at 720p, wavespeedai | $0.5125 | 1 | no |
| `alibaba/wan-2.7-r2v` | Alibaba | text-to-video | single rate | $0.02/second at single rate, together-ai | $0.1025 (at single rate) | 1 | no |
| `alibaba/wan-2.7-t2v` | Alibaba | text-to-video | single rate | $0.02/second at single rate, together-ai | $0.1025 (at single rate) | 1 | no |
| `alibaba/wan-25-preview` | Alibaba | text-to-video | 480p, 720p, 1080p | $0.1/second at 720p, fal | $0.5125 | 1 | no |
| `alibaba/wan-3.0` | Alibaba | text-to-video, image-to-video, reference-to-video | single rate, 480p, 720p, 720p-esr, 1080p, 1080p-esr, 1440p, 1440p-esr, 2160p, 4k-esr | $0.0441/second at 720p, botsmart | $0.2260 | 14 | **ours** |
| `alibaba/wan-3.0-prime` | Alibaba | text-to-video, image-to-video, reference-to-video | 480p, 720p, 720p-esr, 1080p, 1080p-esr, 1440p, 1440p-esr, 2160p, 4k-esr | $0.0794/second at 720p, botsmart | $0.4069 | 10 | no |
| `alibaba/wan-3.0-prime-pro-unrestricted` | Alibaba | text-to-video, image-to-video, reference-to-video | 1080p, 1440p, 2160p | $0.221/second at 1080p, mulerouter | $1.1658 (at 1080p) | 1 | no |
| `alibaba/wan-3.0-prime-unrestricted` | Alibaba | text-to-video, image-to-video, reference-to-video | 480p, 720p, 1080p | $0.084/second at 720p, sandbase | $0.4431 | 2 | no |
| `alibaba/wan-3.0-pro-unrestricted` | Alibaba | text-to-video, image-to-video, reference-to-video | 1080p, 1440p, 2160p | $0.144/second at 1080p, mulerouter | $0.7596 (at 1080p) | 1 | no |
| `alibaba/wan-3.0-unrestricted` | Alibaba | text-to-video, image-to-video, reference-to-video | 480p, 720p, 1080p | $0.06/second at 720p, sandbase | $0.3165 | 2 | no |
| `Wan-AI/Wan2.2-I2V-A14B` | Alibaba | text-to-video | single rate | $0.05728395/second at single rate, siliconflow | $0.2936 (at single rate) | 1 | no |
| `Wan-AI/Wan2.2-T2V-A14B` | Alibaba | text-to-video | single rate | $0.05728395/second at single rate, siliconflow | $0.2936 (at single rate) | 1 | no |
| `black-forest-labs/flux-3` | Black Forest Labs | text-to-video, image-to-video | 720p, 1080p | $0.17/second at 720p, black-forest-labs | $0.8713 | 6 | **ours** |
| `black-forest-labs/flux-3-edit-video` | Black Forest Labs | text-to-video, video-edit | single rate | $0.03/second at single rate, black-forest-labs | $0.1538 (at single rate) | 4 | no |
| `bytedance/doubao-seedance-1-0-pro-fast` | ByteDance | text-to-video | 480p, 720p, 1080p | $0.01456/second at 720p, toapis | $0.0768 | 1 | no |
| `bytedance/doubao-seedance-1-0-pro-quality` | ByteDance | text-to-video | 480p, 720p, 1080p | $0.05237/second at 720p, toapis | $0.2684 | 1 | no |
| `bytedance/doubao-seedance-1-5-pro` | ByteDance | text-to-video | 480p, 720p, 1080p | $0.02696/second at 720p, toapis | $0.1382 | 1 | no |
| `bytedance/seedance-2.0` | ByteDance | text-to-video, image-to-video, reference-to-video | 480p, 720p, 720p-sr, 1080p, 1080p-sr, 1440p-sr, 2160p | $0.0896/second at 720p, socheap-overseas | $0.4592 | 14 | **ours** |
| `bytedance/seedance-2.0-fast` | ByteDance | text-to-video, image-to-video, reference-to-video | single rate, 480p, 720p, 720p-sr, 1080p, 1080p-sr, 1440p-sr, 2160p | $0.0580608/second at 720p, atlas-cloud | $0.2976 | 9 | no |
| `bytedance/seedance-2.0-fast-unrestricted` | ByteDance | text-to-video | 480p, 720p | $0.102816/second at 720p, opensand | $0.5424 | 2 | no |
| `bytedance/seedance-2.0-mini` | ByteDance | text-to-video, image-to-video, reference-to-video | 480p, 720p, 720p-sr, 1080p, 1080p-sr, 1440p-sr, 2160p | $0.024192/second at 720p, atlas-cloud | $0.1240 | 8 | no |
| `bytedance/seedance-2.0-mini-unrestricted` | ByteDance | text-to-video | 480p, 720p | $0.06426/second at 720p, opensand | $0.3390 | 3 | no |
| `bytedance/seedance-2.0-unrestricted` | ByteDance | text-to-video | 480p, 720p, 1080p, 2160p | $0.12852/second at 720p, opensand | $0.6779 | 3 | no |
| `bytedance/seedance-2.5` | ByteDance | text-to-video, image-to-video, reference-to-video | 480p, 720p, 720p-esr, 720p-sr, 1080p, 1080p-esr, 1080p-sr, 1440p-esr, 1440p-sr, 2160p, 4k-esr, 1080p-esr & 60fps | $0.137/second at 720p, socheap-overseas | $0.7021 | 15 | **ours** |
| `bytedance/seedance-2.5-flash` | ByteDance | text-to-video, image-to-video, reference-to-video | 480p, 720p, 720p-esr, 1080p-esr | $0.1179/second at 720p, botsmart | $0.6042 | 7 | no |
| `bytedance/seedance-2.5-unrestricted` | ByteDance | text-to-video | 480p, 720p, 1080p | $0.196452/second at 720p, opensand | $1.0363 | 4 | no |
| `bytedance/seedance-v1.5-pro` | ByteDance | text-to-video, image-to-video | 480p, 720p, 1080p | $0.052/second at 720p, wavespeedai | $0.2743 | 1 | no |
| `creatify/boreal` | Creatify | text-to-video | 720p, 1080p, 1440p | $0.01/second at 720p, fal | $0.0513 | 1 | no |
| `fal/flux-3-max` | Fal | text-to-video, image-to-video | 720p, 1080p | $0.17/second at 720p, fal | $0.8713 | 1 | no |
| `google/gemini-omni-1.1-flash` | Google | text-to-video, image-to-video | single rate, 360p, 720p, 1080p, 2160p | $0.099/second at 720p, atlas-cloud | $0.5074 | 3 | no |
| `google/gemini-omni-1.2-flash` | Google | text-to-video, image-to-video | 360p, 720p, 1080p, 2160p | $0.0596352/second at 720p, atlas-cloud | $0.3056 | 4 | no |
| `google/gemini-omni-flash` | Google | text-to-video, image-to-video | single rate | $0.1/second at single rate, google | $0.5125 (at single rate) | 4 | no |
| `google/veo-3` | Google | text-to-video, image-to-video | single rate | $0.2/second at single rate, replicate | $1.0250 (at single rate) | 1 | no |
| `google/veo-3.1` | Google | text-to-video, image-to-video, reference-to-video | single rate, 720p, 1080p, 2160p | $0.2/second at 720p, openrouter | $1.0250 | 7 | no |
| `google/veo-3.1-fast` | Google | text-to-video, image-to-video, reference-to-video | single rate, 720p, 1080p, 2160p | $0.08/second at 720p, openrouter | $0.4100 | 7 | no |
| `google/veo-3.1-lite` | Google | text-to-video, image-to-video | 720p, 1080p | $0.03/second at 720p, openrouter | $0.1538 | 4 | no |
| `google/veo-3-fast` | Google | text-to-video, image-to-video | single rate | $0.1/second at single rate, replicate | $0.5125 (at single rate) | 1 | no |
| `heygen/heygen-video-1` | HeyGen | text-to-video, image-to-video, reference-to-video | 480p, 768p, 1080p, 1440p | $0.02/second at 480p, fal | $0.1025 (at 480p) | 4 | no |
| `kuaishou/kling-3.0-omni-pro-unrestricted` | Kuaishou | text-to-video | single rate | $0.0784/second at single rate, sandbase | $0.4018 (at single rate) | 1 | no |
| `kuaishou/kling-o3` | Kuaishou | text-to-video, image-to-video | single rate, 720p, 1080p, 2160p | $0.0588/second at 720p, sandbase | $0.3014 | 3 | no |
| `kuaishou/kling-v2.6` | Kuaishou | text-to-video, image-to-video | single rate, 1080p | $0.042/second at single rate, wavespeedai | $0.2153 (at single rate) | 3 | no |
| `kuaishou/kling-v3` | Kuaishou | text-to-video, image-to-video | single rate, 720p, 1080p, 2160p | $0.0588/second at 720p, sandbase | $0.3014 | 9 | no |
| `kuaishou/kling-v3-omni-video` | Kuaishou | text-to-video, image-to-video, reference-to-video, video-edit | pro, standard, 2160p | $0.42/second at 2160p, replicate | $2.1525 (at 2160p) | 1 | no |
| `kuaishou/kling-v3-turbo` | Kuaishou | text-to-video, image-to-video | single rate, 720p, 1080p | $0.09/second at 720p, pika | $0.4613 | 3 | no |
| `kuaishou/kling-v3-video` | Kuaishou | text-to-video, image-to-video | pro, standard, 2160p | $0.42/second at 2160p, replicate | $2.1525 (at 2160p) | 1 | no |
| `kuaishou/kling-v4.0` | Kuaishou | text-to-video, image-to-video, reference-to-video | 720p, 1080p, 1080p-esr, 1440p, 2160p, 4k-esr | $0.13345/second at 720p, machgen | $0.6839 | 9 | no |
| `kuaishou/kling-v4.0-flash` | Kuaishou | text-to-video, image-to-video, reference-to-video | 720p | $0.085722/second at 720p, atlas-cloud | $0.4393 | 4 | no |
| `kuaishou/kling-video-o1` | Kuaishou | text-to-video | single rate | $0.112/second at single rate, openrouter | $0.5740 (at single rate) | 1 | no |
| `lightricks/ltx-2.3` | Lightricks | text-to-video, image-to-video | 480p, 720p, 1080p | $0.03/second at 720p, wavespeedai | $0.1538 | 1 | no |
| `lightricks/ltx-2.3-fast` | Lightricks | text-to-video | 1080p, 1440p, 2160p | $0.06/second at 1080p, sandbase | $0.3075 (at 1080p) | 1 | no |
| `lightricks/ltx-2.3-fast-unrestricted` | Lightricks | text-to-video | 1080p, 1440p, 2160p | $0.06/second at 1080p, sandbase | $0.3165 (at 1080p) | 1 | no |
| `lightricks/ltx-2.3-pro` | Lightricks | text-to-video | 1080p, 1440p, 2160p | $0.03/second at 1080p, machgen | $0.1538 (at 1080p) | 2 | no |
| `lightricks/ltx-2.3-pro-unrestricted` | Lightricks | text-to-video | 1080p, 1440p, 2160p | $0.08/second at 1080p, sandbase | $0.4220 (at 1080p) | 1 | no |
| `lightricks/ltx-2.5` | Lightricks | text-to-video, image-to-video | 720p, 1080p, 1440p, 2160p | $0.1/second at 720p, wavespeedai | $0.5125 | 1 | no |
| `lightricks/ltx-2.5-fast` | Lightricks | text-to-video, image-to-video, audio-to-video | 720p, 1080p, 1440p, 2160p | $0.09/second at 720p, fal | $0.4613 | 2 | no |
| `lightricks/ltx-2.5-pro` | Lightricks | text-to-video, image-to-video, audio-to-video | 720p, 1080p | $0.12/second at 720p, fal | $0.6150 | 2 | no |
| `lightricks/ltx-2-fast` | Lightricks | text-to-video, image-to-video | single rate | $0.04/second at single rate, wavespeedai | $0.2050 (at single rate) | 1 | no |
| `lightricks/ltx-2-pro` | Lightricks | text-to-video, image-to-video | single rate | $0.06/second at single rate, wavespeedai | $0.3075 (at single rate) | 1 | no |
| `luma/luma-ray-3.2` | Luma | text-to-video | 540p, 720p, 1080p | $0.06/second at 720p, luma | $0.3075 | 2 | no |
| `minimax/h3` | MiniMax | text-to-video, image-to-video, reference-to-video | 480p, 540p, 768p, 1080p, 1080p-esr, 1440p, 1440p-esr, 2160p, 4k-esr | $0.04/second at 768p, kie-ai | $0.2050 (at 768p) | 14 | **ours** |
| `minimax/h3-fast` | MiniMax | text-to-video, image-to-video, reference-to-video | single rate | $0.0437/second at single rate, atlas-cloud | $0.2240 (at single rate) | 1 | no |
| `minimax/h3-max` | MiniMax | text-to-video, image-to-video, reference-to-video | 480p, 768p, 1440p, 1440p-sr, 2160p, 4k-sr | $0.04/second at 480p, sandbase | $0.2050 (at 480p) | 4 | no |
| `minimax/h3-max-camera-controls` | MiniMax | text-to-video | 480p, 768p, 1080p | $0.16/second at 1080p, fal | $0.8200 (at 1080p) | 1 | no |
| `minimax/h3-max-turbo` | MiniMax | text-to-video, image-to-video | 480p, 768p, 1080p | $0.025/second at 480p, fal | $0.1281 (at 480p) | 2 | no |
| `minimax/h3-max-unrestricted` | MiniMax | text-to-video | 480p, 768p | $0.04/second at 480p, sandbase | $0.2110 (at 480p) | 1 | no |
| `minimax/h3-unrestricted` | MiniMax | text-to-video | 768p, 1440p | $0.104/second at 1440p, sandbase | $0.5486 (at 1440p) | 2 | no |
| `minimax/hailuo-2.3` | MiniMax | text-to-video | single rate | $0.0817/second at single rate, openrouter | $0.4187 (at single rate) | 1 | no |
| `minimax/hailuo-2.3-pro` | MiniMax | text-to-video, image-to-video | single rate | $0.08166667/second at single rate, wavespeedai | $0.4185 (at single rate) | 1 | no |
| `minimax/hailuo-2.3-standard` | MiniMax | text-to-video, image-to-video | 6s, 10s | $0.56/clip at 10s, wavespeedai | per clip, not per second | 1 | no |
| `minimax/hailuo-3` | MiniMax | text-to-video | single rate | $0.13/second at single rate, openrouter | $0.6663 (at single rate) | 1 | no |
| `minimax/hailuo-3-max` | MiniMax | text-to-video | 480p, 768p | $0.05/second at 480p, openrouter | $0.2563 (at 480p) | 1 | no |
| `minimax/minimax-h3-turbo` | MiniMax | text-to-video, image-to-video, reference-to-video | 480p, 768p | $0.02/second at 480p, machgen | $0.1025 (at 480p) | 1 | no |
| `pika/pika-2.5` | Pika | text-to-video, image-to-video | 720p, 1080p | $0.04/second at 720p, pika | $0.2050 | 1 | no |
| `pika/pika-h3-flex` | Pika | text-to-video, image-to-video, reference-to-video | 480p, 768p, 1080p, 1440p, 2160p | $0.035/second at 1080p, pika | $0.1794 (at 1080p) | 1 | no |
| `Pixverse/Pixverse-6-T2V` | PixVerse | text-to-video | single rate | $0.045/second at single rate, deepinfra | $0.2306 (at single rate) | 1 | no |
| `pixverse/pixverse-c1` | PixVerse | text-to-video | 360p, 540p, 720p, 1080p | $0.0408/second at 720p, machgen | $0.2091 | 1 | no |
| `pixverse/pixverse-v6` | PixVerse | text-to-video, image-to-video | 360p, 540p, 720p, 1080p | $0.03655/second at 720p, machgen | $0.1873 | 3 | no |
| `pixverse/pixverse-v6-max` | PixVerse | text-to-video, image-to-video | 360p, 540p, 720p, 1080p | $0.044/second at 720p, atlas-cloud | $0.2255 | 3 | no |
| `prunaai/p-video` | PrunaAI | text-to-video | single rate, 720p, 1080p | $0.02/second at 720p, deepinfra | $0.1025 | 2 | no |
| `prunaai/p-video-2` | PrunaAI | text-to-video | 720p, 1080p | $0.025/second at 720p, pruna | $0.1281 | 1 | no |
| `prunaai/p-video-2-draft` | PrunaAI | text-to-video | 720p, 1080p | $0.015/second at 720p, pruna | $0.0769 | 1 | no |
| `prunaai/p-video-2-pro` | PrunaAI | text-to-video, image-to-video | 480p, 768p, 1080p, 1440p, 2160p | $0.02/second at 480p, pruna | $0.1025 (at 480p) | 5 | no |
| `prunaai/p-video-2-pro-cost` | PrunaAI | text-to-video, image-to-video | 480p, 768p, 1080p, 1440p, 2160p | $0.01/second at 480p, pruna | $0.0513 (at 480p) | 5 | no |
| `prunaai/p-video-2-pro-quality` | PrunaAI | text-to-video, image-to-video | 480p, 768p, 1080p, 1440p, 2160p | $0.04/second at 480p, pruna | $0.2050 (at 480p) | 5 | no |
| `prunaai/p-video-draft` | PrunaAI | text-to-video | 720p, 1080p | $0.005/second at 720p, pruna | $0.0256 | 1 | no |
| `runway/gen-4.5` | Runway | text-to-video, image-to-video | single rate | $0.12/second at single rate, openrouter | $0.6150 (at single rate) | 2 | no |
| `shengshu/vidu-q3` | Shengshu | text-to-video, reference-to-video | 360p, 540p, 720p, 1080p | $0.065/second at 720p, runware | $0.3331 | 3 | no |
| `shengshu/vidu-q3-pro` | Shengshu | text-to-video, image-to-video | 540p, 720p, 1080p | $0.118/second at 720p, machgen | $0.6048 | 2 | no |
| `shengshu/vidu-q3-turbo` | Shengshu | text-to-video | 360p, 540p, 720p, 1080p | $0.03575/second at 720p, runware | $0.1832 | 3 | no |
| `shengshu/vidu-q3-turbo-unrestricted` | Shengshu | text-to-video | 360p, 540p, 720p, 1080p | $0.077/second at 720p, sandbase | $0.4062 | 1 | no |
| `shengshu/vidu-q3-unrestricted` | Shengshu | text-to-video | 360p, 540p, 720p, 1080p | $0.154/second at 720p, sandbase | $0.8124 | 1 | no |
| `skywork-ai/skyreels-v4` | Skywork AI | text-to-video, image-to-video | 480p, 720p, 1080p | $0.14/second at 720p, wavespeedai | $0.7175 | 1 | no |
| `tencent/hunyuan-video-1.5` | Tencent | text-to-video, image-to-video | 480p, 720p | $0.04/second at 720p, wavespeedai | $0.2110 | 1 | no |
| `xai/grok-imagine-video` | xAI | text-to-video, image-to-video | 480p, 720p, 1080p | $0.05/second at 720p, wavespeedai | $0.2563 | 5 | no |
| `xai/grok-imagine-video-1.5` | xAI | text-to-video, image-to-video | single rate, 480p, 720p, 1080p | $0.08/second at 720p, replicate | $0.4100 | 5 | no |
| `xai/grok-imagine-video-1.5-lite` | xAI | text-to-video | 480p, 720p, 1080p | $0.03/second at 720p, openrouter | $0.1538 | 1 | no |

### 1b. Not in our catalog

Everything in the table not marked "ours" (107 entries). The ones closest to our five:

| Model | VideoRouter id | Resolutions | 5 s at 720p incl. 2.5% fee | Source |
| --- | --- | --- | --- | --- |
| Seedance 2.5 Flash | `bytedance/seedance-2.5-flash` | 480p, 720p (one host adds 720p-esr, 1080p-esr) | $0.6042 (BotSmart $0.1179/s) | seen: <https://videorouter.sh/video/bytedance/seedance-2.5-flash> |
| Seedance 2.0 Fast | `bytedance/seedance-2.0-fast` | 480p to 2160p | $0.2976 (Atlas Cloud) | seen: price index |
| Seedance 2.0 Mini | `bytedance/seedance-2.0-mini` | 480p to 2160p | $0.1240 (Atlas Cloud) | seen: price index |
| Wan 3.0 Prime | `alibaba/wan-3.0-prime` | 480p, 720p, 1080p (one host up to 2160p) | $0.4069 (BotSmart $0.0794/s) | seen: price index |
| MiniMax H3 Max | `minimax/h3-max` | 480p, 768p (one host up to 2160p) | 768p, nearest tier: SandBase $0.064/s, about $0.328 for 5 s with fee (computed from the page rate) | seen: <https://videorouter.sh/video/minimax/h3-max> (host "MiniMax" shown as "Temporarily unavailable") |
| MiniMax H3 Max Turbo | `minimax/h3-max-turbo` | 480p, 768p, 1080p | 768p, nearest tier: $0.04/s, about $0.205 for 5 s with fee (computed) | seen: price index |
| MiniMax H3 Fast | `minimax/h3-fast` | single rate | $0.2240 (Atlas Cloud, tier `*`) | seen: price index |
| FLUX 3 Max | `fal/flux-3-max` (no host suffix) | 720p, 1080p | $0.8713 (Fal $0.17/s) | seen: <https://videorouter.sh/video/fal/flux-3-max> |
| Kling 4.0 | `kuaishou/kling-v4.0` | 720p to 2160p | $0.6839 (MachGen $0.13345/s) | seen: price index |
| Kling 4.0 Flash | `kuaishou/kling-v4.0-flash` | 720p | $0.4393 | seen: price index |
| Gemini Omni 1.2 Flash | `google/gemini-omni-1.2-flash` | 360p to 2160p | $0.3056 | seen: price index |
| HappyHorse 1.1 | `alibaba/happyhorse-1.1` | 480p, 720p, 1080p | $0.5023 | seen: price index |
| LTX-2.5 / Fast / Pro | `lightricks/ltx-2.5`, `-fast`, `-pro` | 720p up to 2160p | $0.5125 / $0.4613 / $0.6150 | seen: price index |
| Grok Imagine Video 1.5 | `xai/grok-imagine-video-1.5` | 480p, 720p, 1080p | $0.4100 | seen: price index |
| Luma Ray 3.2 | `luma/luma-ray-3.2` | 540p, 720p, 1080p | $0.3075 | seen: price index |

Also in the index, not opened as pages: `minimax/hailuo-3` ($0.13/s, OpenRouter only) and `minimax/hailuo-3-max` beside `minimax/h3`; the index does not say whether these are the same model under another name.

### 1c. Our five on VideoRouter

| Ours | VideoRouter id | Today | Compared with `src/video/catalog.js` |
| --- | --- | --- | --- |
| Seedance 2.5 | `bytedance/seedance-2.5/socheap-overseas` | 720p $0.137/s, only tier on that host. 15 hosts in total. | Unchanged: 0.137 x 5 x 1.025 = $0.702125. seen: <https://videorouter.sh/video/bytedance/seedance-2.5/socheap-overseas> |
| Seedance 2.0 | `bytedance/seedance-2.0/socheap-overseas` | 720p $0.0896/s. 14 hosts. | Unchanged: $0.4592. seen: <https://videorouter.sh/video/bytedance/seedance-2.0/socheap-overseas> |
| Wan 3.0 | `alibaba/wan-3.0/botsmart`, `.../replicate` | BotSmart 720p $0.0441/s; Replicate 720p $0.05/s. 14 hosts. | Unchanged: $0.226013 and $0.25625. seen: both host pages |
| MiniMax H3 | `minimax/h3` | 14 hosts; cheapest 768p $0.04/s (kie.ai), so about $0.205 for 5 s with fee. Tiers 480p to 2160p depending on host. | We do not route H3 through VideoRouter today. seen: <https://videorouter.sh/video/minimax/h3> |
| Flux 3 video | `black-forest-labs/flux-3` | Text and image to video. 720p $0.17/s, 1080p $0.29/s on five hosts (Black Forest Labs, Replicate, OpenRouter, Together AI, WaveSpeedAI); Atlas Cloud $0.187/$0.319. 5 s at 720p with fee: $0.87125. | seen: <https://videorouter.sh/video/black-forest-labs/flux-3> and `/black-forest-labs` host page |

Related Flux entries that are not text-to-video generation: `flux-3-edit-video`, `flux-3-extend`, `flux-3-keyframes`, `flux-video-upscale`, `flux-video-upscale-creative`.

## 2. KovAPI

Sources opened (all seen, HTTP 200):

- <https://kovapi.com> and <https://kovapi.com/market?cat=video>
- <https://kovapi.com/llms.txt> ("Last updated 2026-11-22"; "Every price below is read live from the billing table")
- <https://kovapi.com/new> and <https://kovapi.com/new.json> (release calendar; covers 2026-10-02 to 2026-11-22 only)
- <https://kovapi.com/announcements>
- model pages as Markdown: `https://kovapi.com/model/<id>.md` for `seedance-2.5`, `seedance-2.5-flash`, `wan3.0-video`, `wan3.0-video-prime`, `minimax-h3`, `minimax-h3-lite`

### 2a. Full video list (from `llms.txt`, "Video models (live prices, USD)")

| Model | KovAPI id | Resolutions | Duration | 5 s at 720p | Listing date in the calendar |
| --- | --- | --- | --- | --- | --- |
| Seedance 2.5 (ours) | `seedance-2.5` | 480P, 720P, 1080P | 4 to 30 s | $0.79 ($0.158/s) | before the calendar starts |
| Seedance 2.5 Flash | `seedance-2.5-flash` | 480P, 720P | 4 to 30 s | $0.60 ($0.12/s) | 2026-11-19 |
| Seedance 2.5 · Special | `seedance-2.5-30s` | 720P | 4 to 30 s | $2.00 per clip, any length | 2026-10-04, "back" 2026-11-01 |
| Seedance 2.5 · Token | `seedance-2.5-token` | not stated | not stated | no per-second price; market card says "$6.1-11.1 / 1M video tokens" | 2026-10-24 |
| Seedance 2.5 · Token Draft | `seedance-2.5-token-draft` | not stated | not stated | not stated | not in calendar |
| Seedance 2.0 (ours) | `seedance-2.0` | 480P, 720P, 1080P, 4K | 5 to 15 s | $0.525 ($0.105/s) | before the calendar starts |
| Seedance 2.0 Fast | `seedance-2.0-fast` | 480P, 720P | 5 to 15 s | $0.375 ($0.075/s) | 480P added 2026-10-31 |
| Seedance 2.0 Mini | `seedance-2.0-mini` | 480P, 720P | 5 to 15 s | $0.26 ($0.052/s) | "is back" 2026-10-31 |
| Seedance 2.0 · Clip | `seedance-2.0-clip` | 720P | 5, 10 or 15 s | $1.00 per clip | 2026-10-04 |
| Wan 3.0 (ours) | `wan3.0-video` | 480P, 720P, 1080P | 4 to 30 s | $0.325 ($0.065/s) | before the calendar starts |
| Wan 3.0 Prime | `wan3.0-video-prime` | 480P, 720P, 1080P | 4 to 30 s | $0.60 ($0.12/s) | not in calendar |
| MiniMax H3 (ours) | `minimax-h3` | 480P, 768P, 1080P | 4 to 15 s | 768P, nearest tier: $0.125 ($0.025/s) | upgraded 2026-11-11 |
| MiniMax H3 Lite | `minimax-h3-lite` | 480P, 768P | 4 to 15 s | 768P, nearest tier: $0.0625 ($0.0125/s) | 2026-11-11 |
| Gemini Omni 1.2 Flash | `gemini-omni-1.2-flash` | 720P, 1080P, 4K | 3 to 15 s | $0.175 ($0.035/s) | 2026-11-11 |
| Gemini Omni Flash | `gemini-omni-flash` | 720P, 1080P | 6, 8 or 10 s | no 5 s option; 6 s = $0.21 | 2026-10-02 |
| Veo 3.1 | `veo-3.1` | 720p, 1080p | fixed 8 s | no 5 s option; $0.20 per 8 s clip at 720p | 2026-10-02 |
| Grok Imagine Video 1.5 | `grok-imagine-video-1.5` | 480P, 720P, 1080P | 4 to 15 s | $0.20 ($0.04/s) | per-second billing since 2026-11-20 |

Notes:

- The market page header says "Video 8" and "Plus 1 more is not yet open", but shows nine video cards (it groups tiers into families). Which model is "not yet open" is not stated.
- `https://kovapi.com/model/seedance-2.5-token.md` answered 404, although `llms.txt` links the HTML page.

### 2b. Not in our catalog

All rows above not marked "ours": Seedance 2.5 Flash, Seedance 2.5 Special, Seedance 2.5 Token and Token Draft, Seedance 2.0 Fast, Mini and Clip, Wan 3.0 Prime, MiniMax H3 Lite, Gemini Omni 1.2 Flash, Gemini Omni Flash, Veo 3.1, Grok Imagine Video 1.5. Dates, tiers and prices are in the table.

Two caveats:

- **Wan 3.0 Prime availability is unverified.** An announcement updated 2026-10-26 says "Wan 3.0 Prime is not available for now ... Prime requests are refused at submission". No later "Prime is back" announcement was found, yet `llms.txt` and the model page (updated 2026-11-10) list it with live prices.
- **Kling 4.0 is not offered today.** Launched 2026-10-26 (`kling-4.0`, 720P $0.09/s), then "temporarily removed from the available models" on 2026-10-28. Today it is absent from the market page and `llms.txt`, and `https://kovapi.com/model/kling-4.0` answers 404.

### 2c. Our five on KovAPI

| Ours | id | Today | Compared with catalog |
| --- | --- | --- | --- |
| Seedance 2.5 | `seedance-2.5` | 480P $0.10, 720P $0.158, 1080P $0.38 per second; 4 to 30 s. Notice dated 2026-11-22: jobs with **inline** reference audio or video fail more often; fix expected 2026-11-23. Text-only requests are not named as affected. | Unchanged ($0.79). |
| Seedance 2.0 | `seedance-2.0` | Price cut 2026-11-21: 720P $0.15 to $0.105, 1080P $0.30 to $0.25. `llms.txt` reports "51.4% success" on customer calls over the last 7 days. | Unchanged ($0.525 already reflects the cut). |
| Wan 3.0 | `wan3.0-video` | 720P $0.065/s; 4 to 30 s. | Unchanged ($0.325). |
| MiniMax H3 | `minimax-h3` | Upgraded 2026-11-11: new 480P ($0.015/s) and 768P ($0.025/s) tiers beside 1080P ($0.036/s), 4 to 15 s, eight aspect ratios. **1080P is the default when resolution is omitted**; "720P is read as 768P". | Unchanged ($0.125 at 768P), but a request that omits resolution is billed at 1080P. |
| Flux 3 video | none | not found: absent from the market page and `llms.txt`; `https://kovapi.com/model/flux-3.md` answers 404. | n/a |

## 3. Callirra

Sources opened (all seen, HTTP 200): <https://callirra.com/pricing>, <https://callirra.com/credit-costs>, <https://callirra.com/updates>, <https://callirra.com/docs/developer-api>, <https://callirra.com/api>, <https://callirra.com/ai-video-generator>, <https://callirra.com/minimax-h3>, <https://callirra.com/seedance2.5>, <https://callirra.com/llms.txt>.

**401 without a key** (not retried): `GET https://api.callirra.com/v1/models` ("Missing API key. Pass an Authorization bearer token."), and likewise `/v1/capabilities`, `/v1/chat/catalog`, `/v1/audio/models`. So per-model modes, durations and exact ids come only from the public pages.

Prices are plan credits. The rate card states a reference value of $0.01 per credit and that the real cost per credit depends on the plan.

### 3a. Full video list (rate card at `/credit-costs`)

The rate card does not say which rows are text-to-video. Names such as "First Frame", "Reference", "Video Edit", "Motion Control" and "Tail Frame" indicate other modes.

| Model | Public API id where shown | Tiers on the rate card | 5 s at 720p (credits) |
| --- | --- | --- | --- |
| Seedance 2.5 (ours) | `seedance-2.5` | 480P, 720P, 1080P; 4 to 30 s | 60 |
| Seedance 2.5 (Extra-wide limits) | `seedance-2.5-wide` | 480P, 720P, 1080P | 90 |
| Seedance 2.0 (ours) | `seedance-2` | 480P, 720P, 1080P, 4K | 45 |
| Seedance 2.0 (Extra-wide limits) | `seedance-2-wide` | 480P, 720P, 1080P | 65 |
| Seedance 2.0 Fast | `seedance-2-fast` | 480P, 720P | 30 |
| Seedance 2.0 Fast (Extra-wide limits) | `seedance-2-fast-wide` | 480P, 720P | 50 |
| Seedance 2.0 Mini | `seedance-2-mini` | 480P, 720P | 4 s only: 12 |
| Seedance 2.0 Mini (Extra-wide limits) | `seedance-2-mini-wide` | 480P, 720P | 4 s only: 24 |
| Seedance 1.0 Pro | not shown | 480P, 720P, 1080P | 30 |
| Seedance 1.0 Lite | not shown | 480P, 720P, 1080P | 25 |
| Seedance 1.0 Pro Fast | not shown | 720P, 1080P | 16 |
| MiniMax H3 · Standard (ours) | `minimax-h3` | 480P, 768P, 960P, 1080P, 2K | 768P, nearest tier: 10 |
| MiniMax H3 · Scene presets | `minimax-h3` with `minimax_h3_variant: "multimode"` | 480P, 768P, 1080P, 1440P | 768P: 10 |
| MiniMax H3 · Commerce | `minimax-h3` (variant field) | 480P, 768P; image-to-video per `llms.txt` | 768P: 10 |
| Hailuo 2.3 Standard | not shown | 768P, 1080P | no 5 s row; 768P 6 s: 30 |
| Hailuo 2.3 Pro | not shown | 768P, 1080P | no 5 s row; 768P 6 s: 45 |
| Kling 4.0 | not shown | 720P, 1080P | 30 |
| Kling 4.0 Flash | not shown | 720P | 43 |
| Kling 3.0 | `kling-3.0` | 720P | 70 |
| Kling O3 | not shown | 720P | 70 |
| Kling 2.6 | not shown | 720P | 55 |
| Kling 2.5 Turbo Pro (Tail Frame) | not shown | 720P | 42 |
| Kling 3.0 Motion Control | not shown | 720P, 1080P | 100 |
| Vidu Q4 Preview | not shown | 540P, 720P, 1080P, 2K, 4K | 56 |
| HappyHorse 1.0 | not shown | 720P, 1080P | 140 |
| HappyHorse 1.0 First Frame / Reference | not shown | 720P, 1080P | 140 |
| HappyHorse 1.0 Video Edit | not shown | 720P, 1080P | 280 |
| Veo 3.1 Fast | `veo-3.1-fast` | 720P | no 5 s row; 4 s: 60 |
| Veo 3.1 Quality | not shown | 720P | no 5 s row; 4 s: 250 |
| Gemini Omni Video | not shown | 720P, 4K | no 5 s row; 720P 4 s: 60 |
| Grok Imagine Video 1.5 Preview | not shown | 480P, 720P | 23 |

The generator's model picker at `/ai-video-generator` also lists **Veo 3.1 Lite** and **Sora 2 Pro**, which have no rate-card row.

### 3b. Not in our catalog

Every row above except the three marked "ours". The rate card and change log give no release or listing date for any of them. Newest-looking names: Kling 4.0, Kling 4.0 Flash, Vidu Q4 Preview, HappyHorse 1.0, Grok Imagine Video 1.5 Preview.

Seedance 2.5 and Seedance 2.0 are on Callirra, but `src/video/catalog.js` has a Callirra route only for MiniMax H3. "Generating with Seedance 2.x requires an active Starter or higher subscription."

### 3c. Our five on Callirra

| Ours | Today | Compared with catalog |
| --- | --- | --- |
| MiniMax H3 | `minimax-h3`. Standard: 480P 1, 768P 2, 960P 3, 1080P 3, 2K 10 credits per output second. Up to 15 s at 480P/768P/960P, up to 10 s at standard 1080P. Three variants on the rate card (Standard, Scene presets, Commerce). | Unchanged: 768P 5 s = 10 credits. |
| Seedance 2.5 | `seedance-2.5`; 4 to 30 s; 480p, 720p, 1080p; 720P 5 s = 60 credits. | No Callirra route in our catalog. |
| Seedance 2.0 | `seedance-2`; 720P 5 s = 45 credits. | No Callirra route in our catalog. |
| Wan 3.0 | not found on `/credit-costs`, `/ai-video-generator`, `/api` or `/llms.txt`. | n/a |
| Flux 3 video | not found on the same pages. | n/a |

Change log: the newest entry on `/updates` is dated October 25, 2026. It lists no video model added, renamed or retired.

## 4. Krea

Sources opened (all seen, HTTP 200):

- <https://www.krea.ai/pricing>, <https://www.krea.ai/features/ai-video-generator>, <https://www.krea.ai/models> (37 entries with category "Video generation")
- <https://www.krea.ai/app/api/pricing> (public page; per-model API prices embedded in the HTML)
- <https://api.krea.ai/openapi.json> (public OpenAPI, 44 paths under `/generate/video/`, none marked `deprecated`)
- <https://www.krea.ai/docs/llms.txt>, <https://www.krea.ai/docs/changelog.md>, <https://www.krea.ai/docs/developers/deprecations.md>, <https://www.krea.ai/docs/developers/seedance.md>, <https://www.krea.ai/docs/developers/mcp.md>, <https://www.krea.ai/docs/developers/api-keys-and-billing.md>, <https://www.krea.ai/docs/user-guide/features/video.md>
- `https://docs.krea.ai` redirects to `https://www.krea.ai/docs`.

Not opened: the MCP model list. No authentication was attempted. One plain `GET https://api.krea.ai/mcp` with no credentials was sent by a status-check script and answered 405; nothing else was sent to that endpoint.

The model table in the user guide (`video.md`) is out of date: it still lists Veo 3 and Seedance 1.5 Pro, which the change log says were retired, and it omits Seedance 2.5. It was not used for the lists below.

### 4a. Full video list (public OpenAPI, with API-balance prices)

"Price" is the `x-krea-pricing` point for text-only input (no references) at 5 s and 720p, or the nearest duration and tier, which is then named. Endpoints that require a source image or video are marked.

| Krea model id (`video/...`) | Name | Duration (s) | Resolution | Price, text-only | Catalog |
| --- | --- | --- | --- | --- | --- |
| `alibaba/wan-2.1` | Wan 2.1 | no field | no field | per request: $0.345. Requires width, height. | no |
| `alibaba/wan-2.2` | Wan 2.2 | no field | no field | per request: $0.3. Requires width, height. | no |
| `alibaba/wan-2.5` | Wan 2.5 | 5 to 10 | 480p, 720p, 1080p | 5 s at 720p: $0.5 | no |
| `alibaba/wan-3.0` | Wan 3.0 | 2 to 30 | 480p, 720p, 1080p | 5 s at 720p: $0.75 | **ours** |
| `alibaba/wan-3.0-prime` | Wan 3.0 Prime | 2 to 30 | 480p, 720p, 1080p | 5 s at 720p: $0.7 | no |
| `black-forest-labs/flux-3-max` | FLUX 3 Max | 5 to 20 | 720p, 1080p | 5 s at 720p: $0.85 | no |
| `black-forest-labs/flux-3-video` | Flux 3 Video | 5 to 20 | 720p, 1080p, 1440p, 2160p | 5 s at 720p: $0.85 (mode=t2v) | **ours** |
| `black-forest-labs/flux-video-edit` | Flux Video Edit | no field | no field | no fixed price published. Requires start_video. | no |
| `bytedance/seedance-1.0-pro` | Seedance 1.0 Pro | not constrained in schema | 720p, 1080p | no fixed price published | no |
| `bytedance/seedance-1.0-pro-fast` | Seedance 1.0 Pro Fast | 2 to 12 | 480p, 720p, 1080p | no fixed price published | no |
| `bytedance/seedance-2` | Seedance 2.0 | 4 to 15 | 480p, 720p, 1080p, 4k | 5 s at 720p: $0.756 | **ours** |
| `bytedance/seedance-2-5` | Seedance 2.5 | 4 to 30 | 480p, 720p, 1080p, 4k | no fixed price published | **ours** |
| `bytedance/seedance-2-fast` | Seedance 2.0 Fast | 4 to 15 | 480p, 720p | 5 s at 720p: $0.6048 | no |
| `bytedance/seedance-2-mini` | Seedance 2.0 Mini | 4 to 15 | 480p, 720p | 5 s at 720p: $0.378 | no |
| `google/gemini-omni-flash` | Gemini Omni Flash | 3 to 10 | no field | no fixed price published | no |
| `google/gemini-omni-flash-1.1` | Gemini Omni Flash 1.1 | 3 to 10 | no field | no fixed price published | no |
| `google/gemini-omni-flash-1.2` | Gemini Omni Flash 1.2 | 3 to 15 | 360p, 720p, 1080p, 4k | no fixed price published | no |
| `google/veo-3.1` | Veo 3.1 | 4, 6, 8 | 720p, 1080p, 4K | 6 s at 720p: $1.2 (generateAudio=false); $2.4 (generateAudio=true) | no |
| `google/veo-3.1-fast` | Veo 3.1 Fast | 4, 6, 8 | 720p, 1080p, 4K | 6 s at 720p: $0.48 (generateAudio=false); $0.6 (generateAudio=true) | no |
| `google/veo-3.1-lite` | Veo 3.1 Lite | 4, 6, 8 | 720p, 1080p | 6 s at 720p: $0.18 | no |
| `kling/kling-2.5` | Kling 2.5 | 5, 10 | no field | 5 s, no resolution tier: $0.35 | no |
| `kling/kling-2.6` | Kling 2.6 | 5, 10 | no field | 5 s, no resolution tier: $0.35 (generateAudio=false); $0.7 (generateAudio=true) | no |
| `kling/kling-3.0` | Kling 3.0 | 3 to 15 | no field | 5 s, no resolution tier: $0.42 (mode=std, generateAudio=false); $0.56 (mode=pro, generateAudio=false); $0.63 (mode=std, generateAudio=true); $0.84 (mode=pro, generateAudio=true); $2.1 (mode=4k, generateAudio=false); $2.1 (mode=4k, generateAudio=true) | no |
| `kling/kling-4` | Kling 4.0 | 3 to 30 | 720p, 1080p, 4k | 5 s at 720p: $0.785 (dynamicRange=hdr); $0.785 (dynamicRange=sdr) | no |
| `kling/kling-4-flash` | Kling 4.0 Flash | 3 to 20 | 720p | 5 s, no resolution tier: $0.47 | no |
| `kling/kling-o1` | Kling o1 | 3 to 10 | no field | 5 s, no resolution tier: $0.56 | no |
| `krea/video-swap` | Video Swap | no field | 480p, 720p, 768p, 1080p | no fixed price published. Requires source_video, references. | no |
| `lightricks/ltx-video-2.3-22b` | LTX-2.3 22B | 5, 10, 15, 20 (from the price points) | no field | 5 s, no resolution tier: $0.1798 | no |
| `lightricks/ltx-video-2.5-fast` | LTX-2.5 Fast | 6, 8, 10, 12, 14, 16, 18, 20 | 720p, 1080p, 1440p, 4k | 6 s at 720p: $0.54 | no |
| `lightricks/ltx-video-2.5-pro` | LTX-2.5 Pro | 6, 8, 10 | 720p, 1080p | 6 s at 720p: $0.72 | no |
| `lightricks/ltx-video-2-19b` | LTX-2 19B | 5, 8, 10 (from the price points) | 512p, 768p | 5 s at 768p: $0.1016 | no |
| `minimax/h3-max` | MiniMax H3 Max | 5 to 15 | 480p, 768p, 1080p | 5 s at 768p: $0.3 | no |
| `minimax/h3-max-camera-controls` | minimax_h3max_camera | 5 to 15 | 480p, 768p, 1080p | no fixed price published. Requires start_image, camera_trajectory. | no |
| `minimax/h3-max-turbo` | MiniMax H3 Max Turbo | 5 to 15 | 480p, 768p, 1080p | 5 s at 768p: $0.15 | no |
| `minimax/hailuo` | Hailuo | no field | no field | per request: $0.43 | no |
| `minimax/hailuo-02` | Hailuo 02 | 6 to 10 | 512p, 768p, 1080p | 6 s at 768p: $0.27 | no |
| `minimax/hailuo-2.3` | Hailuo 2.3 | 6, 10 | 768p, 1080p | 6 s at 768p: $0.28 | no |
| `minimax/hailuo-2.3-fast` | Hailuo 2.3 Fast | 6, 10 | 768p, 1080p | 6 s at 768p: $0.19 | no |
| `minimax/hailuo-3` | MiniMax H3 | 5 to 15 | no field | 5 s, no resolution tier: $0.65 | **ours** |
| `runway/gen-4.5` | Runway Gen-4.5 | 2 to 10 | no field | 5 s, no resolution tier: $0.6 | no |
| `runway/gen-4-video` | Runway Gen-4 Video | 5, 10 | no field | 5 s, no resolution tier: $0.25 | no |
| `vidu/q3` | Vidu Q3 | 1 to 16 | 540p, 720p, 1080p | 5 s at 720p: $0.77 | no |
| `xai/grok-video` | Grok Imagine | 1 to 15 | 480p, 720p | 5 s at 720p: $0.35 | no |
| `xai/grok-video-1.5` | Grok Imagine 1.5 | 1 to 15 | 480p, 720p, 1080p | 5 s at 720p: $0.7 | no |

Listed on <https://www.krea.ai/models> as video models but with **no public API endpoint**: HappyHorse, Kling 3.0 Turbo, Kling o3, Kling o3 Pro, Wan 2.6. The change log also names **Seedance 2.5 Flash** (2026-11-15: draft mode is "Not available for Seedance 2.5 Flash"), and the pricing page's embedded plan data lists a `seedance-2-5-flash` app key; it has no model page and no API endpoint.

### 4b. Not in our catalog

Every row in the table except the five marked "ours". Dates the change log gives:

| Model | Krea id | Change-log date | 5 s at 720p (API balance) |
| --- | --- | --- | --- |
| FLUX 3 Max | `video/black-forest-labs/flux-3-max` | 2026-10-20 ("5 to 20 second clips with audio", 720p or 1080p) | $0.85 |
| Wan 3.0 Prime | `video/alibaba/wan-3.0-prime` | 2026-10-17 | $0.70 |
| Kling 4.0 | `video/kling/kling-4` | 2026-10-26 | $0.785 |
| Kling 4.0 Flash | `video/kling/kling-4-flash` | not found in the change log | $0.47 (720p only) |
| MiniMax H3 Max | `video/minimax/h3-max` | 2026-08-27; 1080p added 2026-09-09 | 768p, nearest tier: $0.30 |
| MiniMax H3 Max Turbo | `video/minimax/h3-max-turbo` | 2026-09-09 | 768p, nearest tier: $0.15 |
| Seedance 2.0 Fast / Mini | `video/bytedance/seedance-2-fast`, `-mini` | API guide dated 2026-10-28 | $0.6048 / $0.378 |
| Gemini Omni Flash 1.2 | `video/google/gemini-omni-flash-1.2` | not found in the change log | "Variable", no fixed price published |
| Gemini Omni Flash 1.1 | `video/google/gemini-omni-flash-1.1` | 2026-08-27 | "Variable" |
| LTX-2.5 Fast / Pro | `video/lightricks/ltx-video-2.5-fast`, `-pro` | not found in the change log | no 5 s option; 6 s: $0.54 / $0.72 |
| Grok Imagine 1.5 | `video/xai/grok-video-1.5` | not found in the change log | $0.70 |

Retirements recorded in the change log that do not touch our five: Ray 2 (2026-11-10), Seedance 1.5 Pro, Veo 3 and Veo 3 Fast (2026-10-24), Kling 1.0 to 2.1 (API sunset 2026-09-15), Veo 2 and Veo 3 (2026-08-28), Sora 2 and Seedance 1.0 Lite (2026-04-27).

### 4c. Our five on Krea

| Ours | Krea id | Today | Change |
| --- | --- | --- | --- |
| Seedance 2.5 | `video/bytedance/seedance-2-5` | 4 to 30 s; 480p, 720p, 1080p, 4k. API price is "Variable" ("The exact cost depends on the completed job and provider result"), so no 5 s figure is published. | 2026-11-15: 4K output added in the API, and draft mode (`draft: true`, then `draft_job_id`). `generate_audio` is deprecated and ignored, and the schema says it is rejected after 2026-10-30. Id unchanged. |
| Seedance 2.0 | `video/bytedance/seedance-2` | 4 to 15 s; 480p, 720p, 1080p, 4k. 5 s at 720p: $0.756. | No change found. Id unchanged. |
| Wan 3.0 | `video/alibaba/wan-3.0` | 2 to 30 s; 480p, 720p, 1080p. 5 s at 720p: $0.75 ($0.15/s, same as the 2026-08-28 launch note). | New sibling Wan 3.0 Prime (2026-10-17). Id unchanged. |
| MiniMax H3 | `video/minimax/hailuo-3` (display name "MiniMax H3") | 5 to 15 s; described as a "Frontier 2K model"; the request schema has no `resolution` field. 5 s: $0.65. | No change found. Id unchanged. See "Read this first", point 4. |
| Flux 3 video | `video/black-forest-labs/flux-3-video` (display name "Flux 3 Video") | 5 to 20 s; 720p, 1080p, 1440p, 2160p; text to video $0.17/s at 720p, so $0.85 for 5 s. | 2K and 4K added 2026-10-16. Sibling FLUX 3 Max added 2026-10-20. |

All four ids in `src/krea-helper/mcp.js` still exist in the public OpenAPI. Whether the MCP `list_models` output matches could not be checked without signing in.

## What could not be verified

- VideoRouter: the authenticated catalog endpoints (401); release or listing dates (none published); per-model duration limits (not on the pages); why the catalog page counts 111 text-to-video models and the index 112; whether `minimax/hailuo-3` and `minimax/h3` are the same model.
- KovAPI: whether Wan 3.0 Prime accepts jobs today; which model is "not yet open"; resolutions and durations for the two Seedance 2.5 Token entries; launch dates before 2026-10-02.
- Callirra: `GET /v1/models` (401), so exact ids for most models, which rows are text-to-video, and per-model duration limits beyond those printed on the H3 and Seedance 2.5 pages; any listing dates.
- Krea: the MCP model list and its schemas; compute-unit cost of any video model on the OAuth route; an API price for Seedance 2.5 and the Gemini Omni Flash models ("Variable"); dates for Kling 4.0 Flash, Gemini Omni Flash 1.2, LTX-2.5, Grok Imagine 1.5 and Seedance 2.5 Flash.
- Not opened at all: `docs.kovapi.com`, individual Krea API reference pages per model, VideoRouter pages for most of the 107 non-catalog entries (their rows come from the price index only).
