# ENG-0001: Cross-repo decisions live in this repository

**Status:** Accepted
**Date:** 2026-07-19
**Issue:** predates issue-first (ENG-0013)

## Context

Decision records were accumulating in `qwts/photos` — its wiki holds `ADR-0001`
through `ADR-0023` — because it was the most active repo, not because it owned
the decisions. Some of those records are not about photos at all. `ADR-0001
Automation Check Governance` is a general engineering-process decision that
happens to live in a photo library app's wiki.

That misfiling has real costs. Decisions applying to `cartograph`,
`image-trail`, or `agent-comms` are invisible from those repos. If `photos` is
ever archived, the cross-cutting records go with it. And a contributor — human
or agent — working in another repo has no reason to look in photos' wiki.

Tools considered and rejected:

- **A GitHub organization.** Free tier is sufficient (Enterprise is not
  required), but user-level Projects already span repos, so an org buys little
  today. Transferring repos also breaks the `qwts.github.io/photos` Pages URL,
  which is hardcoded in photos' CI for per-PR Playwright reports. Revisit when
  collaborators are added — that is the actual forcing function.
- **Linear.** A good issue tracker, but decision records are documents, not
  issues. It does not solve this problem, and moving tracking off GitHub splits
  the source of truth away from where the agent workflow already operates.
- **Atlassian / Jira.** Overhead designed to pay off against org process;
  purely cost for solo work. Confluence is genuinely better than GitHub wikis at
  search and structure, but not worth the footprint.

## Decision

Cross-repo decisions live in `qwts/playbook-software-engineering`, under
`docs/decisions/`, as an `ENG-NNNN` series.

Records are kept **in-repo rather than in this repository's wiki**, deviating
from photos' wiki-first convention. GitHub code search indexes repository
contents but not wiki pages, and cross-repo findability is the entire problem
being solved. In-repo files are also greppable by agents working from a clone
and reviewable through pull requests.

Per-repo decisions do not move. Photos keeps its `ADR-NNNN` series in its wiki.

## Consequences

- Cross-cutting decisions survive any single repo's archival, and are findable
  by code search from anywhere.
- Two decision homes now exist. The routing rule — *if exactly one repo would
  have to change, it is not an ENG record* — must stay unambiguous, and photos'
  `adr` label gate needs to state which home it means.
- Distinct `ENG-` and `ADR-` prefixes prevent citation collisions, but everyone
  must use them consistently; a bare "ADR-0005" is now ambiguous.
- This repo becomes load-bearing. It was previously a dormant SDLC-workflow
  scratchpad, and now carries records other repos depend on.
- Deviating from wiki-first means two conventions across the account, which is
  itself a small consistency cost accepted for findability.

## Amendment — 2026-07-19: account tier

The account is on **GitHub Pro**, not Free (see
[GitHub account reference](../reference/github-account.md)). This does not
change the decision, but sharpens the org analysis above: Pro already provides
protected branches and rulesets on **personal private** repos, so private-repo
branch protection is *not* among the things forming an organization would buy.
The forcing function for an org remains adding collaborators, which has not
happened. Recorded because the original reasoning weighed the org option
without stating the maintained tier it was being compared against.

## Amendment — 2026-07-22: repository renamed to `playbook-engineering`

The decision home named above as `qwts/playbook-software-engineering` is now
`qwts/playbook-engineering`
([#12](https://github.com/qwts/playbook-engineering/issues/12)). Nothing about
the decision changes — this repository remains the cross-repo decision home.
The original name stays in the text per the no-rewrite rule, and GitHub's
rename redirect keeps old citations resolving. Use the new name in anything
written from here on.
