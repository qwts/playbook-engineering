# Copilot instructions

Start with [AGENTS.md](../AGENTS.md) — this file only adds Copilot-specific orientation; do not duplicate `AGENTS.md` or the documentation index here.

## Interactive playbook agents

This repo ships a Copilot custom-agent chain (`.github/agents/*.agent.md`) and matching slash commands (`.github/prompts/*.prompt.md`) that interactively gather playbook Sections 1-6 and hand off between each other. This routing table is genuinely Copilot-specific product surface, not restated playbook content — full usage detail is in [usage.md](../usage.md).

| Playbook section | Agent | Start command |
| --- | --- | --- |
| 1. Requirements Gathering | Requirements Gathering | `/requirements-start` |
| 2. Deployment Strategy | Deployment Strategy | `/deployment-start` |
| 3. Database & Data Management | Database & Data Management | `/database-start` |
| 4. Security & Compliance | Security & Compliance | `/security-start` |
| 5. Performance & Monitoring | Performance & Monitoring | `/performance-start` |
| 6. Additional Considerations | Additional Considerations | `/additional-start` |
| Technology Selection & PoC | Technology Selection | handoff only, no start command |

Sections run in any order; each agent's handoff buttons chain to the others.
