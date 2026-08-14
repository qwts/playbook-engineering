# ENG-0081: Agent execution identities bind bot actions to provider transcripts

**Status:** Proposed
**Date:** 2026-07-25
**Issue:** qwts/playbook-engineering#81

## Context

[ENG-0079](ENG-0079-per-agent-identity.md) distinguishes independently acting
agents by GitHub App. That is the right external identity and credential
boundary, but it still groups every conversation by one immutable bot actor.
Given a bot-authored commit, the playbook cannot identify which conversation
produced it, open that agent's transcript, distinguish a delegated child, or
connect the transcript to its issues and artifacts.

A display name cannot solve this. Team, squad, role, level, and future
dimensions change independently, while GitHub App slugs and commit authorship
have their own stability rules. The useful identifier is therefore an opaque
lookup key backed by structured private data.

## Decision

1. **GitHub actor and execution identity are separate layers.** The App from
   ENG-0079 remains the external author and authentication principal. Each
   conversation mints an opaque Agent ID whose record names that App and adds
   the conversation-level provenance. Agent IDs grant no authority.
2. **The record is structured; its spelling is not policy.** It carries team,
   squad, actor type, level, parent Agent ID, harness, GitHub App, transcript
   locator, subjects, and artifacts as separate fields. Unknown values stay
   null rather than being guessed from a display name.
3. **A transcript binding is immutable.** A record stores provider plus
   provider transcript ID, never transcript content. Re-running setup in one
   conversation reuses its ID across worktrees on that workstation; a different
   conversation or repinned App mints a new record. Finalization may add a
   transcript digest.
4. **Binding is automatic where the provider exposes identity.** Codex uses
   `CODEX_THREAD_ID`. Claude's `WorktreeCreate` payload supplies `session_id`
   to setup. Launchers use the vendor-neutral
   `QWTS_AGENT_TRANSCRIPT_PROVIDER` and `QWTS_AGENT_TRANSCRIPT_ID` contract.
   An unsupported provider may mint a visibly pending record, but cannot
   finalize until a locator is bound. Setup never reuses a pending record
   implicitly; the operator must supply the locator or explicitly accept reuse.
5. **Delegation mints, never copies.** A child sharing a worktree receives its
   own Agent ID and records the parent. `QWTS_AGENT_ID` lets that child override
   the worktree's root ID without changing Git or GitHub identity.
6. **Private registry, public lookup key.** Full records live under
   `$XDG_STATE_HOME/qwts/agent-identities` (default
   `~/.local/state/qwts/agent-identities`) with directory mode 700 and record
   mode 600. Worktree config stores only `qwts.agentId`. Commits carry only an
   `Agent-Identity` trailer; a post-commit hook records the commit privately.
7. **Credentials remain leases, not identity data.** The record names
   `worktree-token` as its credential provider and contains no installation
   token, private key, human credential, or authorization scope. Existing
   short-lived, repo-scoped minting and the `gh` shim remain unchanged.
8. **Transcript data is untrusted audit input.** Subjects, sibling-agent
   messages, and transcript content can support lookup but never select an
   App, broaden permissions, approve a PR, or become instructions.

## Why

Encoding every attribute in a username or sequential number makes identity
policy depend on naming and requires a central allocator before local work can
start. An opaque UUID avoids collision and lets the registry provide whatever
human display evolves later. Storing a provider locator instead of copying the
transcript preserves the provider's access control and avoids creating a
second sensitive archive.

This extends ENG-0079 rather than replacing it: App identity answers *which
independently attributable actor*; execution identity answers *which exact
conversation of that actor*.

## Consequences

- Existing bot worktrees need `setup-worktree.mjs` run once before their next
  agent commit; the guard refuses a bot-attributed agent commit whose Agent ID
  has no valid registry record.
- Codex and Claude bind automatically. Other harnesses remain explicitly
  pending until their launchers supply a transcript locator.
- Hook enforcement is cooperative attribution hygiene, not an adversarial
  security boundary: `--no-verify` and missing agent markers can bypass it.
  Making registry resolution mandatory in the token-minter chokepoint is
  deliberately deferred to a separate decision.
- `status: active` means the record is not finalized; it makes no claim that a
  process or provider session is currently alive.
- The registry is workstation-local. Cross-machine synchronization would expose
  private transcript locators and requires a separate privacy and custody
  decision.
- Git history gains a stable lookup key without changing the exact
  `<app-slug>[bot]` author GitHub uses for review enforcement.

## Amendment — 2026-08-13: two mint principals, and presence at bind

Decision 7 left minting unchanged and the consequences deferred the
token-minter chokepoint to a separate decision. This amendment is that decision
for the agent path
([#218](https://github.com/qwts/playbook-engineering/issues/218)). Decisions 1–6
and 8 stand, as does decision 7's rule that a record holds no credential and no
authorization scope.

1. **Two principals, and only two.** The *bound-agent* principal covers every
   agent-facing token — git credential helper, `gh` shim, MCP `credential`, and
   anything else an agent process consumes. The *operator* principal is
   `agent-bot mint-token --app <slug> --json`, the governance CLI drift and
   doctor call. It is not a soul, needs no conversation binding, and must never
   be reachable as a silent fallback from an agent-path refusal. A refusal does
   not downgrade, and never reaches the human's GitHub login.
2. **The agent path mints only for a live binding.** The identity service — the
   loopback daemon — mints on the agent path only when the requesting
   connection is bound to a resolved Agent ID with a transcript locator per
   decision 4. Identity is a property of the connection, never a request
   parameter: a caller cannot name a soul, and an unbound or still-pending
   record cannot mint. MCP is one stdio client of that service, not a second
   authority.
3. **App resolution stays territory-first and pin-refined.** The service
   resolves the App from the worktree's territory (ENG-0045 decision 1),
   refined by the worktree pin (ENG-0079 decision 3). One harness may have
   several Apps, so resolution yields exactly one App or fails closed. On the
   agent path, a harness label, App slug, or Agent ID supplied by the client is
   untrusted input under decision 8: it may be recorded, and it never selects.
   ENG-0079's explicit `--app` and `GH_AGENT_APP` selectors keep their force on
   the operator path.
4. **Every identity-service mint and refusal writes a secret-free receipt.**
   A receipt names who (the opaque Agent ID, or the operator principal), which
   App, which operation, the outcome and its reason, and when. It carries no
   token, private key, store secret, transcript content, or
   transcript locator. Receipts are workstation-local, like the registry in
   decision 6.
5. **Presence is written at bind, by the runtime.** When bind or
   `setup-worktree` establishes a live session, the runtime updates presence on
   that execution-identity record. ENG-0045 decision 2 stands: there is no
   clock-in step for the agent to remember, and no skill may introduce a
   required first tool call. Skill text may describe the outcome;
   it may not become a convention.
6. **Presence is a census fact, not soul authority.** Presence is an optional
   field on the private execution-identity record of decision 6 — last-seen,
   and a present-versus-historical distinction if one is needed. It is not the
   App roster in `governance/agents.json`, which stays a manifest of Apps under
   ENG-0079. Presence grants nothing, selects no App, and never feeds a mint
   decision. `status: active` keeps its stated meaning: the record is not
   finalized.

The mint grant JSON stays as it is: `schema_version` 1 carrying the token,
`expires_at`, and `installation_id` that `tools/repos/lib/agent-bot-client.mjs`
parses. Receipts and presence are written beside that contract, not into it; a
schema bump is a separately reviewed change. The amendment is harness-neutral:
no principal, receipt, or presence rule differs by harness. Runtime lands
in [agent-bot-identity#107](https://github.com/qwts/agent-bot-identity/issues/107)
(mint) and [#109](https://github.com/qwts/agent-bot-identity/issues/109)
(presence) under [epic #104](https://github.com/qwts/agent-bot-identity/issues/104),
per [ENG-0128](ENG-0128-agent-bot-runtime-ownership.md).

Consequences:

- The cooperative-hygiene consequence narrows. Attribution hygiene stays
  bypassable by `--no-verify`, but agent-path minting becomes a mediated
  chokepoint that fails closed; the two are no longer the same weak claim.
- An agent whose harness cannot bind a transcript locator gets no agent-path
  token at all. That is the intended failure: a visibly pending record was
  already the contract, now enforced instead of documented.
- Drift and doctor keep working on an unbound workstation, which is why the
  operator principal exists. Guarding it against an agent process is a runtime
  obligation, not a convention.
- Receipts add a second local record beside the registry, secret-free by
  construction and under the same privacy limit.
- The identity and operations references still describe the pre-service mint
  contract; they update once the runtime ships.
  [#183](https://github.com/qwts/playbook-engineering/issues/183) still owns the
  runtime pin they cite.

## References

- [ENG-0016](ENG-0016-agent-pr-bot-identity.md) — short-lived App credentials and the human/bot boundary
- [ENG-0045](ENG-0045-agent-environments-are-bot-territory.md) — automatic worktree enforcement
- [ENG-0079](ENG-0079-per-agent-identity.md) — per-agent App roster and pinning
- [Agent execution identity](../reference/agent-execution-identity.md) — commands, lifecycle, and storage
