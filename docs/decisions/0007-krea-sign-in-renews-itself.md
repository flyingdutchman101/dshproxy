# 0007 — The Krea sign-in renews itself

Accepted 2026-11-23 at the user's request ("This needs to be permanent. Do renewal"), made after being told that it means keeping a longer-lived credential on this computer. Replaces one sentence each of 0003 and 0004; everything else in them stands.

**Replaces in 0003** "Workspace expiry requires user action; the router cannot renew tokens". The router still cannot. The helper now can. **Replaces in 0004** "nothing signs in on its own or renews a session". Nothing signs in on its own; a sign-in the user made is renewed.

**What is new.** Krea's access token lasts one hour. At sign-in the helper now asks Krea for a renewal token as well and keeps it in the same file as the access token, encrypted for the current Windows user as before. When any helper call, `status` included, finds less than two minutes left, the helper first asks Krea's token endpoint for a new access token. One request, no loop. The renewal token is sent only to the token endpoint that the sign-in named, and only if that is an `https` address on a Krea host.

**When renewal fails.** Krea answers 400, 401 or 403: the renewal token is dropped, what is left of the hour still works, and then a new sign-in is needed. Anything else (no answer, 408, 425, 429, 5xx, an answer that cannot be read): nothing is changed and the next call tries again with the same renewal token. A renewal is never the reason a paid request is sent twice: it happens before the request, and a failed one sends nothing.

**Several helpers at once.** A renewal runs under a lock beside the file, and looks again under the lock, so two helpers make one renewal. The lock names its holder: a helper that died is recognised and its lock is taken over at once, without anybody clearing anything by hand. A helper that is running keeps its lock for two minutes, which is longer than a renewal can take. Should two helpers send the same renewal token all the same, the one Krea refuses looks at the file again and leaves the other's renewal in place. A sign-in that is waiting at the consent page holds no lock. `status` waits five seconds for the lock at most, since the desktop app gives it twenty.

**Cost of this decision.**

- The file now holds a credential that works until the user signs out or Krea ends it, not for one hour. Any program running as this Windows user could already read the file; what it gets is now worth more.
- Signing out removes the file. Krea publishes no address for withdrawing a renewal token, so a copy taken earlier is not made invalid by signing out here; that takes removing the application in the Krea account.
- `status` can now make a request to Krea (the renewal). It did not before.
- If Krea replaces the renewal token and the answer is lost on the way, or the new one cannot be written to disk twice in a row, the old one is refused later and a new sign-in is needed. There is no way around this without Krea's help.

**Not known on the day of the decision.** Krea accepted a registration that asks for renewal (2026-11-23). Whether a sign-in then comes with a renewal token, and for how long Krea honours one, shows only with a real sign-in and a wait of more than an hour. Where Krea grants none, a sign-in lasts an hour as before, and `status` says so (`canRenew: false`).
