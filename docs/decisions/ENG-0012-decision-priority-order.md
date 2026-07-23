# ENG-0012: Decision priority order — security, compliance, agentic development, human developers

**Status:** Proposed
**Date:** 2026-07-23
**Issue:** qwts/playbook-engineering#21

## Context

Records in this series reach decisions without a stated priority lens, so
every conflict between principles gets re-litigated per record. Meanwhile the
premise that agents are the primary readers has been operative since
[ENG-0009](ENG-0009-documentation-governance-gate.md) gated docs on token cost
and agent-breaking anti-patterns — but it was a premise of one record, never
org policy. This ordering arguably belonged among the first records; it was
never written down.

## Decision

1. **Every ENG record — past and future — is reviewed against this order:**
   1. **Security**
   2. **Compliance**
   3. **Agentic development**
   4. **Human developers**
2. **Agents are native to development in this org; humans pair with agents.**
   Documents and process are agent-guided first: semantic redundancy is
   eliminated, and token efficiency is treated as economic policy — it
   directly affects cost, returns, and development velocity — not as a style
   preference.
3. **The order resolves conflicts; it does not waive lower priorities.**
   Worked examples, because an ordering that never settles a real conflict is
   decoration:
   - Token efficiency (3) says strip a prompt-injection caveat from an agent
     file; security (1) says keep it. **It stays.**
   - A compliance-driven retention requirement (2) adds content agents rarely
     need. **It stays, but linked rather than vendored** — the lower priority
     shapes *how* it is delivered, the higher decides *whether*.
   - A human-friendly narrative duplicate of an agent-optimized doc (4 vs 3)
     is not kept. **Humans read the agent-guided doc**; a second telling is
     the semantic redundancy this record exists to eliminate.
4. **This record is foundational but not renumbered.** Records are never
   renumbered — citations stay stable — so authority is made explicit here
   and in the [decision index](README.md) rather than positional.

## Consequences

- Security outranks efficiency at every conflict point. Agent files stay
  heavier than pure token-optimality would allow wherever a security caveat
  earns its tokens; that cost is accepted permanently.
- Humans adapt to agent-first documents, not the reverse. The mitigation is
  that agent-optimized writing — front-loaded summaries, one fact in one
  place, low context cost — is *also* good technical writing; agent-guided
  does not license human-hostile.
- The ordering is a tiebreaker, not a substitute for judgment: most decisions
  never reach a conflict, and invoking "priority 3" cannot excuse skipping
  the security review a change deserves.
- Existing accepted records are not reopened to re-audit against the lens;
  they are re-examined only when otherwise amended or superseded.

## References

- qwts/playbook-engineering#21 — the originating issue
- [ENG-0009](ENG-0009-documentation-governance-gate.md) — the agent-primary-reader premise this record promotes to policy
- [Decision index](README.md) — marks this record as the standing review lens
