# Software Engineering Playbook - Workspace Context

This workspace follows the Software Engineering Playbook SDLC. Key references:

- **Documentation structure:** The `docs/` folder contains 22 guides covering the full lifecycle. See [docs/00-documentation_index.md](docs/00-documentation_index.md).
- **Requirements gathering:** Section 1 (Application Functionality and User Experience) is defined in [docs/01-requirements_gathering.md](docs/01-requirements_gathering.md) and covers:
  - 1.1 Core Features
  - 1.2 User Flows
  - 1.3 UX/UI Considerations
- **Deployment strategy:** Section 2 (Environment Approach and Infrastructure/Scaling) covers container vs VM, regulatory constraints, hybrid feasibility, scaling, and environment count. Use the **Deployment Strategy** agent or `/deployment-start` prompt.
- **Database and data management:** Section 3 in [docs/01-requirements_gathering.md](docs/01-requirements_gathering.md) covers 3.1 Database Requirements, 3.2 Caching, 3.3 Messaging and Integration. Use the **Database & Data Management** agent or `/database-start` prompt.
- **Security and compliance:** Section 4 in [docs/01-requirements_gathering.md](docs/01-requirements_gathering.md) covers 4.1 Authentication and Authorization, 4.2 Regulatory and Compliance (GDPR, HIPAA, PCI), 4.3 Data Encryption. Use the **Security & Compliance** agent or `/security-start` prompt. See [docs/04-security_and_compliance_planning.md](docs/04-security_and_compliance_planning.md).
- **Performance and monitoring:** Section 5 in [docs/01-requirements_gathering.md](docs/01-requirements_gathering.md) covers 5.1 Response Times and Throughput, 5.2 Metrics and Logs, 5.3 Real-time Monitoring and Alerting. Use the **Performance & Monitoring** agent or `/performance-start` prompt.
- **Additional considerations:** Section 6 in [docs/01-requirements_gathering.md](docs/01-requirements_gathering.md) covers 6.1 Third-party Tools and Services, 6.2 Risks and Dependencies, 6.3 Timeline and Deadlines. Use the **Additional Considerations** agent or `/additional-start` prompt.
- **Next phase:** After requirements, proceed to [docs/02-technology_selection_and_poc.md](docs/02-technology_selection_and_poc.md).

For interactive requirements gathering, use the **Requirements Gathering** agent or `/requirements-start` prompt. For deployment strategy, use the **Deployment Strategy** agent or `/deployment-start` prompt. For database and data management, use the **Database & Data Management** agent or `/database-start` prompt. For security and compliance, use the **Security & Compliance** agent or `/security-start` prompt. For performance and monitoring, use the **Performance & Monitoring** agent or `/performance-start` prompt. For additional considerations, use the **Additional Considerations** agent or `/additional-start` prompt. Sections 1, 2, 3, 4, 5, and 6 can be run in any order.
