# ElevenLabs voice CLI

Dependency-free Node 22 module. Dispatcher: `require('./voice/command').run(args, out, {env, fetchImpl, loadMasterKey})`. Arguments exclude `voice`; `out` receives human help or formatted JSON. Tests mock only network boundaries (fetch/WebSocket) and the deadline clock. Credentials use the shared encrypted provider store via `require('../video/keys').resolve(home, 'elevenlabs', ...)`; an environment key wins.

## Examples

```sh
dshproxy voice list
dshproxy voice voices --search narrator
dshproxy voice voices --page-token TOKEN_FROM_PREVIOUS_PAGE
dshproxy voice pick VOICE_ID
dshproxy voice tts eleven_v4 --voice VOICE_ID --text-file script.txt --output speech.mp3 --confirm-charge
dshproxy voice tts eleven_flash_v2_5 --voice VOICE_ID --text-file script.txt --output fast.mp3 --confirm-charge
dshproxy voice transcribe scribe_v3 --input recording.wav --output transcript.json --confirm-charge
dshproxy voice transcribe scribe_v2_medical --input recording.wav --output clinical-draft.json --confirm-charge
dshproxy voice change eleven_multilingual_sts_v2 --voice VOICE_ID --input recording.wav --output changed.mp3 --confirm-charge
```

`pick` looks up an exact account voice ID and returns it, without changing defaults or generating a preview. Listing makes one authenticated read-only request per page. No automatic pagination or preview downloads. Use the picked ID explicitly for generation. Names are not IDs.

## Verified routing and limits

Official documentation checked 2026-11-26:

- [Models](https://elevenlabs.io/docs/overview/models.md): all eight exact model IDs in the catalog.
- [Dialogue](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert.md): v4 uses `/v1/text-to-dialogue`, JSON `model_id` and `inputs: [{text, voice_id}]`. Despite the model's larger advertised context, this CLI caps v4 at the endpoint's recommended 2,000 characters for reliable generation.
- [TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/convert.md): Flash v2/v2.5 use `/v1/text-to-speech/{voice_id}`, JSON `model_id` and `text`. Local cap 40,000 characters.
- [Transcription](https://elevenlabs.io/docs/api-reference/speech-to-text/convert.md): Scribe v3 and v2 Medical use `/v1/speech-to-text`, multipart `model_id` and `file`. Synchronous single-channel JSON transcript only.
- [Voice changer](https://elevenlabs.io/docs/api-reference/speech-to-speech/convert.md): Multilingual STS v2 uses **`/v1/voice-changer/{voice_id}`**, multipart `model_id` and `audio`.
- [Voices](https://elevenlabs.io/docs/api-reference/voices/search.md): `/v2/voices`, `search`, `next_page_token`, `voice_ids` query parameters; `has_more` and `next_page_token` pagination.

- [Dialogue WebSocket](https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket.md): Turbo uses `/v1/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=mp3_44100_128`. Register one voice and `single_use_token` in the first message, then `inputs`, then `close_socket:true`; collect base64 audio until `is_final:true`. Local text cap 2,000 characters.
- [Live WebSocket](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime.md): `voice live scribe_v3_live --input recording.pcm --output transcript.json --confirm-charge` accepts **raw signed 16-bit little-endian mono 16kHz PCM only**, 2–30 seconds (64,000–960,000 bytes), no WAV header or decoding. Samples cannot prove their own encoding; the caller must supply the stated format. Sends 100ms chunks after `session_started`, manual commit on last chunk, saves final committed text as JSON. No timestamps, diarization, microphone or indefinite sessions. The 30-second cap avoids the documented automatic commit around 36 seconds; the minimum follows the [two-second processing buffer](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies.md).
- [Single-use tokens](https://elevenlabs.io/docs/api-reference/tokens/create.md): POST `/v1/single-use-token/tts_websocket` or `/v1/single-use-token/realtime_scribe?max_session_duration_seconds=120` with the permanent key in an HTTPS header only. Tokens expire after 15 minutes and are consumed on use. Live passes only this short-lived token in its WebSocket URL; Turbo sends it in the registration body. No permanent key in any URL, no tokens written to output/logs, no retries.

Both use Node 22+ built-in WHATWG WebSocket, fixed `wss://api.elevenlabs.io` endpoints and redirect-rejecting handshakes. Unknown models, operation combinations and options fail closed. All eight models now have implemented file-based transports; actual account eligibility is provider-controlled.

## Safety contract

- Generating/transcribing requires explicit `--confirm-charge`. This authorizes one paid request and is **not a billing cap**; no fixed-price claim or quote is made.
- No live requests or credentials are needed for tests; all provider traffic in tests is synthetic.
- Fixed official HTTPS origin, redirects forbidden, 120-second deadline, no retries (including ambiguous failures), no provider error bodies/transport exception text echoed.
- Input is a nonempty regular file, not a leaf symlink, bounded to 25 MiB for audio and 160,000 bytes of strict UTF-8 for text. Local paths/filenames are not sent as multipart names. Parent directory symlinks may resolve normally.
- Outputs are exclusively created with mode 0600 before network submission. Existing files/symlinks cannot be overwritten; failed requests clean up their reserved file. Output directory must already exist. Windows permissions remain subject to its ACLs.
- Response bodies are bounded while reading: 4 MiB JSON / 50 MiB audio. MP3 output only. No arbitrary remote inputs, cloud URLs, shell commands, external dependencies, microphone capture, or hidden previews.
- Provider retention defaults apply. This module does **not** promise HIPAA compliance or zero retention. Medical use requires appropriate agreements and controls (including a BAA before PHI), and clinical transcripts require professional review.

WebSocket caps: 120-second session deadline (in addition to the token request's 120-second deadline), 10,000 received messages, 8 MiB per delivered message, 75 MiB aggregate dialogue wire text / 50 MiB decoded MP3, 4 MiB aggregate Live wire text, 1 MiB outbound queue guard. Timers/listeners and the connection are closed on success/failure; incomplete reserved files are removed. **Native API limitation:** WHATWG WebSocket buffers complete messages before delivery and exposes no `maxPayload`/preallocation limit; these caps protect application processing/storage, not native memory against an oversized frame from the fixed trusted provider. A strict preallocation memory cap would require a different transport or isolated process, outside this dependency-free slice.

Verification: `node --test test/voice-*.test.js`. Acceptance includes exact official request schemas, no-network refusals, pagination/picking, private new-file outputs, no overwrite/symlink inputs, bounded IO, sanitized errors and no retries.
