# ENG-0151: Model routing is retrieved from a registry, never recalled

**Status:** Proposed
**Date:** 2026-08-03
**Issue:** qwts/playbook-engineering#151

## Context

Issues in this fleet are increasingly executed by agents, and which agent
executes one materially changes the outcome. qwts/bookmarkit#124 is the worked
example: a one-file change whose three real failure modes — a required-check
name that would not match, an Actions Policy interaction that explains why the
setup is what it is, and a signed-commit requirement — are all invisible to a
model that stops at "the file exists".

Naming a model in the issue fixes that. But an agent writing the issue has a
training cutoff, so any model name it produces from memory is current only as of
that cutoff and stale afterwards — and it fails *confidently*, because a
superseded name reads exactly like a good one. Model names churn every few
months across every vendor, so this is the steady state rather than an edge case.

Two simpler designs were considered and rejected:

- **A hand-maintained document.** Precisely the thing that goes stale; nobody
  updates it on the day a model ships.
- **A live web lookup per issue.** Non-deterministic, slow, and unavailable to
  most harnesses that open issues here. Two agents filing two issues in the same
  hour would get different answers.

## Decision

1. **The routing lives in a registry, and issue authors read it.**
   `governance/agent-models.json` in
   [agent-bot-identity](https://github.com/qwts/agent-bot-identity) is the
   single retrieval target, exposed by
   `agent-bot-identity/tools/models/registry.mjs`
   (moved there 2026-08-22 with the rest of the agent-identity surface). Reads
   are offline, fast, and identical for every agent; freshness is a separate
   lane's problem, not the issue author's.

2. **Recalling a model name from memory is a violation, and saying "unknown" is
   not.** The issue-lifecycle SOP requires citing the registry's `verified_at`,
   and requires an author who cannot read it to say so rather than substitute a
   remembered name. The registry renders unconfirmed slots as
   "unverified — do not guess" rather than omitting them, because a silently
   dropped row reads as "no recommendation exists".

3. **Tiers, not vendors, are the stable abstraction.** T1 judgment, T2 build,
   T3 mechanical describe the *work*; the registry maps each tier to whatever is
   current per vendor group (Anthropic, OpenAI, Chinese, IDE-native). A model
   release changes one file and no decision.

4. **Every slot carries a status.** `verified` (confirmed against vendor docs by
   a refresh run), `seeded` (written by hand at authoring time, provisional), or
   `unverified` (never confirmed, and forbidden from naming a model). Validation
   rejects the combinations that would let an unconfirmed slot read as a
   recommendation.

5. **Access policy is data, not prose.** Chinese models are reachable only
   through Cursor or Devin — no direct vendor accounts, no direct API access, no
   first-party clients — because we do not adopt products associated with the
   CCP. Reaching a model through an IDE we already run is a different posture
   from installing the vendor's own product. The constraint is a validated field,
   so a refresh reading vendor documentation cannot widen it by rewriting a
   sentence; adopting a direct route is a human decision.

6. **Refresh is manual and owner-gated.** A `workflow_dispatch` workflow opens
   the refresh task and hands it to the coding agent. Deliberately not a
   schedule: model releases are known events, and a scheduled run that reaches
   nothing looks identical to a genuine no-change week. `workflow_dispatch` alone
   only requires *write*, so the workflow additionally guards on
   `github.triggering_actor` — with a failing step rather than a job-level `if:`,
   which would mark the job skipped and leave an unauthorized attempt with no
   visible trace.

7. **The registry is reachable from every governed machine, not synced into
   every repo.** It lives in the agent-bot-identity checkout each governed
   machine already carries (the installed `agent-bot` CLI is a symlink into
   it), so the SOP's lookup works wherever an issue is filed without
   distributing per-repo copies. Refreshing happens in that one place.

8. **`verified_at` advances only on a successful read.** A failed refresh that
   stamped a fresh date would hide staleness behind a current-looking timestamp —
   the same failure this record exists to prevent, relocated.

## Consequences

- The registry ships **provisional**: `verified_at` is `null` and the Anthropic
  column is `seeded` rather than `verified`, because it was written by hand and
  never checked against vendor documentation. The remaining eighteen slots are
  `unverified`. This is deliberate — seeding them with plausible values would
  have reproduced the exact failure the record forbids — and it makes the first
  refresh run meaningful rather than ceremonial.
- Issues will cite "unverified" for most vendor groups until a refresh lands.
  That is a visible, honest gap rather than a confident wrong answer.
- The Copilot coding agent is **not currently assignable** on this account —
  `suggestedActors(capabilities:[CAN_BE_ASSIGNED])` lists only the owner — so the
  refresh workflow detects that and assigns the owner instead, with a warning,
  rather than silently leaving a task nobody owns.
- With the registry in agent-bot-identity rather than synced per repo,
  downstream repos need no formatter or linter exclusions for it; the earlier
  plan to mirror it (and its ignore PRs) is retired.
- A tier assignment is a judgment the issue author must make and defend. The SOP
  asks for the reason precisely where it is least obvious: when the tier
  disagrees with the size of the diff.
