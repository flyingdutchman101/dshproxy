# DeepSeek Harness gateway — spec

## Goal

A standalone Windows program that gives DeepSeek Harness subscription and API-key models through one local endpoint, with automatic failover along a configured ladder of models.

## Non-goals

- Factory Droid support of any kind
- A graphical interface
- Routing by task type, remaining quota or weekly pace
- Changing DeepSeek Harness's default model, delegation lanes or `allowedModels`
- Patching CLIProxyAPI

## Terms

- **Backend**: the CLIProxyAPI process.
- **Gateway**: the HTTP server DeepSeek Harness talks to.
- **Lane**: a model ID (`lane-<name>`) that stands for a ladder.
- **Ladder**: the ordered list of real models a lane tries.
- **Rung**: one model on a ladder.
- **Sitting out**: a model that is skipped until a set time.

## Acceptance criteria

Gateway

1. A lane request is served by the first rung that has an account or key and is not sitting out.
2. HTTP 402, 429, 503 or 529 from a rung makes it sit out and moves the same request to the next rung.
3. Three consecutive HTTP 500, 502, 504 or missing answers from a rung do the same; the first two are returned to the client.
4. A rejection that says the request is too long moves the request on without making the rung sit out.
5. Any other rejection is returned to the client and no other rung is tried.
6. A conversation that was served by a backup rung stays on it after the first rung recovers. A new conversation starts on the first rung.
7. A lane with no usable rung answers HTTP 503 with a message naming the lane.
8. A request for a real model reaches the backend byte for byte, with its headers.
9. A reasoning level the serving model does not accept is mapped to the nearest accepted level.
10. A streamed reply reaches the client unchanged.

Backend

11. A download is installed only if its SHA-256 matches the lock file.
12. The backend listens on loopback only, with the Management API and plugins off.
13. Starting never stops a process that is not this gateway's own backend.

DeepSeek Harness profile

14. `dsh apply` writes only the `dshgate-*` routes. Every other entry, route and comment is unchanged.
15. The profile is backed up before a change; an identical second sync writes nothing.
16. Fields the user added to a model entry survive a sync.
17. Models of a provider whose saved key cannot be read are kept.
18. A profile that cannot be parsed stops the sync before any profile is written.
19. `--dry-run` writes nothing.
20. `dsh remove` leaves the profile as it was before `dsh apply`.

Secrets

21. An API key is never passed on the command line and is stored encrypted.
22. Account listings contain no token.
