# AGENTS.md

Canonical, vendor-neutral agent context for this repository, per [ENG-0006](docs/decisions/ENG-0006-agentic-primitives-governance.md). Vendor files — [.github/copilot-instructions.md](.github/copilot-instructions.md) and this repo's Copilot custom-agent/prompt suite — are thin adapters onto this file: they add vendor-specific orientation and never restate what is here.

## What this repository is

The org's cross-repo home for engineering decisions (ENG records), shared SOPs, shared CI/CD, and the docs-governance tooling every `qwts` repo consumes. Full map: [README.md](README.md).

## Shared agent conventions

PR-first workflow, validation-before-push, commit and PR hygiene, supply-chain pinning for MCP servers and skills, and the untrusted-input threat model are defined once, for every repo, in [org-wide agent conventions](docs/reference/agent-conventions.md) — this file does not restate them. This repository hosts that document as well as consuming it.

## What is specific to this repository

- **ENG records:** format, numbering, and the supersede-don't-rewrite rule are in [docs/decisions/README.md](docs/decisions/README.md). Adding or changing a record updates its row in that index table in the same PR — an unindexed record fails docs-gov's `orphan-doc` check.
- **SOPs:** baselines under [docs/sop/](docs/sop/) propagate to every repo per [ENG-0008](docs/decisions/ENG-0008-shared-sop-inheritance.md); edits need the changelog at the bottom of the SOP updated.
- **Docs-gov gate:** every change under `docs/`, plus this file, must pass `node tools/docs-gov/docs-gov.mjs` and `npm run lint:markdown` before a PR is opened or updated. See [documentation governance](docs/reference/documentation-governance.md) for what each rule catches. New files must be reachable by link from [README.md](README.md), or the `orphan-doc` rule fails them.
- **Shared CI:** reusable workflows are consumed by other repos at `@v1`; the tag never moves without this repo's own CI (`test`, `docs-gov / docs-gov`) passing on the change first ([ENG-0004](docs/decisions/ENG-0004-centralize-shared-cicd.md)).

## ENG-0006 conformance

This repo's own status against the checklist: [agentic primitives conformance checklist](docs/reference/agentic-primitives-conformance-checklist.md).
