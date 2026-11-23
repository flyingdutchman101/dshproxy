# New chat/coding models check: chat providers

Checked on 2026-11-22 (Europe/Paris evening). Read-only web research. Every claim below comes from a page opened on that day; the URL is given next to it. Nothing was signed in to, no API key was sent, no authenticated endpoint was called. Model facts that were not on an opened page are marked "not verified".

## Summary

| Provider | Newer or additional chat model we lack | Verdict |
| --- | --- | --- |
| DeepSeek API | none | Nothing newer found. Our two ids are the whole documented list. |
| Qwen Cloud Token Plan | `qwen4-max` (added 2026-11-16), plus older text models the plan lists that we do not offer | **Newer model found.** |
| Anthropic | none for general use; `claude-mythos-5-2` exists but is for verified organizations only | Nothing newer found. |
| OpenAI (ChatGPT/Codex) | none for general use; `gpt-6-cyber`, `gpt-6-rosalind` exist but are trusted-access only | Nothing newer found. |
| Catalog `models.json` | no claude/codex id that we lack | In step with our list. |
| CLIProxyAPI | latest release is v8.1.1, the one we run | Up to date. |

## 1. DeepSeek API

Seen on the provider's pages:

- Models and pricing, https://api-docs.deepseek.com/quick_start/pricing : the model table has exactly two models, `deepseek-flash` (model version DeepSeek-V4.1-Flash-1017) and `deepseek-v4-pro` (model version DeepSeek-V4-Pro-0813). Both: context length 1M, max output 384K, thinking and non-thinking modes, tool calls, Responses API, Anthropic API. Vision: `deepseek-flash` yes, `deepseek-v4-pro` not supported.
- Same page, footnote 1: the legacy names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted, but those models are retired and the requests are served by DeepSeek-V4.1-Flash-1017 at the Flash price. They are aliases, not additional models.
- Change log, https://api-docs.deepseek.com/updates : newest entries are 2026-11-13 (application APIs: web search, file input, URL reading, safety, ASR, TTS; no new chat model) and 2026-10-17 (DeepSeek-V4.1-Flash-1017, reached through `deepseek-flash`). The 2026-09-10 entry says DeepSeek V4 Pro API service continues after 2026-09-14. No V4.1 Pro or V5 entry.
- News index, https://api-docs.deepseek.com/news/news261113 : newest item is the 2026-11-13 application API release; the item before it is DeepSeek-V4.1-Flash-1017 (2026-10-17).

Result: nothing newer found. Our list (`deepseek-v4-pro`, `deepseek-flash`) matches the provider's list.

Not opened: the 2026-10-17 news article itself (https://api-docs.deepseek.com/news/news261017); the change log entry for that date was read instead.

## 2. Qwen Cloud Token Plan

Seen on the provider's pages:

- Endpoints, https://docs.qwencloud.com/developer-guides/clients-and-developer-tools/other-tools : Token Plan (Individual and Team Edition) uses `https://token-plan.maas.qwencloudapi.com/compatible-mode/v1` (OpenAI protocol) and `https://token-plan.maas.qwencloudapi.com/apps/anthropic` (Anthropic protocol), text generation models only.
- Individual supported models, https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview
- Team Edition supported models, https://docs.qwencloud.com/token-plan/team/token-plan-team-overview
- Token Plan product updates, https://docs.qwencloud.com/token-plan/token-plan-product-updates
- Model releases, https://docs.qwencloud.com/changelog/models
- Qwen4-Max specifications, https://docs.qwencloud.com/developer-guides/getting-started/latest-model

### Newer model

| Model id | On plan | Context window | Max output | Source and notes |
| --- | --- | --- | --- | --- |
| `qwen4-max` | Individual and Team | 1,000,000 tokens | 131,072 tokens non-thinking; 262,144 thinking plus final answer | Added to Token Plan on 2026-11-16 (product updates page). Specs are from the Qwen4-Max page, which describes the model in general, not the Token Plan specifically. Reasoning, visual understanding, text generation. |
| `qwen4-max-preview` | Individual and Team | not stated | not stated | Preview only, 2026-11-11 10:00 to 2026-11-25 24:00 (UTC+8), "will be retired after the preview ends". Alias `qwen4.0-max-preview`. Not worth adding: it ends in three days. |

### Other text models the plan lists that we do not offer

Individual and Team (both tables):

| Model id | Capability as documented | Context / max output |
| --- | --- | --- |
| `auto` | Reasoning, text generation. Platform picks the underlying model. Does not support `tool_choice`, `thinking.budget_tokens`, `thinking_budget`. | not stated |
| `qwen3.7-max` | Reasoning, text generation | not stated on pages opened |
| `qwen3.7-plus` | Reasoning, visual understanding, text generation | not stated on pages opened |
| `qwen3.6-flash` | Reasoning, visual understanding, text generation | not stated on pages opened |
| `glm-5.2` | Reasoning, text generation | not stated on pages opened |
| `deepseek-v4-pro-0813` | Reasoning, text generation (dated snapshot of the `deepseek-v4-pro` we already offer) | not stated on pages opened |
| `deepseek-v4-flash-0731` | Reasoning, text generation | not stated on pages opened |
| `deepseek-v4.1-flash` | Reasoning, visual understanding, text generation | 1M context, 384K max output (model releases page, 2026-09-13) |
| `deepseek-v4.1-flash-1017` | Reasoning, visual understanding, text generation. Added to Token Plan 2026-10-19. | 1M context, 384K max output (model releases page, 2026-10-18) |

Team Edition only:

| Model id | Capability as documented |
| --- | --- |
| `qwen3.6-plus` | Reasoning, vision understanding, text generation |
| `kimi-k2.7-code` | Reasoning, vision understanding, text generation |
| `kimi-k2.6` | Reasoning, vision understanding, text generation |
| `kimi-k2.5` | Reasoning, vision understanding, text generation |
| `glm-5.1` | Reasoning, text generation |
| `glm-5` | Reasoning, text generation |
| `MiniMax-M2.5` | Reasoning, text generation |

Models already on our list, confirmed present on both tables: `qwen3.8-max`, `qwen3.8-flash`, `glm-5.3`, `deepseek-v4-pro`. The model releases page states a 1M context window for `qwen3.8-max`, `qwen3.8-flash` and `glm-5.3`, and 128K max output for `glm-5.3`.

The plan also lists non-chat models (image, speech, video): `qwen-image-3.0-pro`, `qwen-audio-3.0-tts-plus`, `qwen-audio-3.0-realtime-plus`, `qwen-audio-3.0-asr-flash`, `wan2.7-image`, `wan2.7-image-pro`, `wan3.0-video`, `happyhorse-1.1-t2v`, `happyhorse-1.1-i2v`, `happyhorse-1.1-r2v`; Team Edition adds `qwen-image-2.0`, `qwen-image-2.0-pro`. Out of scope here.

Usage policy on both overview pages, relevant to a gateway: Token Plan keys are for interactive use inside AI coding and agent tools; "automation scripts, custom application backends" and non-interactive batch calls are named as violations that can suspend the subscription.

Not verified:

- Which edition our `sk-sp-` key belongs to. The Team-only rows apply only to a Team Edition key.
- Context window and max output for `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash`, `qwen3.6-plus`, `glm-5.2`, `glm-5.1`, `glm-5`, the two dated DeepSeek V4 snapshots, the Kimi models and `MiniMax-M2.5`. The plan pages do not state them and the per-model pages were not opened.
- https://www.qwencloud.com/pricing/token-plan opened (HTTP 200) but the fetch returned only the page header; its model table is not in the returned text. The docs pages above were used instead.
- Alibaba Cloud Model Studio documentation on alibabacloud.com was not opened. docs.qwencloud.com is the documentation for the host we use.

## 3. Anthropic

Seen on the provider's pages:

- Models overview, https://platform.claude.com/docs/en/models/overview : "Latest models" are Claude Fable 5.2 (`claude-fable-5-2`), Claude Opus 5.5 (`claude-opus-5-5`), Claude Sonnet 5.5 (`claude-sonnet-5-5`), Claude Haiku 5.5 (`claude-haiku-5-5`). All four: 1M context, 128K max output.
- Same page, "All models" table, in order: Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5, Mythos 5.2 (limited availability), Fable 5.1, Mythos 5.1 (limited availability), Fable 5, Mythos 5 (limited availability), Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Opus 4.5, Opus 4.1 (retired), Opus 4 (retired), Sonnet 5, Sonnet 4.6, Sonnet 4.5, Sonnet 4 (retired), Haiku 4.5. There is no Haiku 5 row.
- Release notes, https://platform.claude.com/docs/en/release-notes/overview : the newest model launch is 2026-11-09, Claude Fable 5.2 (`claude-fable-5-2`) and Claude Mythos 5.2 (`claude-mythos-5-2`). Entries after it (Nov 12, 16, 17) are platform features, no model.
- Claude Mythos 5.2 page, https://platform.claude.com/docs/en/models/mythos-5-2/overview : model id `claude-mythos-5-2`, "the same model as Claude Fable 5.2, available only to organizations verified through Anthropic's verification programs", 1M context, 128K max output.
- Claude Code model configuration, https://code.claude.com/docs/en/model-config : on the Anthropic API the aliases resolve to Opus 5.5, Sonnet 5.5, Haiku 5.5, and `fable` to Fable 5.2. Fable 5.1 and Fable 5 are selected by id (`claude-fable-5-1`, `claude-fable-5`).

Result: nothing newer found. Every generally available current model is on our list: claude-fable-5-2, claude-fable-5-1, claude-fable-5, claude-opus-5-5, claude-opus-5, claude-sonnet-5-5, claude-sonnet-5, claude-haiku-5-5.

Missing from our list, by design of the provider rather than by oversight: the Mythos line. `claude-mythos-5-2` is documented as verification-only. Claude Mythos 5.1 and Claude Mythos 5 are named on the overview page as limited availability; their exact API ids were not on a page opened (not verified).

Not verified: whether a Claude subscription sign-in can reach any Mythos model. The docs describe access through organization verification programs only.

## 4. OpenAI

Seen on the provider's pages:

- https://platform.openai.com/docs/models redirects to https://developers.openai.com/api/docs/models ; that page was opened (also as https://developers.openai.com/api/docs/models.md). Featured models: GPT-6.2 Astra, GPT-6.2 Sol, GPT-6.1 Terra, GPT-6 Luna.
- Full catalog, https://developers.openai.com/api/docs/models/all.md : current text models are gpt-6.2-astra, gpt-6.2-sol, gpt-6.1-terra, gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, then gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.4-pro, gpt-5.4-mini, gpt-5.2, gpt-5.2-pro. There is no gpt-6.2-terra, gpt-6.2-luna, gpt-6.1-luna or gpt-6.3 entry.
- API changelog, https://developers.openai.com/api/docs/changelog.md : newest chat model entry is 2026-11-17, GPT-6.2 Astra and GPT-6.2 Sol. The only later entry is 2026-11-19, GPT-Live-1.1 (voice).
- Codex models page, https://learn.chatgpt.com/docs/models.md : recommended models for ChatGPT Work and Codex are GPT-6.2 Astra (`gpt-6.2-astra`), GPT-6.2 Sol (`gpt-6.2-sol`), `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`. Default context in Codex: 272,000 tokens for GPT-6.2 Astra, 500,000 for GPT-6.2 Sol and GPT-6.1 Sol; GPT-6.2 Astra and Sol support up to 1 million through `model_context_window`. GPT-6.1 Terra requires Codex CLI 0.159.0 or later.
- Same page, retirements for ChatGPT sign-in: GPT-5.5 retired 2026-10-14, `gpt-5.4` and `gpt-5.4-mini` retired 2026-08-31, GPT-5.3-Codex-Spark retired 2026-09-14.
- Same page, gateway note: "Current Codex releases don't support `wire_api = \"chat\"` or a Chat Completions-only endpoint."
- GPT-6.2 launch note, https://learn.chatgpt.com/docs/whats-new/gpt-62-astra-sol.md (2026-11-17), and What's new, https://learn.chatgpt.com/docs/whats-new.md : the newest model item is GPT-6.2 on 2026-11-17.

Result: nothing newer found. gpt-6.2-sol, gpt-6.2-astra, gpt-6.1-sol, gpt-6.1-terra, gpt-6-sol, gpt-6-astra, gpt-6-luna are all on our list, and no documented Codex model is absent from it.

Text models on the API catalog that we do not offer, all restricted or not meant for this use:

| Model id | What the page says |
| --- | --- |
| `gpt-6-cyber` | Released 2026-11-05. OpenAI Daybreak cyber model for authorized vulnerability work; Daybreak setup required. |
| `gpt-5.6-cyber` | Cybersecurity model for authorized vulnerability research and security testing. |
| `gpt-6-rosalind` | Released 2026-10-30 per the API changelog; life sciences, organizations approved through the trusted-access program. |
| `gpt-rosalind-research` | Life sciences reasoning for approved organizations. |
| `chat-latest` | "Latest Instant model used in ChatGPT", listed under "ChatGPT models ... not recommended for API use". Snapshot updated 2026-10-07. |

Not verified:

- The Codex changelog, https://learn.chatgpt.com/docs/changelog (https://developers.openai.com/codex/changelog redirects there). The fetch tool returned only the navigation. The raw HTML was downloaded and scanned for model names: the highest names present are GPT-6.2 Astra and GPT-6.2 Sol, and the newest entry anchor is `codex-2026-11-18-mobile`. The entry texts were not read.
- https://developers.openai.com/codex/models redirects to learn.chatgpt.com; the guessed path https://learn.chatgpt.com/docs/codex/models returned 404. The real page is https://learn.chatgpt.com/docs/models.md, used above.
- What a signed-in ChatGPT/Codex account actually lists. That needs a sign-in, which was out of bounds.

## 5. Model catalog and CLIProxyAPI

### Catalog

Source: https://models.router-for.me/models.json (HTTP 200, 160,805 bytes, parsed locally). The fallback URL was not needed.

Sections in the file: copilot (30), claude (20), gemini (15), vertex (25), gemini-cli (7), aistudio (19), codex-free (6), codex-team (12), codex-plus (12), codex-pro (12), kimi (12), antigravity (15), xai (18), meta (10).

Model ids with `created` after 2026-10-08, in sections whose name starts with `claude` or `codex`:

| Section | Model id | created (unix) | created (UTC) | context_length | max_completion_tokens |
| --- | --- | --- | --- | --- | --- |
| claude | `claude-fable-5-2` | 1794250800 | 2026-11-09 19:00 | 1000000 | 128000 |
| codex-free | `gpt-6.1-terra` | 1792972800 | 2026-10-26 00:00 | 500000 | 128000 |
| codex-team | `gpt-6.2-astra` | 1794942000 | 2026-11-17 19:00 | 272000 | 128000 |
| codex-team | `gpt-6.2-sol` | 1794942000 | 2026-11-17 19:00 | 500000 | 128000 |
| codex-team | `gpt-6.1-terra` | 1792972800 | 2026-10-26 00:00 | 500000 | 128000 |
| codex-plus | `gpt-6.2-astra` | 1794942000 | 2026-11-17 19:00 | 272000 | 128000 |
| codex-plus | `gpt-6.2-sol` | 1794942000 | 2026-11-17 19:00 | 500000 | 128000 |
| codex-plus | `gpt-6.1-terra` | 1792972800 | 2026-10-26 00:00 | 500000 | 128000 |
| codex-pro | `gpt-6.2-astra` | 1794942000 | 2026-11-17 19:00 | 272000 | 128000 |
| codex-pro | `gpt-6.2-sol` | 1794942000 | 2026-11-17 19:00 | 500000 | 128000 |
| codex-pro | `gpt-6.1-terra` | 1792972800 | 2026-10-26 00:00 | 500000 | 128000 |

All four distinct ids (`claude-fable-5-2`, `gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-terra`) are already on our list.

Complete id lists of those sections, for reference:

- claude: claude-haiku-4-5-20251001, claude-sonnet-4-5-20250929, claude-sonnet-4-6, claude-opus-4-6, claude-opus-4-7, claude-opus-4-8, claude-opus-5, claude-sonnet-5, claude-fable-5, claude-fable-5-1, claude-fable-5-2, claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-opus-4-5-20251101, claude-opus-4-1-20250805, claude-opus-4-20250514, claude-sonnet-4-20250514, claude-3-7-sonnet-20250219, claude-3-5-haiku-20241022. No `claude-mythos-*` id.
- codex-free: gpt-6-chat-thinking, gpt-6-luna, gpt-6.1-terra, gpt-5.6-terra, gpt-5.6-luna, codex-auto-review.
- codex-team, codex-plus, codex-pro (same ids): gpt-6.2-astra, gpt-6.2-sol, gpt-6-astra, gpt-6-sol, gpt-6.1-sol, gpt-6.1-terra, gpt-6-luna, gpt-6-chat-thinking, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, codex-auto-review.

The only id in those sections that is on neither our offered list nor our stated switched-off list is `codex-auto-review` (created 2026-04-23, described as "Automatic approval review model for Codex"); it is an internal reviewer model, not a chat model.

The catalog's context lengths for `gpt-6.2-astra` (272000) and `gpt-6.2-sol` (500000) equal the "Default context in Codex" values on the Codex models page, not the 1M maximum.

### CLIProxyAPI

Source: https://api.github.com/repos/router-for-me/CLIProxyAPI/releases (public, unauthenticated) and its `/releases/latest`. The HTML page https://github.com/router-for-me/CLIProxyAPI/releases opened but the fetch returned only GitHub navigation.

- Latest release: **v8.1.1**, published 2026-11-22T16:10:30Z, https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.1.1 . This is the version we run. No newer release, no pre-release above it.
- Previous: v8.1.0 (2026-11-21T19:03:36Z), v8.0.80 (2026-11-20), v8.0.79 (2026-11-19), v8.0.78 (2026-11-19), v8.0.77 (2026-11-17), v8.0.76 (2026-11-17), v8.0.75 (2026-11-16).
- v8.1.1 changelog lines that touch the model registry: "feat(registry): add Gemini 4 Neon model definition", "feat(registry): unify copilot and devin published routes", "fix(registry): include copilot in static model lookup". None concerns Claude or Codex model ids.

## What could not be verified

1. What each signed-in account actually exposes (Claude subscription, ChatGPT/Codex subscription, our Token Plan key). All findings are from public documentation.
2. Which Token Plan edition our key is on; Team Edition lists seven text models that Individual does not.
3. Context window and max output for most of the older Token Plan models (listed above as "not stated").
4. API ids for Claude Mythos 5.1 and Claude Mythos 5.
5. The text of the Codex changelog entries (page rendered as navigation only; model names were scanned in the raw HTML).
6. The qwencloud.com pricing page's model table and the alibabacloud.com Model Studio docs (not read).
