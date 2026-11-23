# 0008 — A picked video entry may be the default model

Accepted 2026-11-23. The user asked for the flow "select Seedance in the model picker, type my scene, and confirm it myself" to work, after every confirmation in the real application had been refused.

**What was wrong.** The design of the video picker (0011, section 10) said a video entry must never be the default model of a DeepSeek Harness profile, and the gateway refused to buy while one was. DeepSeek Harness 0.2.2-rc.5 saves the model a person picks in a chat as that default, every time (`dsh-api-session-controller`, `selectModel` calls `agentDefaultModel.saveSelection`; there is no setting for it). So picking a video entry made the purchase impossible. Seen in the gateway on 23 Nov: at the confirmation the `desktop` profile's default model was the picked entry; after the user picked a text model again, it was not.

**Replaces in the design of 0011:** "no new session may start on a paid entry" and the words "or be the default model" in the rule about where a profile may name the video route.

**The rule now.**

- The default model itself (`agent-default-model`, its `config`) naming the video route does not stop a purchase and is not a fault in `dshproxy dsh verify`, as long as the entry is one that is offered. Every other place that names the route still stops purchases and is still reported: the allowed subagent models, a tool's agent options, any other pair, and anything else inside the default-model entry.
- `dshproxy dsh apply` still sets a default on the video route back to a lane, as before.
- New: a conversation in which the Harness's own session reminder says `You are a subagent delegated by agent "..."` gets one sentence. No quote is asked for and nothing is bought, whatever profile lets it through.

**Why an agent still cannot buy through the default model** (read in the Harness source, version 0.2.2-rc.5, not tried live):

- A subagent started without a model takes the route of its parent's last request, not the default model. A parent on a video entry starts no subagent: the picker never answers with a tool call.
- The lane tools are pinned to their routes in the profile.
- Text an agent sends never arrives as a bare `yes`: a delegated prompt has delivery guidance added, and a later message arrives as `Agent NAME sent a message: ...`. A purchase needs a bare `yes` directly after a quote.
- A scheduled task that opens a new session lands on the default model, with `[SCHEDULE REMINDER]` in its text; a goal round carries `<goal_round>`. Both were already answered with one sentence and no quote.

**Cost of this decision.**

- While a video entry is the picked model, every new chat starts on it until a text model is picked again. A prompt typed there is sent to the provider for a free quote. A scheduled task that opens a new session in that time does no work: it gets the picker's one sentence.
- The points above depend on how this Harness version words and routes things. A later version could change them. The ceiling per 24 hours and the purchases switch do not depend on them.
- A program on this computer that can send requests to the gateway could always order a clip with two requests (0011, risk R1). That is unchanged.

**Also fixed with this.** After a model change the Harness adds a unit `[model changed: ... the session continues with ...]` after the typed text. The picker quoted that unit as the prompt. It is now left out; the typed text is the prompt. A `yes` that arrives together with such a unit still buys nothing.
