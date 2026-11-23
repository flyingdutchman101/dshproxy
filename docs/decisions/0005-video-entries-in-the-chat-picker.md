# 0005 — Video entries in the chat model picker

Accepted 2026-11-23 at the user's request ("model picker in chat… name - resolution - via provider"). Changes one sentence each of 0002 and 0004; everything else in them, and all of 0003, stands.

**What is new.** A video entry (one model at one resolution on one billing route, such as "Seedance 2.5 - 720p - Krea") that the user switched on appears in the DeepSeek Harness model picker under "DSHProxy · Video (paid)". A typed prompt gets a quote. One reply that is exactly `yes`, `da`, `confirm`, `potvrdi` or `potvrđujem`, directly after that quote, buys one clip.

**Replaces in 0002** "Never send video jobs through the chat gateway". The gateway process now answers picker entries itself, on a path of its own (`/dshproxy/video/`). The chat forwarding path still never carries a video job. The purchase is still made by the video command, in a child process, once. **Replaces in 0004** "video jobs never go through the chat gateway" in the same sense; the rest of that sentence stands.

**One paid request per quote.** Before the paid request, the quote is claimed with one appended, flushed line in a journal that is never rewritten; the first line for a quote holds it. A repeat of the confirmation, after a dropped connection or a restart, finds that line and reports the job or says the outcome is unknown. Nothing is ever sent again because time passed or a file is missing. This is "at most once", not "always once": if the gateway dies between the claim and the request, nothing is bought and the answer is "unknown".

**A second line of defence, which 0002 left open.** Purchases from chat are off until the user switches them on (`dshproxy video picker purchases on`); while off, a confirmation rehearses everything except the paid request. A ceiling per rolling 24 hours applies to the chat path: 10 clips, 15,000 Krea units, 20 US dollars, 2,000 Callirra credits, each changeable by the user.

**What this does not guarantee.** These are accepted costs of the decision.

- The gateway can check what a request contains, not who typed it. Requests to `127.0.0.1` carry no identity. Any local program, or an agent that can send two requests and read the first answer, can buy one clip per quote. "A subagent never buys" is therefore not met. It is limited by: the purchases switch; the ceiling; the route never being written where agents can select it; `dsh verify` reporting a profile that names it there; and the gateway refusing to buy while any profile does. Requests with an `Origin` header or a foreign `Host` are refused, which stops web pages.
- The ceiling limits accidents on the chat path. It is not a boundary: `dshproxy video submit` has no ceiling, and a program with file access can change the ceiling or the records.
- The amount confirmed is a cap on the quote, not the bill. The provider sets the final charge.
- A power loss in the first minute after the journal is first created could lose a claim; purchases are refused for that minute.
- An "unknown" outcome needs the user: the gateway will not send again and cannot find out by itself.

**Data at rest.** Prompts, quote ids, amounts and job ids are kept in plain text in `<DSHPROXY_HOME>/video-picker/` for 30 days; the journal of claims is kept for good. No credential is stored there. Text that reaches a Krea entry and is taken for a prompt is sent to Krea as a free preflight; text recognised as the application's own traffic (titles, summaries, goals, schedules) is never sent.

**Unchanged.** No new listener. One send per job, no retry, no fallback. The gateway process never loads a provider key or the Krea token: the child resolves a key itself, and only the Krea helper reads the token. Sign-in only by the user.

Design and its review: `docs/work/0011-video-in-model-picker/` (kept on a local branch; it names local folders).
