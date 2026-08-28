# AGENTS.md

Canonical, vendor-neutral agent context for this repository, per [ENG-0006](docs/decisions/ENG-0006-agentic-primitives-governance.md). Vendor files — [.github/copilot-instructions.md](.github/copilot-instructions.md) and this repo's Copilot custom-agent/prompt suite — are thin adapters onto this file: they add vendor-specific orientation and never restate what is here.

## What this repository is

The org's cross-repo home for engineering decisions (ENG records), shared SOPs, shared CI/CD, and the docs-governance tooling every `qwts` repo consumes. Full map: [README.md](README.md).

<!-- governed:shared-agent-discovery:start -->

## Shared agent conventions and skills

PR-first workflow, validation-before-push, commit and PR hygiene, and the
untrusted-input threat model are defined once, for every repo, in the
[org-wide agent conventions](https://github.com/qwts/playbook-engineering/blob/main/docs/reference/agent-conventions.md).
Before creating or copying a repo-local skill, consult the reviewed
[shared agent skills](https://github.com/qwts/playbook-engineering/blob/74e775ef23d8e7d8f8e693ccc2329f430978c096/skills/README.md)
index. Reuse only the pinned version supplied by the governed harness; a skill
genuinely specific to this repository belongs in its local context.
This repository is governed by
[playbook-engineering](https://github.com/qwts/playbook-engineering) — its
[shared SOPs](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/README.md)
and [engineering decisions](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/README.md)
apply here by default
([ENG-0008](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0008-shared-sop-inheritance.md):
inherit by default, vary by explicit delta).
<!-- governed:shared-agent-discovery:end -->

## What is specific to this repository

- **ENG records:** format, numbering, and the supersede-don't-rewrite rule are in [docs/decisions/README.md](docs/decisions/README.md). Adding or changing a record updates its row in that index table in the same PR — an unindexed record fails docs-gov's `orphan-doc` check.
- **SOPs:** baselines under [docs/sop/](docs/sop/) propagate to every repo per [ENG-0008](docs/decisions/ENG-0008-shared-sop-inheritance.md); edits need the changelog at the bottom of the SOP updated.
- **Governed scope:** the set of governed repos is the manifest `governance/repos.json` ([ENG-0011](docs/decisions/ENG-0011-governed-scope-manifest.md)). Editing it requires regenerating the table with `node tools/repos/repos.mjs --write` and passing `node tools/repos/repos.mjs check` — CI runs the check, so an un-regenerated edit fails.
- **Docs-gov gate:** every change under `docs/` or `skills/`, plus this file, must pass `node tools/docs-gov/docs-gov.mjs` and `npm run lint:markdown` before a PR is opened or updated. See [documentation governance](docs/reference/documentation-governance.md) for what each rule catches. New files must be reachable by link from [README.md](README.md), or the `orphan-doc` rule fails them.
- **Machine memory guard:** [`tools/agent-guard/`](tools/agent-guard/run-guarded.mjs) is a local-memory admission control whose decision ([ENG-0138](docs/decisions/ENG-0138-machine-scoped-agent-memory-budget.md)) is still Proposed. Only accepted decisions ship, so it is not mirrored by the harness sync and is not wired into any harness adapter (#331); the implementation stays in this repository only, and the harness sync deletes the consumer copies it previously distributed. Operational detail: [machine memory guard](docs/reference/agent-memory-guard.md).
- **Shared skills:** [skills/](skills/README.md) holds skills installed into every agent's harness, not just this repo's. They are ENG-0006 primitives owned in `.github/CODEOWNERS` and subject to the same gates as docs; adding one means linking it from the skills index.
- **Shared CI:** reusable workflows are consumed by other repos at `@v1`; the tag never moves without this repo's own CI (`test`, `docs-gov / docs-gov`) passing on the change first ([ENG-0004](docs/decisions/ENG-0004-centralize-shared-cicd.md)).

## ENG-0006 conformance

This repo's own status against the checklist: [agentic primitives conformance checklist](docs/reference/agentic-primitives-conformance-checklist.md).
