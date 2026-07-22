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

## Index

| ID | Title | Status |
| --- | --- | --- |
| [ENG-0001](ENG-0001-cross-repo-decision-home.md) | Cross-repo decisions live in this repository | Accepted |
| [ENG-0002](ENG-0002-static-analysis-direction.md) | Static analysis: per-language natives now, central instrument later | Accepted |
| [ENG-0003](ENG-0003-repo-is-documentation-source-of-truth.md) | The repository is the source of truth for documentation | Accepted |
| [ENG-0004](ENG-0004-centralize-shared-cicd.md) | Centralize shared CI/CD in this repository | Accepted |
| [ENG-0005](ENG-0005-static-analysis-survey-results.md) | Static-analysis survey: close the workflow-security gap, keep natives | Proposed |
| [ENG-0006](ENG-0006-agentic-primitives-governance.md) | Governance of agentic primitives: one canonical source, progressive disclosure, eval-gated changes | Proposed |

## Related

- [GitHub account reference](../reference/github-account.md) — account tier (Pro) and what decisions assume about it
- [`qwts/photos` wiki](https://github.com/qwts/photos/wiki) — photos' own `ADR-NNNN` series and SOPs
