# Part D design: amendments (lead, 2026-11-23 02:20)

These change `design-D.md` after the user's three answers and the adversarial design review. Where this file and `design-D.md` disagree, this file wins.

## The user's answers (02:12)

1. **Providers:** Krea and the API-key providers (VideoRouter, KovAPI, Callirra) can sell a clip from the picker. The user was told that on API routes the quote is a published price and the cap does not bound the bill, and chose this.
2. **Confirming words:** exactly `yes`, `da`, `confirm`, `potvrdi`, `potvrđujem` (also `potvrdujem`). `ok` and `može` do not buy; they get "reply with only `yes`".
3. **Ceiling:** 10 clips and 15,000 Krea units per rolling 24 hours.

## A1. The claim is a line in one journal, not a file per quote (review finding 2)

A new file's folder entry cannot be flushed from Node on Windows, so a claim file created seconds before the paid request is the weakest point against power loss. The claim therefore goes into a file that already exists.

- `<DSHPROXY_HOME>/video-picker/claims.log`. Created (exclusive create, flushed) when the picker is created at gateway start, if it is not there. Never truncated, rewritten, renamed or deleted by any code, including clean-up.
- **A purchase is refused while the journal is younger than 60 seconds** (by the file's creation time): "The purchase record was created just now; try again in a minute." This covers the one start in the life of an install on which the journal is new.
- **Claiming** a quote: build one record `{ id, nonce, entry, amount, unit, cap, claimedAt }` as a single line of JSON of at most 4 KiB; append `"\n" + line + "\n"` with **one** write on a handle opened for append; flush the handle (`fsync`); close. Then read the whole journal again and take the **first** record with this quote id. If its `nonce` is the one just written, this caller holds the claim. Otherwise the quote was already claimed: go to 5.4.
- A line that does not parse as a record but contains the quote id counts as a claim of that quote by nobody (answer: unknown). A line that does not parse and names no known id is skipped.
- Any error while appending, flushing or reading back: nothing is sent, and the answer says the purchase could not be recorded. If the append may have happened, the quote is spent.
- Quote ids are `Q-` plus 16 characters of the alphabet `ABCDEFGHJKMNPQRSTVWXYZ23456789` (80 random bits), so a search for the id in a line cannot match by accident.
- Quotes, outcomes and results stay one file each, written once (`wx`, flushed). Losing one of those to a power loss fails closed: no quote, no purchase; no outcome, "unknown".
- The ceiling is counted from the journal (records of the last 24 hours) together with the outcomes, as in 7.2. Clean-up deletes quote, outcome and result files as in 5.6 and never touches the journal.

In `design-D.md`, read "claim file" and `claims/<id>.json` as this journal record, and `EEXIST` on the claim as "the first record for this id is not mine".

## A2. Clocks (review finding 5)

Wall-clock time stays, with two rules that make a clock change harmless to money: nothing is ever sent again because time passed, and a status question always reads the outcome file first, so an "unknown" that was only a slow child is corrected by the next message. The ceiling is a limit against accidents, not a boundary (A5).

## A3. The picker can never take chat down (review finding 1)

- The mounted listener wraps the picker branch: a synchronous throw and a rejected promise are both caught, logged without any request content, and answered with a short error if nothing was sent yet. Requests that are not for the picker reach the original handler exactly as before.
- `classify` never throws, whatever the body: `system` as a string, a list or missing; `content` as a string, a list, or anything else; missing `messages`. A test feeds it malformed and hostile shapes.

## A4. Text that is not a prompt is never sent to a provider (review finding 6)

Before any quote, a tail that contains `JSON array of human messages`, `<goal_round`, `[SCHEDULE REMINDER]`, `<system-reminder>` as anything but a whole skipped message, or that is longer than the prompt limit, is never used as a prompt, whatever frames it. It gets the plain "this entry makes video clips: type what the clip should show" answer and no request is made.

## A5. What is not met, said plainly (review findings 3 and 4)

Decision 0005 must state:

- **"A subagent never buys" is not met.** An agent or any local program that can send two requests to the gateway and read the first answer can buy one clip per quote. It is limited by: purchases from chat being off until the user switches them on, the route never being selectable for agents (`verify` reports it, and the gateway refuses to buy while a profile exposes it), and the ceiling.
- **The ceiling limits accidents on the chat path only.** `dshproxy video submit` has no ceiling, and a program with file access can change the ceiling or the records.

## A6. A quote that cannot be matched does not loop (review finding 7)

When the message after an assistant turn is a confirming word but that turn does not match a stored quote word for word, the answer does not invite a new prompt. It says: "I could not match your confirmation to a quote, so nothing was bought. Type `status Q-…` with the quote's id to see it, or type the prompt again for a new quote." A reply of `status Q-…` reports that quote's state from the store and never buys.

## A7. Outcome files (review finding 8)

The child echoes the claim's `nonce` in the outcome it writes; an outcome without the right nonce is read as "unknown". This stops an accidental or stale file, not a determined local program (see A5). The gateway does not wait on the child after the client has gone: the child is left to finish and write its outcome.

## A8. API routes (the user's answer 1)

- An entry on VideoRouter, KovAPI or Callirra quotes **without any request to the provider**: the catalog's published price for that model and resolution, its date and its unit (US dollars, or Callirra credits).
- The quote text says so in its own line: "This is the published price of <date>. It is not checked with <Provider> before the job, and <Provider> decides the final charge."
- The purchase is `run(['submit', model, route, '--max-usd'|'--max-credits', amount, '--confirm-charge', '--resolution', R, prompt])` in the child, which resolves the key itself; the gateway process never reads a key.
- A second decision record, `0006-api-routes-from-chat.md`, replaces the last clause of 0004's "Unchanged" paragraph.

## A9. Ceiling defaults

Per rolling 24 hours, all apply: **10 clips; 15,000 Krea units; 20 US dollars** on dollar routes; **2,000 Callirra credits**. The dollar and credit figures are the lead's, derived from the user's 15,000 units at roughly the same money (Krea's API price for a clip that costs 629.63 units is $0.85; a Callirra credit is $0.01); the user is told and can change each with `dshproxy video picker ceiling ...`. An unknown outcome counts in full against its unit.

Settings file: `{ "purchases": false, "ceiling": { "clips": 10, "krea_units": 15000, "usd_micros": 20000000, "callirra_credits": 2000 } }`.
