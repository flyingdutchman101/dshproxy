# Chat and video workspaces: approved flow and acceptance contract

The user approved `workspaces.html` as the desktop interaction direction. DSHProxy configures routes; users interact with video in DeepSeek Harness, not through a second desktop generation UI. Existing chat behavior is preserved. This specification describes the production target; mock displays and model names do not prove a real provider connection or Harness capability.

## Behavior

- A prominent Chat / Video workspace switch is independent of the selected existing navigation tab; switching retains the current tab. Chat's current Accounts, API keys, Lanes, Models, DeepSeek Harness and Log behavior remains unchanged.
- Video Models enables/disables supported exact models. Video Lanes assigns exactly one allowed billing route per enabled model; a paid job must never automatically retry, change provider, or fall through to another route. Show route-native units. An enabled setting is not proof of credentials, availability or a successful quote.
- Persist changes across restarts while preserving all existing configuration and unrelated settings. New video models default disabled. Invalid or incompatible values cannot become executable routes. No secret is entered in model or lane settings.
- Video Accounts and API keys must describe real support accurately, link to existing credential management where applicable, and never promise a working sign-in flow not verified. No login occurs merely by opening a screen. Shared settings must be labeled as shared.
- Harness integration offers video as a video action, never as a chat completion model. The provider, model, prompt, native quote and final-debit limitation are shown before any confirmed charge. The tool requires an explicit human answer on each submission and cannot accept an agent-provided approval. The user accepted that this is a UX safeguard, not an OS-enforced boundary: a same-user full-access agent can bypass it by invoking the existing direct CLI. Quote-only operations and status are not submit. On ambiguous outcomes instruct the user to check job history, not blindly retry.
- Harness preview/apply must not claim integration is active until it is truly installed and verified. Never modify profiles implicitly or during tests. Live OAuth, generation, installing a DSH plugin, pushing and deployment are separate approval gates.
- Show recognizable model/provider logos in video workspace lists when a verified usable mark is available, with text labels retained and neutral fallback for unavailable marks. Document sources and licensing alongside existing app assets; never imply a provider connection from a logo.
- Preserve accessible controls, show empty and invalid/error states, avoid blocking the UI for provider operations, and build/test without real credentials or spend.

## Verification

Test settings against real temporary files and the desktop bridge at public seams. Verify desktop switching, persistence, validation and existing chat behavior using synthetic fixtures. Test any Harness integration against installed documented APIs, with mocked provider boundaries, explicit user-only charge authorization, and no real profile changes. Independently review payment/auth and integration boundaries. Record any unverified runtime capability rather than simulating successful application.
