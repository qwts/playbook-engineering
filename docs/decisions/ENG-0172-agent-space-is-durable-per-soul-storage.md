# ENG-0172: Agent Space is durable per-soul storage outside bot territory

**Status:** Proposed
**Date:** 2026-08-06
**Issue:** qwts/playbook-engineering#172

## Context

The agent identity runtime now creates one local Agent Space for each
transcript-bound Agent ID. The shipped mechanics establish a directory and
marker, but they do not decide how long that storage belongs to the soul, how
identity finalization affects it, or whether its location changes the bot
territory boundary. Leaving those rules implicit would let later population,
daemon, handoff, and cleanup work redefine the same storage contract.

The contract crosses repositories: `agent-bot-identity` implements the runtime,
while this repository governs execution identities and bot territory under
ENG-0081, ENG-0045, and ENG-0128. It therefore belongs in the ENG decision
home rather than as duplicated runtime documentation.

## Decision

1. **One soul, one Agent Space.** An Agent Space is durable, secret-free local
   storage keyed by one transcript-bound `agent_<uuid>`. The Agent ID is a
   lookup key and grants no authority. Reusing that Agent ID under the same
   effective spaces root resolves the same space; a newly minted or delegated
   Agent ID receives a different space.
2. **Lifetime follows the soul, not its checkout.** The space survives
   worktree or scratchpad deletion, context compaction, session reuse, and
   execution-identity finalization. Finalization records provenance; it is not
   retirement and does not authorize cleanup.
3. **Retirement is explicit and separate.** Explicit retirement is the only
   lifecycle event that may authorize Agent Space cleanup. No retirement
   command ships today, so spaces are not deleted or archived automatically.
   Retirement mechanics require separate runtime work before they can remove
   or relocate data.
4. **Path selection is user-controlled and deterministic.** Configured
   `AGENT_BOT_SPACES_HOME` and `XDG_DATA_HOME` overrides must be non-empty
   absolute paths. Resolution uses `AGENT_BOT_SPACES_HOME/<agent-id>` first,
   then `$XDG_DATA_HOME/agent-bot/spaces/<agent-id>`, with XDG data home
   defaulting to `~/.local/share`; empty values are treated as unset and fall
   through. Through `0.x`, the runtime resolves a non-empty relative value
   against the process working directory instead of falling back. That
   compatibility behavior is not stable configuration and must be migrated to
   an absolute override. Agents do not select arbitrary per-space roots, and
   changing the configured root does not imply migration.
5. **Agent Space is outside bot territory.** A space path does not become a bot
   checkout, commit-authority boundary, credential store, or `gh` identity
   boundary. Existing `.<tool>/worktrees` and recognized Claude scratchpad
   territory rules remain unchanged.
6. **Decision and runtime have separate owners.** `playbook-engineering` owns
   this cross-repository contract. `agent-bot-identity` owns Agent Space code,
   CLI behavior, marker schemas, setup, diagnosis, compatibility, and runtime
   tests. Runtime AGENTS and skill material link here and keep only operational
   guidance rather than restating the contract.

## Why

Keying durable storage to the opaque execution identity preserves continuity
across ephemeral worktrees and context windows without turning a data directory
into an authority signal. Separating finalization from retirement avoids data
loss when provenance becomes immutable. Keeping mechanics in the runtime and
policy here maintains the ENG-0128 process boundary and one source of truth for
each concern.

## Consequences

- Worktree deletion and identity finalization can leave durable local data that
  consumes disk until a future explicit retirement flow exists.
- Operators must treat root changes as storage-location changes; the runtime
  does not silently migrate or merge spaces across roots.
- Agent Space contents cannot hold credentials or other secrets. Population
  rows, export packs, and handoff transports inherit that boundary if added.
- Population schemas, a loopback daemon, gist handoff, retirement
  implementation, and content schemas beyond the shipped `space.json` marker
  remain out of scope for this record.

## Amendment — 2026-08-13: the default spaces root is `~/.agent-space`

Decision 4's default of `$XDG_DATA_HOME/agent-bot/spaces` — falling back to
`~/.local/share` — is superseded
([#217](https://github.com/qwts/playbook-engineering/issues/217)). With no
override configured, the effective spaces root is `~/.agent-space`
(`$HOME/.agent-space`), and one soul's space is `$HOME/.agent-space/<agent-id>`.
The original text stays as written, per the rule that records are amended
rather than rewritten. Decisions 1–3, 5, and 6 stand unchanged, as does
decision 4's rule that agents do not select arbitrary per-space roots.

1. **Overrides are unchanged in kind.** `AGENT_BOT_SPACES_HOME` and a
   configured `settings.spacesRoot` are explicit overrides that win over the
   default; when both are set, `AGENT_BOT_SPACES_HOME` wins, so resolution
   still yields exactly one effective root. They remain non-empty absolute
   paths, and the `0.x` relative-value compatibility behavior stated in
   decision 4 applies to them unchanged. `XDG_DATA_HOME` no longer
   participates in resolution at all; from this amendment it names only the
   legacy tree the one-time cutover reads.
2. **One authorized cutover, fail closed.** When no override is configured,
   the legacy tree (`$XDG_DATA_HOME/agent-bot/spaces`, otherwise
   `~/.local/share/agent-bot/spaces`) holds spaces, and `~/.agent-space` holds
   none, the next install, update, or bootstrap run performs exactly one
   migration — those three are the only movers. It completes or it fails; a
   partial move is a failure, and a failure leaves the legacy tree intact and
   authoritative. The live population is never split across two roots, and two
   populated trees are never merged. A root holds spaces exactly when it
   contains at least one soul directory (`<agent-id>/`); an absent root, an
   empty directory, and stray non-soul entries all hold none.
3. **Ambiguity is the operator's call.** If both roots hold spaces and no
   completed cutover is recorded, the runtime fails and tells the operator to
   choose a root explicitly. It does not pick, guess, merge, or prefer the
   newer tree. The target of a failed migration is not a populated tree for
   this test: a retry discards or ignores the partial target and reads the
   legacy tree as authoritative, so a failure never converts itself into this
   conflict.
4. **The cutover is idempotent.** The completed-cutover record is secret-free,
   workstation-local, and written only after a complete move — never for a
   partial one. Once it exists, later installs, updates, and bootstraps are a
   no-op: the legacy tree's continued existence neither re-triggers the
   migration nor re-raises the item 3 conflict.
5. **The cutover is operator-visible.** It reports which root it read, which
   root it wrote, and how many spaces moved. That report is secret-free, like
   the spaces themselves.
6. **Changing an override still does not migrate.** Decision 4's rule holds for
   every configured root. What is authorized here is the single default move
   from the ENG-0172 XDG home to `~/.agent-space`, and nothing else.

An Agent Space remains local, secret-free, and outside bot territory. It is not
a cloud slice, and backup — git, or the existing secret-free pack — stays an
operator concern. The amendment is harness-neutral: no root, cutover step, or
failure mode differs by harness. Runtime implementation is
[agent-bot-identity#105](https://github.com/qwts/agent-bot-identity/issues/105)
under [epic #104](https://github.com/qwts/agent-bot-identity/issues/104); per
[ENG-0128](ENG-0128-agent-bot-runtime-ownership.md) this repository ships no
spaces-root code.

Consequences of the amendment:

- Every installation using the default root moves once, at a moment the
  operator can see. Installations pinned to an explicit override never move.
- The item 3 failure is a hard stop on install, update, and bootstrap for
  anyone who has populated both trees. That is the accepted cost of never merging soul
  storage on the runtime's own initiative.
- Decision 1 keys a space to an Agent ID *under one effective root*, so this
  cutover is the one sanctioned event that changes where an existing Agent ID's
  space resolves without minting a new Agent ID. Any later default change needs
  its own record and its own authorized move.

## References

- [ENG-0045](ENG-0045-agent-environments-are-bot-territory.md) — bot territory remains path-based and unchanged
- [ENG-0081](ENG-0081-transcript-bound-agent-execution-identities.md) — the Agent ID that keys each space
- [ENG-0128](ENG-0128-agent-bot-runtime-ownership.md) — runtime and governance ownership boundary
- [Agent Space runtime issue](https://github.com/qwts/agent-bot-identity/issues/36) — shipped behavior and runtime pointer work
- [Agent Space epic](https://github.com/qwts/agent-bot-identity/issues/35) — later population, daemon, and handoff work
