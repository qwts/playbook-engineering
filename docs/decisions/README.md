# Engineering decisions (ENG series)

Durable records for decisions that span **more than one repository**.

## What belongs here

A decision belongs in this series when it applies across repos, or when it has
no single owning repo:

- Tooling and quality-enforcement direction (linters, static analysis, CI gates)
- Conventions expected to hold in every repo (versioning, commit style, labels)
- Where things live — decision homes, documentation layout, tracking tools
- Language and platform direction affecting more than one project

## What does not

Anything owned by one repository stays in that repository. `qwts/photos` keeps
its own `ADR-NNNN` series in its wiki; a decision about photos' renderer, IPC
contract, or test strategy is a photos ADR, not an ENG record.

The test: **if exactly one repo would have to change, it is not an ENG record.**

## Numbering

`ENG-NNNN`, zero-padded, allocated in order. The prefix is deliberately distinct
from photos' `ADR-NNNN` so that a citation is never ambiguous about which series
and which home it refers to.

## Format

Short. Context, the decision, why, and consequences — including the ones you did
not like. A record that lists no downside is not finished.

Status is one of `Proposed`, `Accepted`, `Superseded by ENG-NNNN`. Records are
never deleted or rewritten after acceptance; supersede them instead, so the
reasoning trail survives.

Every record is issue-first ([ENG-0013](ENG-0013-issue-first-provenance.md)):
an `**Issue:**` header field cites the GitHub issue that holds the why and the
discussion. Records predating the rule carry
`predates issue-first (ENG-0013)`. docs-gov enforces the field.

## Review lens

Every record is reviewed against the priority order of
[ENG-0012](ENG-0012-decision-priority-order.md): **security → compliance →
agentic development → human developers**. The order settles conflicts between
principles; it does not waive the lower priorities.

## Index

| ID | Title | Status |
| --- | --- | --- |
| [ENG-0001](ENG-0001-cross-repo-decision-home.md) | Cross-repo decisions live in this repository | Accepted |
| [ENG-0002](ENG-0002-static-analysis-direction.md) | Static analysis: per-language natives now, central instrument later | Accepted |
| [ENG-0003](ENG-0003-repo-is-documentation-source-of-truth.md) | The repository is the source of truth for documentation | Accepted |
| [ENG-0004](ENG-0004-centralize-shared-cicd.md) | Centralize shared CI/CD in this repository | Accepted |
| [ENG-0005](ENG-0005-static-analysis-survey-results.md) | Static-analysis survey: close the workflow-security gap, keep natives | Proposed |
| [ENG-0006](ENG-0006-agentic-primitives-governance.md) | Governance of agentic primitives: one canonical source, progressive disclosure, eval-gated changes | Proposed |
| [ENG-0007](ENG-0007-feature-lifecycle-convention.md) | Feature lifecycle: open with problem/requirements/design/proposed patterns, close with the solution as built | Proposed |
| [ENG-0008](ENG-0008-shared-sop-inheritance.md) | Shared SOPs: defined once here, inherited by default, varied only by explicit delta | Accepted |
| [ENG-0009](ENG-0009-documentation-governance-gate.md) | Documentation is gated like code — deterministic checks first, evaluation later | Accepted |
| [ENG-0010](ENG-0010-docs-evaluation-loop.md) | The docs evaluation loop — adopt with tight bounds, retire on silence | Accepted |
| [ENG-0011](ENG-0011-governed-scope-manifest.md) | Governed scope is a manifest — one source of truth, add/remove by editing it | Proposed |
| [ENG-0012](ENG-0012-decision-priority-order.md) | Decision priority order — security, compliance, agentic development, human developers | Proposed |
| [ENG-0013](ENG-0013-issue-first-provenance.md) | ENG records are issue-first — the issue holds the why, the record holds the decision | Proposed |
| [ENG-0014](ENG-0014-canonical-agent-context.md) | Canonical agent context is CLAUDE.md — AGENTS.md generated, copies gated, baselines vendored | Proposed |

## Related

- [Shared SOPs index](../sop/README.md) — the standard operating procedures ENG-0008 governs (how work moves: branch → PR → review → release)
- [GitHub account reference](../reference/github-account.md) — account tier (Pro) and what decisions assume about it
- [`qwts/photos` wiki](https://github.com/qwts/photos/wiki) — photos' own `ADR-NNNN` series and SOPs
