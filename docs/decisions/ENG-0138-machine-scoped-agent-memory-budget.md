# ENG-0138: The local memory budget is machine-scoped and derived from the machine

**Status:** Proposed
**Date:** 2026-08-02
**Issue:** qwts/playbook-engineering#138

## Context

Local development machines are a shared, finite resource that nothing in this
org was accounting for. Agents write most of the code (ENG-0002), several agent
sessions now run concurrently across worktrees and repos, and each one follows
its repo's documented validation gates as if it were alone on the box.

On 2026-08-02 an 8 GB machine was driven into memory exhaustion during a routine
PR review. One agent ran `npm run ci`, `npm run test:e2e`, a targeted E2E rerun
and `npm run test:stories:ci` in sequence; each fans out to 10–15 workers at
400–500 MB, and every E2E worker boots a full Electron app. Codex, Cursor,
Brave, ChatGPT and further agent sessions in other worktrees were running at the
same time. The machine reached 7.38 GB of 8 GB used with 11.05 GB of swap
committed and memory pressure red, and the owner had to force-close agents to
recover it. This had happened repeatedly, across both Claude Code and Codex.

A process-tree guard already existed — `qwts/image-trail` wrote one after its
own runaway, and `qwts/overlook` adopted a copy. It did not fire, for three
independent reasons:

1. **Ceilings were constants.** `DEFAULTS.rssMb = 4096`, and the e2e script
   passed `--rss-mb 8192`. A ceiling at or above total RAM cannot trip, so the
   guard was inert on precisely the machines that needed it.
2. **Nothing looked before it leapt.** No check of available memory or swap
   before spawning. The guard would launch three Electron workers with 600 MB
   free and 11 GB of swap already committed — the actual brick condition, which
   nothing measured.
3. **The lock was per worktree.** `<worktree>/.guard/active.json` gave every
   worktree, repo and agent tool its own lock, so N agents each correctly
   concluded they were the only run on the machine.

The third is the root cause: a budget whose scope is the checkout cannot
describe a resource whose scope is the machine. The first two made the
individual runs unbounded as well.

The two copies had also drifted apart — different env-var prefixes, different
blocked patterns, one with CI passthrough and one without. A shared fact in two
places is a bug (ENG-0006), and here the bug was that neither copy could be
fixed once.

## Decision

A machine-scoped admission-control arbiter, owned here and consumed by governed
repos. Concretely:

1. **Coordination state is per machine, not per checkout.** Runs take leases in
   one per-user directory (`$XDG_RUNTIME_DIR`, else `~/Library/Caches` on macOS,
   else `~/.cache`), so a Codex session in image-trail and a Claude Code session
   in overlook see each other. A run is admitted only if outstanding leases plus
   measured availability keep projected usage inside the budget.
2. **Every number derives from `os.totalmem()` and live readings.** No constant
   ceilings anywhere. A requested ceiling above the machine cap is clamped down;
   tightening is always allowed, loosening never is, so a stale `--rss-mb 8192`
   becomes a ceiling that can actually trip instead of one that cannot.
3. **Availability and swap are measured before spawning.** `vm_stat` plus
   `sysctl vm.swapusage` on macOS, `/proc/meminfo` on Linux. A refusal names the
   arithmetic and the processes holding the memory. Probe failure degrades to an
   explicitly-marked estimate rather than to optimism.
4. **Leases are validated by process liveness and nothing else.** A crashed or
   force-closed agent's lease is reaped by the next reader. Validity is **not**
   keyed on hostname: qwts/overlook#842 is the paid lesson, where `.local` ↔
   `.lan` drift made crashed same-machine locks permanently unreclaimable and
   turned crash recovery into the outage. A locally-minted random token, stored
   with the state it identifies, distinguishes a restored or copied state
   directory without ever consulting a name the network can change.
5. **Agents and the owner are governed differently.** Agents are denied the
   heavy lanes (e2e, storybook, perf, coverage, full `ci`) by default and told to
   push and let CI verify. The owner is never refused *by policy* — their runs
   are clamped and headroom-checked like any other, and a refusal for genuine
   memory pressure remains overridable in their own terminal. The heavy-lane
   opt-in for an agent is an out-of-band, time-boxed grant the owner creates:
   an environment variable would be an opt-in the agent grants itself, since the
   agent composes its own command lines.
6. **CI is exempt entirely.** Hosted runners are disposable, isolated and
   already bounded by job timeouts. They were never the problem and must not be
   slowed down.
7. **Enforcement covers every harness.** Claude Code `PreToolUse`, Cursor
   `beforeShellExecution` and Codex `PreToolUse` all invoke the same hook. A
   guard only one harness honours does not solve a problem that Codex sessions
   caused half of.

### Distribution: the harness sync, not a reusable workflow or a skill

The guard ships through the fleet harness sync that already carries
`.claude/settings.json` and `.codex/`, extended to cover the tool itself and the
Cursor and Codex hook files. The two alternatives in this repo were considered
and rejected on structural grounds:

- **The docs-gov model** (an env-gated external checkout, pinned to `@v1`) runs
  the tooling *in GitHub Actions against the caller's repo*. This guard must run
  on a local machine, inside a pre-execution hook, at the moment a command is
  typed — and CI is exempt by design. There is no CI job for it to live in.
- **`skills/`** is manual symlink distribution into `~/.claude/skills`, and is
  Claude-only. Codex and Cursor do not read it, and the wrapper must be
  invocable as a repo-relative path from `package.json`.

The harness sync already opens bot-authored PRs into each repo, verifies content
by blob SHA, and — since the incident where it replaced `.claude/settings.json`
wholesale — merges only governance-owned JSON paths while preserving the rest.
`hooks.PreToolUse` joins that owned set. Copies in consuming repos are therefore
*generated and SHA-verified*, not maintained: drift is impossible by
construction and the sync PR is the only edit path. That is the ENG-0006-shaped
answer the two hand-maintained forks never were.

### Rollout

1. **playbook-engineering** — this record and the implementation.
2. **overlook** — where the incident happened and which has every heavy lane.
   Repoint the npm scripts at the governed wrapper, delete the local fork, drop
   the heavy lanes from the `permissions.allow` list that made them routine, and
   rewrite the AGENTS.md "Validation" section.
3. **image-trail** — the original guard's home; delete its fork the same way.
4. **Everything else** (cartograph, bookmarkit, quorum, agent-bot-identity,
   codex-rules-editor, playbook-dashboard) — by routine harness sync. None has a
   heavy lane today, so the guard is inert there but present and
   conformance-tested, which is what stops the next repo being born unprotected.

Each repo lands via PR under its own review rules, and each carries the
conformance test that ships with the tool, so a future sync cannot silently
remove the enforcement point the way one already did once.

## Consequences

- **Agents lose the ability to fully verify locally.** That is the point, and it
  is a real cost: an agent now discovers some failures a CI round-trip later
  than before. Accepted, because the alternative is the owner's machine, and
  because CI is the authoritative lane regardless of what ran locally.
- **A refusal is a real refusal.** A run that cannot be admitted does not
  silently proceed, so a busy machine will occasionally block work the owner
  wanted done now. The owner's escape hatch is deliberately human-only, which
  means an agent's correct move when blocked is to report the refusal — not to
  find a way around it.
- **The budget formula is a guess, and will be wrong somewhere.** A quarter of
  RAM reserved for the desktop is generous on 8 GB and probably wasteful on 64.
  It is one formula in one file rather than a constant per repo, so it can be
  corrected once from measured evidence.
- **Small runs stay admitted under swap pressure.** A guard that refuses every
  command on a busy machine is one people switch off, and a switched-off guard
  protects nothing — so the swap gate aims at Electron-sized runs and lets lint
  and unit lanes through. A machine can still be worn down by many small runs;
  the machine budget, not the swap gate, is what bounds that.
- **Machine-scoped state is a new shared mutable resource.** It is per user,
  reaped by liveness, and tolerant of junk, but it is one more thing that can be
  wrong. `arbiter.mjs doctor` exists because of this.
- **Harness detection is now duplicated in effect, not in fact.** This tool asks
  "is an agent driving this shell" and fails *closed*; agent-bot-identity asks
  "which bot identity is this" and fails *open* to null. Same evidence, opposite
  and deliberate defaults — merging them would force one of the two failure
  directions to be wrong.

## References

- qwts/playbook-engineering#138 — the originating issue and the incident evidence
- [Machine memory guard](../reference/agent-memory-guard.md) — the operational reference: budget formula, lanes, grants, and what to do when a run is refused
- [ENG-0006](ENG-0006-agentic-primitives-governance.md) — agent primitives are code, one canonical source; this record's distribution choice is that rule applied to an executable primitive
- [ENG-0004](ENG-0004-centralize-shared-cicd.md) — centralize shared tooling here rather than per repo
- [ENG-0012](ENG-0012-decision-priority-order.md) — the priority order this was reviewed against; agentic development is deliberately constrained here in favour of the owner's machine
- qwts/overlook#842 — hostname drift making crashed locks unreclaimable, the reason validity keys on liveness alone
