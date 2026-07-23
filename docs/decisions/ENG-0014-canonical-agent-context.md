# ENG-0014: Canonical agent context is CLAUDE.md — AGENTS.md generated, copies gated, baselines vendored

**Status:** Proposed
**Date:** 2026-07-23
**Issue:** qwts/playbook-engineering#23

## Context

The org develops with eight agentic tools: Claude Code, VS Code with GitHub
Copilot, Antigravity, Grok Build, Cursor, Devin/Windsurf, and Codex.
[ENG-0006](ENG-0006-agentic-primitives-governance.md) anchored agent context
on a vendor-neutral `AGENTS.md` with thin vendor adapters — but Claude Code,
the dominant tool, does not natively read `AGENTS.md`. The surveyed matrix
(2026-07): `AGENTS.md` is read natively by seven of the eight tools;
`CLAUDE.md` by a subset (Claude Code, Grok, Copilot, Devin); only Claude
Code, Antigravity, and Grok implement a `SKILL.md` skills primitive, each at
a different path. Separately, the link-vs-copy boundary was never crisply
stated, and agents working in governed repos should not need to clone this
playbook — or wade through process — to reach guidance they need every
session.

## Decision

1. **`CLAUDE.md` is the human-authored canonical agent-context file.**
   Claude-first: the dominant tool, and normally the one setting the
   standard. Vendor files (e.g. `.github/copilot-instructions.md`) contain
   only requirements specific to that tool — ENG-0006's thin-adapter model
   is retained; only its choice of canonical file is amended.
2. **`AGENTS.md` is a generated copy of `CLAUDE.md`**, kept honest by a CI
   drift-check — the ENG-0011 generated-artifact pattern, not a symlink
   (symlinks are fragile across platforms and tools). Together the two files
   reach all eight tools with byte-identical content.
3. **The link-vs-copy rule:** copy only what an agent needs *every session*,
   and only if the copy is machine-generated and CI-drift-checked;
   everything else is linked. A human-maintained copy is a fork, and a fork
   is a bug.
4. **The shared baseline is vendored into governed repos.** Each governed
   repo's `CLAUDE.md` carries a small generated, version-stamped baseline
   block between fixed markers. Sync is manual at first (v0), drift-checked
   by the shared CI; an auto-PR pipeline is deferred until the toil
   justifies its token and secret-management cost. Deep guidance — SOPs,
   ENG records, SDLC guides — stays linked, fetched on demand from this
   public repo.
5. **[`governance/repos.json`](../../governance/repos.json) is the
   distribution list** ([ENG-0011](ENG-0011-governed-scope-manifest.md)):
   entering governance is subscribing to the baseline.

## Consequences

- This repo's own setup inverts: today `AGENTS.md` is authored and canonical.
  Migration — flipping authorship, building the generator and drift-check,
  seeding the vendored blocks — is implementation work tracked on the issue,
  not part of this record.
- A vendor-named canonical file trades ENG-0006's vendor neutrality for
  alignment with the dominant tool. If dominance shifts, the generator flips
  direction; the content, being identical in both files, survives unchanged.
- Antigravity gives `GEMINI.md` precedence over `AGENTS.md`: a stray
  `GEMINI.md` in a governed repo can shadow the baseline. Governed repos must
  not carry one except as a deliberate, recorded delta.
- Devin's skill-equivalent ("Knowledge") is authored in its hosted dashboard;
  repo files reach Devin only through its `AGENTS.md` ingestion. Dashboard
  content is out of scope for this governance.
- Skill distribution to the three skill-capable tools is deliberately
  deferred — a decision for when a skill actually earns its maintenance.

## References

- qwts/playbook-engineering#23 — the originating issue and tool matrix
- [ENG-0006](ENG-0006-agentic-primitives-governance.md) — amended (canonical file), retained (thin adapters)
- [ENG-0011](ENG-0011-governed-scope-manifest.md) — the manifest that becomes the distribution list
- [ENG-0012](ENG-0012-decision-priority-order.md) — the lens applied: token efficiency (3) drives vendoring; it never outranks the security caveats the baseline carries (1)
