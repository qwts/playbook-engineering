# ENG-0003: The repository is the source of truth for documentation

**Status:** Accepted
**Date:** 2026-07-19
**Issue:** predates issue-first (ENG-0013)

## Context

`qwts/photos` follows a wiki-first convention: long-lived docs, SOPs, and ADRs
live in its GitHub wiki, and repo markdown is a pointer map to it. That wiki now
holds 59 pages and roughly 60,000 words, including `ADR-0001` through
`ADR-0023`, acceptance tests, user stories, and security reviews.

[ENG-0001](ENG-0001-cross-repo-decision-home.md) already deviated from that
convention for cross-repo decision records, on findability grounds. This record
generalizes the same reasoning to all documentation, and to every repository.

A GitHub wiki is a separate git repository with real consequences:

- **It is not indexed by GitHub code search.** Wiki content cannot be found from
  anywhere except the wiki's own search box. For documentation meant to be
  discovered from other repos, this is disqualifying.
- **Agents do not have it.** Work happens in a clone of the repository. Wiki
  content requires knowing to fetch a second remote, so in practice it is
  invisible to any agent doing the work — the opposite of what documentation is
  for.
- **It is a second write path.** Wiki pushes go to a different remote than the
  repository and are handled differently by tooling and permission layers,
  producing friction and blocked writes that repo commits do not have.
- **It cannot be reviewed or gated.** Wiki edits bypass pull requests entirely.
  A documentation change cannot be reviewed alongside the code it describes, and
  no CI check can read it.

That last point has a concrete cost today. Photos' `AGENTS.md` defines an ADR
gate — an issue labeled `adr` may not begin implementation until the governing
ADR is accepted — but nothing can enforce it, because the ADR lives somewhere no
script can practically check.

The migration cost only grows. Waiting compounds it.

## Decision

**The repository is the source of truth for all documentation.** Long-lived
docs, SOPs, ADRs, and decision records live in-repo under `docs/`, in every
repository.

Wikis are **not deleted**. Each existing wiki page is replaced with a stub
pointing to its new in-repo location, preserving every existing URL — including
references in issue and pull request bodies, which cannot be found or rewritten
retroactively. Stubs are written once and never regenerated.

**No wiki sync automation.** A generated mirror was considered and rejected: it
requires a personal access token with write scope stored in CI (the default
`GITHUB_TOKEN` cannot push to wikis), a link-rewriting pass, and one-way
discipline that nothing enforces. That is real machinery to maintain a lossy
copy of something the repository already renders.

Photos' wiki-first rule in `AGENTS.md` is reversed accordingly.

## Consequences

- Documentation becomes findable by code search across every repository, and
  greppable by agents from a clone they already have.
- Doc changes land atomically with the code they describe, in the same reviewed
  pull request.
- **The ADR gate becomes machine-checkable.** With ADRs in-repo, a script can
  verify the governing record exists and reads `Status: Accepted`, moving the
  rule from convention into the gate stack.
- One-time migration cost in photos: 59 pages, 16 in-repo URL references across
  7 files, plus stub generation. Other repos have no wiki content and adopt
  `docs/` directly.
- Wiki git history (97 commits in photos) is preserved via subtree merge rather
  than orphaned; the reasoning trail on ADRs is worth keeping.
- Anything deep-linking to a wiki *anchor*, or rendering wiki content
  externally, will break. Stubs preserve page URLs, not fragments.
- Documentation changes now trigger CI. Photos already path-filters its
  expensive lanes, so the cost is small, but other repos must not regress here.
- Editing docs requires a commit rather than a browser. For a solo,
  agent-driven workflow this is a benefit — it is what makes review possible —
  but it is a real loss of convenience for quick notes.

## Scope

Applies to every repository. Photos is the only one with substantial wiki
content and is therefore the whole migration; the rest adopt `docs/` from the
start.
