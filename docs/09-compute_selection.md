# Compute Selection

> **Navigation:** [Home](00-documentation_index.md) | Previous: [Infrastructure Guidelines](08-infrastructure_guidelines.md) | Next: [Database & Storage Planning](10-database_and_storage_planning.md)
>
> **Prerequisites:** Complete [Architecture Planning](06-architecture_planning.md) (section 2.2 Serverless vs Compute)
>
> **Related Documents:**
> - [Architecture Planning](06-architecture_planning.md) - High-level compute architecture decisions
> - [Infrastructure Guidelines](08-infrastructure_guidelines.md) - VPC and networking context
> - [Performance & Optimization](16-performance_and_optimization_planning.md) - Compute sizing and scaling
> - [CI/CD Planning](13-cicd_planning.md) - Deployment target configuration

---

## 1. Project Context
- What is the overall goal or purpose of the project?
- Any business or technical constraints?

## 2. Compute Platform Options

### 2.1 Container Services (ECS/Fargate, AKS, GKE)
- [ ] Evaluate container orchestration tools or platforms already in use
- Are microservices or monolithic architectures in play?
- What level of control over infrastructure is needed?

### 2.2 Serverless (Lambda, Azure Functions, Cloud Functions)
- [ ] Determine if event-driven architecture is suitable or required
- What are the expected traffic patterns (spiky, constant, unpredictable)?
- Any latency or cold-start constraints?

### 2.3 Classic VMs (EC2, Azure VMs, Compute Engine)
- [ ] Assess if legacy apps or specialized workloads need full OS control
- Are custom configurations or third-party software dependencies a factor?
- Is VM-level isolation a security requirement?

## 3. Scaling Requirements

### 3.1 Automatic Scaling
- [ ] Define metrics (CPU, memory, queue length) that will trigger scaling
- How quickly must scaling react to load changes?
- Does the application require predictive or scheduled scaling?

### 3.2 Manual Scaling
- Are there scenarios where manual capacity adjustments are preferred?
- Any change management process or regulations that limit auto-scaling?

## 4. OS Base Images

### 4.1 Linux
- [ ] Select distribution (Ubuntu, Amazon Linux, Alpine)
- Any security or compliance requirements for the OS?
- Existing automation or tools (e.g., Chef, Ansible) that favor certain distros?

### 4.2 Windows
- Do applications rely on .NET or Windows-specific services?
- Any specific licensing or support constraints?
- Are there toolchains or existing expertise for Windows?

## 5. Additional Considerations

### 5.1 Cost and Budget
- [ ] Define cost targets or restrictions
- Preferred billing models (pay-as-you-go, reserved instances, etc.)?

### 5.2 Security and Compliance
- What data protection or regulatory standards apply (HIPAA, GDPR, etc.)?
- Authentication and authorization mechanisms?
- Are there encryption or key management requirements?

### 5.3 Networking and Connectivity
- Inbound/outbound traffic patterns or integration with other systems?
- Do existing VPCs, subnets, or on-prem connectivity influence design?

### 5.4 Monitoring and Logging
- Which tools (CloudWatch, Prometheus, Splunk, etc.) are preferred?
- Key metrics or logs to track for system health?
- Any requirements for audits or historical data retention?

### 5.5 Roadmap and Future Growth
- How might requirements evolve over time?
- Upcoming features or new service integrations?
- Migration or version upgrade strategies?

## 6. Decision Points and Next Steps
- [ ] Summarize priorities and constraints
- [ ] Identify critical trade-offs or open questions
- [ ] Outline actions for finalizing compute selection
