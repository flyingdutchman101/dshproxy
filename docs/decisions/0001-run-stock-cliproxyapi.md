# 0001 — Run stock CLIProxyAPI behind a small gateway

Date: 2026-11-15
Status: accepted

## Context

DeepSeek Harness needs subscription and API-key models behind one local endpoint, with failover when a model runs out of quota. VeryCuteDroidProxy did this as an Electron app inside a fork of DroidProxy, a macOS Swift app.

CLIProxyAPI published 15 releases in the 9 days before this decision. It already handles sign-in, token refresh, protocol translation, model aliases and session affinity.

## Decision

1. DSHProxy does not fork or patch CLIProxyAPI. It downloads one official release, named with its SHA-256 in `backend.lock.json`, and runs it as a child process.
2. DSHProxy does not derive from DroidProxy. No file or git history is shared.
3. A Node.js HTTP server sits in front of the backend. Its one job is lane failover; everything else is forwarded.
4. The gateway never reads, refreshes or writes subscription tokens. Sign-in runs CLIProxyAPI's own login command.
5. Failover lives in the gateway, not in a CLIProxyAPI plugin. A plugin runs inside the backend with access to every credential, needs Go and a C compiler to build, and is tied to the plugin ABI version.
6. The backend's own credential cool-down is switched off, so one component decides when a model sits out.

## Consequences

- Updating the backend is an edit to `backend.lock.json`.
- A lane request is parsed and re-serialized once per attempt. A request for a real model is not parsed for rewriting and keeps its bytes.
- Cool-downs and conversation pins are held in memory and are lost when the gateway restarts.
- Whether CLIProxyAPI alone handles Claude thinking correctly in long tool-using conversations is not established. VeryCuteDroidProxy rewrote the `Anthropic-Beta` header and removed old thinking blocks; DSHProxy does neither. Two single-turn requests on 2026-11-15 returned the same blocks with and without that rewrite. Multi-turn replay was not tested.
