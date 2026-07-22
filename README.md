# Software Engineering Playbook

This repository is a curated collection of documents, processes, and workflows designed to guide software engineering practices and support the Software Development Life Cycle (SDLC). It serves as a centralized reference for teams to understand requirements gathering, architecture planning, infrastructure, security, observability, and more.

It is also the home for **cross-repo engineering decisions** — see the [decision index](docs/decisions/README.md).

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

- [Shared SOPs](docs/sop/repo-baseline-files.md) — org-wide standard operating procedures, inherited by every repo (ENG-0008).
- [Feature lifecycle](docs/sop/feature-lifecycle.md) — the shared feature issue form and the closeout every feature records at close (ENG-0007).
- [Documentation governance](docs/reference/documentation-governance.md) — the `docs-gov` gate: deterministic checks that keep docs agent-readable, consumable by other repos as a reusable workflow.
- [Documentation style guide](docs/23-documentation_style_guide.md) — conventions for writing docs in this playbook.
- [Contributing](CONTRIBUTING.md) — how changes to this repository land.

## Usage
1. **[Usage Guide](usage.md)** — VS Code Copilot agents, slash commands, and workflows for interactive requirements gathering.
2. Browse the `docs/` directory to find relevant sections of the SDLC.
3. Share and adapt the workflows for your team or project.
4. Keep the repository up to date with new insights and improvements.

> This repository is intended to evolve as a living playbook for engineering excellence.
