# ENG-0339: The macOS account determines the persona

**Status:** Proposed
**Date:** 2026-08-31
**Issue:** qwts/playbook-engineering#339

## Context

[ENG-0016](ENG-0016-agent-pr-bot-identity.md),
[ENG-0045](ENG-0045-agent-environments-are-bot-territory.md), and
[ENG-0079](ENG-0079-per-agent-identity.md) built agent identity inside one
shared macOS account: the worktree's directory decides whether work is bot
territory, the environment detects the harness, and a worktree pin refines the
agent. That model works, but its boundary is a naming convention. Every
harness runs as the same UID, reads the same keychain, and can reach every
other agent's state and the human's credentials. Whether a commit is
attributed to a bot or to the human flips on which directory a session
happened to start in — an invisible distinction with a wrong-identity failure
mode, and no place in it for the opposite case: a harness deliberately acting
as the human's delegate.

The fleet is also moving to a different operating shape: agents driven through
fast user switching and Slack/Telegram bridges, running concurrently and
unattended, rather than sessions launched by hand from the owner's desktop.

## Decision

1. **The macOS account running a harness determines its default persona.**
   Directory location no longer decides bot versus human. Only the explicit
   identity mechanisms of ENG-0079 — `--app`, `GH_AGENT_APP`, and the worktree
   pin `qwts.agentApp` — override the account, exactly as they outrank
   detection today. In resolution terms the change is deliberately minimal:
   the account replaces environment detection as the fallback layer, and
   every layer above it is untouched.
2. **One standard macOS account per harness, named by convention.** The
   account's short name *is* the harness-level slug from
   [`governance/agents.json`](../../governance/agents.json) — account
   `qwts-devin-agent`, full name "Devin". The roster gains no new field and no
   second file exists: drift derives the account mapping from the active
   roster plus this rule.
3. **The owner's account resolves to the human persona by default.** Unpinned
   work from the `user` account (christopher kane) is authored as the human
   `qwts` GitHub account; a harness run there is a **delegate** operating
   under the human persona, with human attribution and accountability. An
   explicitly pinned worktree keeps its pinned agent identity even in the
   owner's account — existing pinned worktrees neither flip attribution nor
   stop working. What ends is only *implicit* bot identity: an unpinned
   worktree in a territory directory no longer resolves to the harness App by
   detection.

   Delegate work is human work end to end. It mints no execution identity,
   carries no `Agent-Identity` trailer or other agent marker, and follows the
   human's own workflow — so the existing guard that rejects agent-marked
   commits with human attribution never fires on it. And because the
   [branch/PR SOP](../sop/branch-pr-review.md) forbids agent PRs authored by
   the human account (the author cannot approve their own PR, making the
   human-review requirement unsatisfiable), delegate mode is bounded: work
   intended for the agent review path — a bot-attributed PR with a human
   approval — must be pinned or run in its harness account. A delegate never
   opens an "agent PR as the human"; ENG-0016's rule stands.
4. **Per-model pins still refine identity within a harness account.**
   ENG-0079's two levels survive with the harness level relocated: the OS
   account answers *which tool's persona*, the worktree pin
   (`qwts.agentApp`) answers *which agent inside it*. Territory directories
   (`~/.claude/worktrees`, `~/.muse/worktrees`, …) remain each harness's
   working layout inside its own account, but they no longer carry the
   bot-versus-human decision.
5. **The `agent-bot` runtime contract is unchanged.** No CLI, hook, credential
   helper, or registry interface changes (ownership per
   [ENG-0128](ENG-0128-agent-bot-runtime-ownership.md)). The runtime change is
   one addition to harness detection: the account short name is itself a
   detection input, and because agent account names *are* roster slugs it
   resolves in an agent account to exactly what environment detection resolves
   today. In the owner's account that input yields "human", which is the sole
   behavioral difference.
6. **No per-account provider sign-ins.** Agent accounts do not log into
   anything as themselves; the only credential activity is minting short-lived
   repo-scoped tokens exactly as today (ENG-0016 flow).
7. **Machine-global shared state lives in `/Users/Shared/Public`, falling
   back to `/tmp`.** The [ENG-0138](ENG-0138-machine-scoped-agent-memory-budget.md)
   arbiter and any other machine-scoped coordination use this space so that N
   accounts share one budget — a per-account lock would recreate the
   per-worktree bug one level up. Tooling creates `/Users/Shared/Public` with
   the sticky bit on first use; the `/tmp` fallback is cleared on reboot and
   is therefore acceptable for locks and admission state only, never for
   anything durable.

   The lock layout must permit **cross-account stale-lock recovery**. The
   current `breakStaleLock()` removes the lock directory recursively, which
   fails across UIDs inside a sticky directory — a crashed agent account would
   deadlock every other account's admission forever. The arbiter's own lock
   area is therefore a non-sticky, world-writable subdirectory (sticky
   protection stays on the shared root), or the lock protocol moves to
   ownership takeover; on a single-operator machine the weaker deletion
   protection is an accepted trade. The launch-daemon phase can graduate this
   to a broker that owns admission outright.
8. **Sessions run under fast user switching; daemons come later.** Switched-out
   accounts keep their sessions alive. CLI harnesses will eventually be wired
   to launch daemons so Slack and ACP reach them headlessly; harnesses that
   require an IDE stay manual — the owner switches in, logs in, and runs them.
9. **Each persona manages its own execution-identity records.** The
   [ENG-0081](ENG-0081-transcript-bound-agent-execution-identities.md)
   registry stays private to each account's home; a persona that must expose
   audit data publishes it itself, into its home or the shared space. No
   cross-account ACLs are granted.

## Why

An OS account is a boundary the kernel enforces — distinct UID, home,
keychain, and file permissions — where a directory convention is a boundary
everyone must remember. Moving the persona decision to the account removes
the entire class of "session started in the wrong directory" misattribution:
inside an agent account there is no human credential to leak and no way to
author as anyone else; inside the human account nothing *implicit* reaches for
a bot credential — only a deliberate pin does — which is what makes delegate
mode safe to define at all.

Keeping the pin as the override, rather than making the account absolute, is
what keeps this from being a rework. The resolution ladder loses no rungs and
gains none; its bottom rung changes meaning. Every existing pinned worktree,
launcher, shim, and hook behaves identically, and the migration can proceed
account by account with no flag day.

Naming the accounts by roster slug keeps ENG-0079's "the roster is data"
without adding a second roster to drift out of sync. The mapping is derivable,
so registering an agent remains the single act that makes it checked.

## Consequences

- **Amends ENG-0045 and ENG-0079, and refines the human-versus-bot boundary.**
  Territory moves up a level: the account, not the directory, is bot
  territory. ENG-0045's directory rules survive as layout conventions inside
  each account; ENG-0079's pin resolution is unchanged. ENG-0016's
  App-per-actor model and the never-as-the-human PR rule stand — what this
  record adds is that a harness producing plain, unmarked human work in the
  owner's account is delegate use, not an identity incident; agent-marked
  work with human attribution remains one. ENG-0128's runtime ownership is
  unaffected.
- **Only unpinned bot worktrees in the owner's account change meaning.**
  Pinned worktrees — the normal case per the roster — keep their agent
  identity wherever they live. An unpinned territory worktree in the owner's
  account flips from detection-derived bot attribution to human attribution;
  such worktrees should be pinned, or moved into their harness account, as
  they are next touched. No flag-day migration is required.
- **N accounts to provision and keep healthy.** Each needs its harness
  installed, `agent-bot` installed, and its App key provisioned into its own
  home — multiplying setup that used to happen once. Convention makes the
  accounts checkable but not self-creating.
- **Audit loses direct reads.** The owner's account cannot open another
  account's mode-700 registry; visibility depends on each persona publishing.
  A persona that publishes nothing is dark until someone switches into it.
- **Until launch daemons exist, headless operation is partial.** macOS may
  throttle switched-out sessions, and IDE-bound harnesses remain
  attended-only by design.
- **`/tmp` fallback weakens the shared space.** A reboot clears it, so any
  coordination state there must be reconstructible; tooling must treat absence
  as "rebuild", never as "no other agents exist".
