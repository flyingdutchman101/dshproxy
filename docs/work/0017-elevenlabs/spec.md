# ElevenLabs media

Expose the seven video and eight speech models approved in conversation, on macOS, Windows and CLI, with one encrypted ElevenLabs key or ELEVENLABS_API_KEY. No credential is required for catalog reads. Key provisioning uses the official dashboard; never collect browser cookies or imply a consumer-plan billing route. No live generation, credential changes, release or deployment during implementation.

## Contracts

Voice CLI (native UI: use these exact flags): `voice list`; `voice voices [--search TEXT] [--page-token TOKEN]`; `voice pick VOICE_ID`; `voice tts MODEL --voice ID --text-file PATH --output PATH --confirm-charge`; `voice transcribe MODEL --input PATH --output PATH --confirm-charge`; `voice change MODEL --voice ID --input PATH --output PATH --confirm-charge`. A speaker is separate from a model. Disable unavailable transports with a reason before key access. Do not display credentials, text, or audio in logs. Paid actions require explicit confirmation.

Video model ids: seedance-2.0, seedance-2.0-fast, seedance-2.0-mini, seedance-2.5, veo-3.1, veo-3.1-fast, aurora. Model-specific durations and input requirements, no invented USD/credit estimate. Unknown amounts never satisfy a cap or permit submission (including picker). Key setup link: https://elevenlabs.io/app/api/api-keys; KovAPI signup: https://kovapi.com/register.

## Evidence

https://elevenlabs.io/docs/api-reference/authentication • https://elevenlabs.io/docs/eleven-api/quickstart • https://elevenlabs.io/docs/api-reference/flows/video/create • https://elevenlabs.io/docs/eleven-api/choosing-the-right-model

Mark supported versus catalog-only operations explicitly. The desktop configures video; it does not submit video. ElevenLabs controls key permissions and plan availability. Browser authorization via the vendor CLI provisions a key, not a subscription route; no third-party OAuth path for DSHProxy has been verified.
