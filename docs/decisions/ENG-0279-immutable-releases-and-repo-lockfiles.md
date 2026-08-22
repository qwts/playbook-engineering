# ENG-0279: Playbook updates ship as immutable releases; repos align by lockfile

**Status:** Proposed
**Date:** 2026-08-22
**Issue:** qwts/playbook-engineering#279

## Context

[ENG-0004](ENG-0004-centralize-shared-cicd.md) distributes shared CI through a
moving `@v1` major tag, and copied assets (baseline files, the `.codex/` and
`.claude/` harnesses) converge when an operator runs `reconcile.mjs` from a
playbook checkout. Neither channel records which playbook state a repository
actually has. A moving tag is a mutable reference — the same `uses:` line
yields different code over time and leaves no per-repo evidence of what ran.
Seeded files carry no provenance. No repository can answer "what version are
you on," so the dashboard cannot show who is behind, and an audit cannot bind
a repo's behavior to a specific playbook commit.

## Decision

Every distribution — referenced workflows and copied files alike — ships as a
**release**: a signed tag whose semver version maps 1-1 to one commit SHA,
never moved, never reused, with tag update and deletion forbidden by a tag
ruleset so immutability is enforced, not conventional. Each release publishes
a manifest listing the version, the commit SHA, and the content hash of every
distributed file. The tag plus manifest is the single place version is locked
to SHA.

Each governed repository carries a lockfile (`.playbook/lock.json`) recording
the release version and SHA it is aligned to. Workflow references pin the
exact release; nothing references a floating tag.

Alignment is pull, not push. A repo-owned stub workflow — itself distributed
and versioned — calls the shared aligner on a nightly schedule. When a newer
release exists, the aligner opens one bot-authored PR updating distributed
files, workflow pins, and the lockfile together. No tool rewrites a repository
outside that PR; the repo adopts by review and merge. A `repository_dispatch`
fast path may be added later without changing this contract.

The align PR is a per-repository singleton. When a newer release publishes
while one is open, the aligner refreshes that PR to the newest non-yanked
release rather than opening a second; an align PR targeting any other version
is stale and the aligner closes it. Releases may overlap; alignment never
does, so no repo can be downgraded by a stale PR merging late.

Until the align PR merges, the repository is out of date by definition and
visibly so: the dashboard compares each repo's lockfile on `main` against the
latest release — one version per repo with staleness age. Per-file provenance
("which SHA was this file aligned to") comes from the manifest hashes; the pin
is per repository, never per file.

**The fleet runs one version: the latest release** — defined as the newest
non-yanked release. There is no supported
version range — being behind latest is a drift state to converge out of, not a
position to hold. An `active` repo behind latest fails the drift gate the same
way a missing baseline file does today; the only lag tolerated is the review
window of its open align PR. Pinning is for provenance and rollback, never for
opting out of an update.

Two file classes, so distribution and repo state never conflict:

- **Distributed files** are playbook-owned: bitwise identical to the release
  manifest, hash-verified, never locally edited. They carry mechanisms, not
  values.
- **Repo state files** are repo-owned: `package.json` versions, dependency
  lockfiles, ratchet floors — and `.playbook/lock.json` itself. The playbook
  may define a state file's schema and mechanism but never its values, and
  alignment never touches repo state except `.playbook/lock.json`, which the
  align PR writes exactly as `npm install` writes `package-lock.json`: the
  repo's own record of what it consumed.

This is the same split the repositories already live with for dependencies,
so the lockfile introduces no new kind of in-repo state.

One migration falls out of the whole-file hash requirement: files that today
compose repo-owned entries into managed content — the manifest's
`preserveJsonArrayEntries` for `.claude/settings.json` and agent hook files,
and the marked `AGENTS.md` block — cannot be bitwise identical to a template.
Where the tool supports it, preserved entries move to a repo-owned companion
file so the distributed file becomes wholly playbook-owned; where it does not
(`AGENTS.md`), the manifest hashes the playbook-owned projection and drift
verifies that projection. Rollout tracks this migration per repository.

This supersedes the moving-tag pinning model of ENG-0004, which receives an
amendment pointing here. `reconcile.mjs` narrows to its settings and human
lanes — steps GitHub's permission model reserves for an operator token — and
stops being the file-distribution channel.

## Consequences

- Propagation is no longer instant. A fix reaches a repo only when its align
  PR merges; a security-critical release needs an expedite marker the
  dashboard escalates rather than silent fleet-wide rollout.
- One PR per governed repo per release. PR volume grows with fleet size and
  release cadence; batching changes into fewer releases is the mitigation.
- ENG-0004's central risk — one bad push breaking every consumer at once — is
  structurally gone. A defective release reaches only repos that have merged
  its align PR; the rest are still on the prior version when it is yanked and
  a fixed release supersedes it.
- One-version convergence means a release the fleet cannot adopt is a defect
  in the release, not in the laggards. Fix forward with a new release; a repo
  is never granted a standing exemption to stay behind.
- Every repo's playbook state becomes auditable: version → SHA → file hashes,
  verifiable by `drift.mjs` (which learns hash conformance) and displayed by
  the dashboard.
- Rollback is an align PR in reverse: one atomic PR restores the prior
  release's files, workflow pins, and lockfile together. A lone lockfile
  revert is never rollback — it would misrecord the version while leaving
  defective content in place, and hash verification would flag the mismatch.
  Yanking the defective release makes the prior release latest again, so
  rolled-back repos conform until the fixed release ships.
- New surface to build and keep green: release manifest tooling, the lockfile
  schema, the shared aligner workflow, the tag ruleset, and the dashboard
  staleness view.

## Alternatives

- **Moving major tag (status quo, ENG-0004):** rejected — a mutable reference
  cannot be audited and propagates silently. Its single-edit benefit is
  replaced by the automated align PR.
- **Exact-pin auto-bump (rejected by ENG-0004):** substantially adopted. The
  per-repo bump PR ENG-0004 avoided is now the deliberate adoption gate; the
  aligner authors it and the dashboard tracks laggards, which removes the
  manual burden that motivated the original rejection.
- **Central overwrite on sync:** rejected — repositories adopt through a
  reviewed PR; no tool mutates a repo's files outside one.
- **Per-file version pins:** rejected — mix-and-match file states cannot be
  reasoned about, audited, or reported as one number.
