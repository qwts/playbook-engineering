# Software Engineering Playbook

This repository is a curated collection of documents, processes, and workflows designed to guide software engineering practices and support the Software Development Life Cycle (SDLC). It serves as a centralized reference for teams to understand requirements gathering, architecture planning, infrastructure, security, observability, and more.

It is also the home for **cross-repo engineering decisions** — see the [decision index](docs/decisions/README.md) — and for the org-wide agent conventions every repo's [AGENTS.md](AGENTS.md) points to; see [AGENTS.md](AGENTS.md) for this repo's own agent context.

## Engineering decisions (ENG series)

Durable records for decisions that span more than one repository: tooling
direction, shared conventions, where things live, language and platform choices.

### 📐 [Decision index](docs/decisions/README.md)

Decisions owned by a single repository stay in that repository. The routing test
is simple: **if exactly one repo would have to change, it is not an ENG record.**

## Documentation Structure

The `docs/` folder contains 22 comprehensive guides covering the complete Software Development Life Cycle (SDLC), organized by phase:

### 📋 [Complete Documentation Index](docs/00-documentation_index.md)

**Planning Phase** (Documents 1-6): Requirements, architecture, security, and technology decisions
- [Requirements Gathering](docs/01-requirements_gathering.md)
- [Technology Selection & PoC](docs/02-technology_selection_and_poc.md)
- [Data Governance & Strategy](docs/03-data_governance_and_strategy.md)
- [Security & Compliance Planning](docs/04-security_and_compliance_planning.md)
- [Testing Strategy](docs/05-testing_strategy.md)
- [Architecture Planning](docs/06-architecture_planning.md)

**Development Phase** (Documents 7-16): Infrastructure, deployment, and technical implementation
- [Project Structure Planning](docs/07-project_structure_planning.md)
- [Infrastructure Guidelines](docs/08-infrastructure_guidelines.md)
- [Compute Selection](docs/09-compute_selection.md)
- [Database & Storage Planning](docs/10-database_and_storage_planning.md)
- [Networking & Load Balancing](docs/11-networking_and_load_balancing.md)
- [Observability Stack Planning](docs/12-observability_stack_planning.md)
- [CI/CD Planning](docs/13-cicd_planning.md)
- [Disaster Recovery Planning](docs/14-disaster_recovery_planning.md)
- [Cost Optimization & FinOps](docs/15-cost_optimization_and_finops.md)
- [Performance & Optimization Planning](docs/16-performance_and_optimization_planning.md)

**Operations Phase** (Documents 17-22): Launch preparation, operations, and project completion
- [UAT & Pilot](docs/17-uat_and_pilot.md)
- [Final Validations](docs/18-final_validations.md)
- [End User Training & Change Management](docs/19-end_user_training_and_change_management.md)
- [Launch Checklist](docs/20-launch_checklist.md)
- [Post-Launch Operations](docs/21-post_launch_operations.md)
- [Decommissioning & Retirement](docs/22-decommissioning_and_retirement.md)

Each document includes navigation links, prerequisites, and cross-references to related topics. Use these guides to align on best practices, ensure consistency, and drive quality in your projects.

## Shared standards and tooling

- [Governed repositories](docs/reference/governed-repos.md) — which repos this playbook governs, and how to add or remove one; generated from the `governance/repos.json` manifest (ENG-0011).
- [Governed repository operations](docs/reference/governed-repos-operations.md) — the lanes you run against those repos: local bootstrap, drift detection, reconciliation, and harness synchronization.
- [Shared SOPs](docs/sop/README.md) — org-wide standard operating procedures for how work moves, inherited by every repo (ENG-0008).
- [Org-wide agent conventions](docs/reference/agent-conventions.md) — the shared agent working agreement every repo's `AGENTS.md` links to (ENG-0006).
- [Agent bot identity governance](docs/reference/agent-bot-identity.md) — the qwts App roster, permissions, coverage, and integration contract (ENG-0016, ENG-0128).
- [Agent bot organization operations](docs/reference/agent-bot-operations.md) — registration, verification, and incident expectations without duplicating the standalone runtime.
- [Agent execution identity policy](docs/reference/agent-execution-identity.md) — the private transcript-bound identity and audit boundary behind each agent conversation (ENG-0081).
- [Agentic primitives conformance checklist](docs/reference/agentic-primitives-conformance-checklist.md) — the ENG-0006 §6 checklist per-repo alignment issues link to.
- [Machine memory guard](docs/reference/agent-memory-guard.md) — the machine-scoped memory budget every agent session on a local machine shares, and what to do when a run is refused (ENG-0138).
- [Shared agent skills](skills/README.md) — skills centralized here and installed into every agent harness, rather than copied per repo (ENG-0004, ENG-0006).
- [Documentation governance](docs/reference/documentation-governance.md) — the `docs-gov` gate: deterministic checks that keep docs agent-readable, consumable by other repos as a reusable workflow.
- [CI execution policy](docs/reference/ci-execution-policy.md) — lifecycle scheduling and deduplication without removing agreed validation gates.
- [Governed CI rollout checklist](docs/reference/governed-ci-rollout.md) — exact-SHA rollout evidence, user-owned fallback, check publishers, credentials, and manual settings.
- [Release-lifecycle fleet handoff](docs/reference/governed-ci-release-lifecycle-fleet.md) — manifest-wide release mechanism inventory, generated-projection identities, and executable repair or verified dispositions.
- [Dependency & tooling inventory](docs/reference/dependency-inventory.md) — the report-only inventory of dependencies, licenses, and tooling across governed repos, consumed as a reusable workflow (ENG-0015).
- [Semantic ratchets](docs/reference/semantic-ratchets.md) — combine deterministic size ratchets with calibrated semantic screening and rare authoritative exception adjudication (ENG-0160).
- [Documentation style guide](docs/23-documentation_style_guide.md) — conventions for writing docs in this playbook.
- [Contributing](CONTRIBUTING.md) — how changes to this repository land.

## Usage
1. **[Usage Guide](usage.md)** — VS Code Copilot agents, slash commands, and workflows for interactive requirements gathering.
2. Browse the `docs/` directory to find relevant sections of the SDLC.
3. Share and adapt the workflows for your team or project.
4. Keep the repository up to date with new insights and improvements.

> This repository is intended to evolve as a living playbook for engineering excellence.
