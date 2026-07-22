# ENG-0009: Documentation is gated like code — deterministic checks first, evaluation later

**Status:** Accepted
**Date:** 2026-07-22

## Context

[ENG-0003](ENG-0003-repo-is-documentation-source-of-truth.md) made repos the
documentation source of truth, which made docs versioned files that CI can
read. Nothing yet gates them: a doc PR merges on markdownlint alone, while the
org's standing premise (since [ENG-0002](ENG-0002-static-analysis-direction.md))
is that agents write most of the code — and agents are also the primary
*readers* of these docs.

That inverts the usual documentation advice. An agent does not skim or get
bored, but it does pay a context budget, truncate long inputs, and fail on
ambiguous or contradictory guidance. What matters is task success per token of
context; most prose-style concerns are irrelevant to it, while a small set of
structural properties (cost, chunkability, integrity, self-containedness)
matter enormously — and are checkable without a model.

[ENG-0006](ENG-0006-agentic-primitives-governance.md) already commits to
lint/link/duplication validation for agent instruction files; this record
supplies the mechanism and extends it to `docs/` generally.

## Decision

1. **Deterministic checks gate docs in CI** (`tools/docs-gov/` in this repo):
   integrity (links, orphans, stale code paths), structure (chunkable
   headings, front-loaded summaries, machine-readable fields), context cost
   (token budgets per doc and per agent context set), and the anti-patterns
   that specifically break agents (positional references, placeholders,
   duplicated statements, terminology aliases). The rule catalog with each
   rule's justification lives in the
   [governance reference](../reference/documentation-governance.md).
2. **Admission test for rules:** a rule must name the agent failure it
   prevents, and must produce zero false positives on the docs of the repo
   adopting it — otherwise the rule is dropped, not tolerated. No rule exists
   for tidiness.
3. **Budgets are measured in estimated tokens and ratchet like the existing
   gate floors** — downward freely, upward only with a recorded reason.
4. **Delivery follows [ENG-0004](ENG-0004-centralize-shared-cicd.md):** the
   checks are a zero-dependency CLI in this repository, exposed to consumers
   as a reusable workflow; configuration (globs, budgets, terminology) stays
   per-repo. Adoption order: this repo first (it gates itself), then photos,
   then the rest per [ENG-0006](ENG-0006-agentic-primitives-governance.md)'s
   no-grandfathering rule.
5. **The evaluation loop (Phase 2) is explicitly deferred, not adopted.**
   A SkillOpt-shaped loop — benchmark tasks, doc revisions scored against
   them, held-out validation gating edits — is the only way to know docs
   *work*, but the benchmark is the expensive part and may not be worth
   maintaining. It gets a separate go/no-go decision with evidence, and it
   never blocks the deterministic gate.

## Consequences

- Doc PRs can now fail CI for structural reasons. That is the point, but the
  first-contact experience must stay credible — hence the zero-false-positive
  admission test and per-repo configs rather than one org-wide strictness.
- The token estimator (bytes ÷ 4) is deliberately not a real tokenizer: a
  tokenizer dependency would tie budgets to one vendor's vocabulary and its
  version bumps. The cost is that budget numbers are approximate; the ratchet
  only needs them to be deterministic and monotone.
- The `stale-path` check is scoped per-repo to the directories the repo owns,
  because this playbook's docs legitimately describe *other* repos' trees.
  A cross-repo reference that goes stale is not caught. Accepted for now.
- The #565 link verifier this repo intended to inherit was never committed
  and its working session is unrecoverable; the link check here is a fresh
  implementation. The lesson — tooling written during a migration must land
  with the migration — is part of why these checks live in a repo, not a
  session.
- Running the gate costs seconds and no model calls; the eval loop, if ever
  adopted, costs real money and maintenance. Keeping them decoupled means the
  cheap 80% ships regardless of what the expensive 20% turns out to be worth.

## References

- [qwts/playbook-engineering#2](https://github.com/qwts/playbook-engineering/issues/2) — the issue this implements, including the Phase 2 sketch
- [Documentation governance reference](../reference/documentation-governance.md) — rule catalog, conventions, adoption guide
- [microsoft/SkillOpt](https://github.com/microsoft/SkillOpt) — the validation-gated optimization shape Phase 2 would take
