# ENG-0011: Inventory dependencies and tooling across the fleet — report-only, Syft SBOM plus a shared normalizer

**Status:** Proposed
**Date:** 2026-07-23

## Context

The org tracks vulnerabilities (osv-scanner, cargo-deny, Dependabot) but has no
standing answer to two adjacent questions. For compliance: what packages does
each repo ship and under which licenses. For reuse: when a new project starts,
which tools does the fleet already run so it adopts the stack instead of
recreating the wheel. Both are inventory questions, not gate questions — nothing
should fail a build because of them.

[ENG-0005](ENG-0005-static-analysis-survey-results.md) already chose the tools
that would enforce license and advisory policy; it did not produce a catalog of
what is in use. [ENG-0004](ENG-0004-centralize-shared-cicd.md) established the
delivery mechanism this reuses: a zero-dependency CLI here, exposed as a reusable
workflow, configured per repo. License *detection* — matching files to SPDX
identifiers — is the one genuinely hard part, and mature tooling (Syft) already
does it well; reimplementing it by hand is exactly the wheel this record avoids.

## Decision

1. **A dependency-and-tooling inventory ships as ENG-0004 phase-1 tooling.**
   Syft generates a CycloneDX SBOM (packages plus licenses); a zero-dependency
   normalizer (`tools/dependency-inventory/`) folds it together with the two
   things an SBOM omits — the GitHub Actions a repo runs and the tool-config
   files it keeps — into one playbook schema. Consumed at the test-gated moving
   `@v1`, like every reusable workflow here.
2. **Report-only, always.** It emits artifacts and never fails a build. License
   and advisory *enforcement* stays with osv-scanner and cargo-deny per
   [ENG-0005](ENG-0005-static-analysis-survey-results.md); duplicating that as a
   gate here would only re-litigate the false-positive problem that record
   already settled.
3. **Two views from one normalizer.** A reusable per-repo workflow gives each
   repo its own inventory artifact (the compliance record); a scheduled workflow
   here fans out over the fleet in `inventory-fleet.json` and aggregates a
   cross-repo catalog (the reuse surface). The catalog is an artifact, never a
   committed doc — a fleet-sized table would blow the docs-gov token budget.
4. **Tooling is classified from direct manifests, not inferred.** A package is
   "dev-tooling" when a repo declares it as a direct dev dependency; transitive
   packages stay runtime. The reuse question is "what tools did this repo
   choose," which is a direct-dependency fact.
5. **Action pin-status rides along.** The normalizer records whether each
   third-party action is SHA-pinned, so the catalog surfaces the
   [ENG-0005](ENG-0005-static-analysis-survey-results.md) workflow-security gap
   as a by-product without becoming a second enforcement path.

## Consequences

- Syft is a new external tool to track and pin. It earns its place by owning
  license detection; if it ever regresses, the SBOM step is replaceable without
  touching the normalizer, which only consumes CycloneDX.
- The central catalog needs a repo-scoped token (`FLEET_INVENTORY_TOKEN`) to
  read fleet repos, some of which are private. That is a new secret to steward —
  the cost of a cross-repo view an individual account cannot get for free.
- The catalog drifts when a repo's config lags reality: a repo with no
  `dependency-inventory.config.json` is inventoried with a shipped default, which
  can misclassify tooling or miss a manifest until the repo commits its own.
- Report-only means a bad license can appear in the inventory and still merge.
  Accepted: catching it is enforcement's job, and this record deliberately does
  not claim that role.
- Classifying tooling from direct dependencies only misses a tool pulled in
  transitively. This is the right trade for the reuse signal and wrong for a
  complete tooling graph; the catalog says "chosen," not "present."

## References

- [ENG-0004](ENG-0004-centralize-shared-cicd.md) — the reusable-workflow delivery model and `@v1` pinning this follows
- [ENG-0005](ENG-0005-static-analysis-survey-results.md) — the tools that keep enforcement, and the SHA-pinning direction the pin-status view supports
- [Dependency inventory reference](../reference/dependency-inventory.md) — schema, consumption, and the SHA-pin asymmetry
- [Release and versioning SOP](../sop/release-and-versioning.md) — the lockfile-and-Dependabot dependency policy this inventories against
- [Repo baseline files SOP](../sop/repo-baseline-files.md) — the `LICENSE` and `THIRD-PARTY-NOTICES.md` obligations the license inventory helps satisfy
