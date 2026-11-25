# DSHProxy desktop self-update

Goal: allow a Mac or Windows desktop user to check for and install a DSHProxy update. Distinct from the existing CLIProxyAPI backend updater. Updates are initiated by the user, not automatic.

Acceptance contract:
- Both desktops show “Check for DSHProxy updates…”. Checking makes no install changes. Display installed and candidate short SHAs, commit subject and a link to the official commit, or an explicit up-to-date / unavailable result.
- Resolve the newest commit on the official main first-parent history with a successful official push CI workflow for that exact SHA; a pending or failed tip is not installable. Do not trust PR builds or a mutable branch name as an install target. Do not downgrade an installed newer revision.
- Install only after confirmation; bind installation to the exact checked SHA. Do not interrupt active requests. Preserve gateway settings, accounts, keys and lanes. Preserve whether the gateway was running.
- Preflight supported install layout, prerequisites, disk/write access and local modifications. For unsupported installs, missing tools, or local changes that could be lost, explain why installation is unavailable and offer manual instructions. No privilege escalation or destructive checkout reset.
- Stage the candidate and build before switching. Verify the relaunched app and, when previously running, gateway health. If activation fails, restore the previous revision and report recovery status.
- Verify with isolated local fixtures for candidate selection, cancellation, active turns, local changes, failed build, failed activation, rollback and success. No real user installation or release is changed during development.

Non-goals: scheduled updates; updating CLIProxyAPI independently; modifying credentials; publishing, signing a distribution release or installing on the user's machines as part of feature development.
