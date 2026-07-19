---
name: security-start
description: Start interactive security and compliance gathering for Section 4 (Auth, Regulatory, Encryption)
agent: security-compliance
tools: ['search', 'fetch', 'read']
---

Start an interactive security and compliance session for the application we're building.

Follow the structure in [docs/01-requirements_gathering.md](../../docs/01-requirements_gathering.md) Section 4.

Introduce yourself briefly, then ask the first questions from **4.1 Authentication and Authorization**:
- Are there specific authentication and authorization mechanisms needed?
- Which identity provider (SSO, IAM, Entra ID, etc.) will be used?
- Is MFA required? What about RBAC or ABAC?
- Are short-lived tokens or OAuth2/SAML needed?

Remember: Before fetching documentation or creating diagrams, always ask for confirmation. The user may have their own materials.
