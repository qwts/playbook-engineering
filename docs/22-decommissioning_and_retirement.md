# Decommissioning & Retirement

> **Navigation:** [Home](00-documentation_index.md) | Previous: [Post-Launch Operations](21-post_launch_operations.md)
>
> **Prerequisites:** System operational and retirement decision made
>
> **Related Documents:**
> - [Data Governance & Strategy](03-data_governance_and_strategy.md) - Data retention and archiving policies
> - [Database & Storage Planning](10-database_and_storage_planning.md) - Data migration procedures
> - [Security & Compliance Planning](04-security_and_compliance_planning.md) - Data destruction compliance
> - [Infrastructure Guidelines](08-infrastructure_guidelines.md) - Resource cleanup procedures
> - [Post-Launch Operations](21-post_launch_operations.md) - Operational handover knowledge

---

## 1. Retirement Planning
Plan the orderly shutdown of the application.

### 1.1 Trigger Conditions
When should this application be retired?
- [ ] Replacement system is 100% operational
- [ ] User base drops below threshold X
- [ ] Dependency End-of-Support reached

### 1.2 Timeline
- **Announcement Date:**
- **Read-Only Mode Date:**
- **hard Shutdown Date:**

---

## 2. Data Strategy (End of Life)
Refer to Data Governance policy.

### 2.1 Archiving
- What data must be retained for legal/compliance?
- Where will the archive live? (e.g., S3 Glacier, Tape)
- How will it be accessed if needed during audits?

### 2.2 Sanitization
- [ ] Securely wipe ephemeral storage / caches.
- [ ] Delete backup snapshots (after final archive created).
- [ ] PII deletion validation.

---

## 3. Resource Termination
Stop paying for what you don't use.

- [ ] Terminate Compute instances / Containers.
- [ ] Delete Load Balancers & DNS records.
- [ ] Release Static IPs.
- [ ] Cancel SaaS licenses / Add-ons.

## 4. Final Compliance Check
- [ ] Legal Hold released?
- [ ] Contracts with 3rd party consumers terminated?
