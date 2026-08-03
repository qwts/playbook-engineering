# ENG-0149: Code scanning conformance is verified by analysis, not by configuration

**Status:** Proposed
**Date:** 2026-08-03
**Issue:** qwts/playbook-engineering#149

## Context

`bookmarkit` went unscanned for two days and nothing reported it.

Default setup was disabled fleet-wide. Eight governed repos had already adopted
an advanced reusable CodeQL workflow by hand; `bookmarkit` never did, so it lost
code scanning with no replacement. CodeQL nevertheless remained a **required**
status check there, and nothing produced it: qwts/bookmarkit#121 was green on
every real check, approved, with every commit signature valid, and still had to
be merged with `--admin`. The fleet dashboard reported nothing, because it only
inspected GitHub's default-setup endpoint.

The obvious remedy — make `.github/workflows/codeql.yml` a governed baseline
file so the sync detects a repo missing it — does not work:

- The workflow is `workflow_call`-only. A byte-identical copy does nothing until
  the repo's own `ci.yml` invokes it, and `ci.yml` is deliberately per-repo
  (coverage floors, Rust gates, version-consistency). Governing the file would
  guarantee its presence and not its effect, which is the same false assurance
  in a new place.
- The existing copies legitimately differ. A survey of the eight found **seven
  distinct blob SHAs**; `cartograph` adds `rust` to the language matrix. Blob-SHA
  comparison, which is how governed files are enforced, would report drift on
  correct repos.

Scanning `.github/workflows/` for `github/codeql-action` avoids byte-identity but
substitutes a text heuristic that guesses in both directions: a reusable workflow
whose path avoids the word "codeql" is invisible, and a comment mentioning
`codeql-action` over-matches. It also still answers the wrong question — whether
a file exists, not whether scanning happens.

## Decision

1. **Conformance is measured by analyses, not by configuration.** The drift
   detector reads `GET /repos/{owner}/{repo}/code-scanning/analyses`, pinned to
   the default branch, and derives the setup from the `analysis_key` GitHub
   stamps on each analysis. This asks the question that matters: is this repo
   being scanned?

2. **Advanced setup is the conformant state; default setup is drift.** An
   `analysis_key` under `dynamic/github-code-scanning/` identifies GitHub's
   default setup, which runs as the unselectable `github-advanced-security[bot]`
   actor and therefore sits outside the repository Actions Policy. Any other
   `analysis_key` names the workflow that produced the analysis and is
   conformant. A repo scanning via default setup is being scanned but is not
   conformant, and the gate reports the second.

3. **Unreadable is never conformant, and never a guessed "none".** The helper
   returns `null` for anything it cannot interpret — a non-array body, entries
   without a string `analysis_key`. Only a genuinely empty list is `'none'`. The
   gate passes on `'advanced'` alone, so every unknown fails closed.

4. **`.github/workflows/codeql.yml` is not a governed baseline file.** Repos own
   their copy, including a language matrix that fits the repo. What governance
   requires is the outcome.

5. **Code scanning has no automated reconcile lane.** Because the fix spans a
   file the reconciler could seed and a `ci.yml` it must not edit, drift routes
   to the human lane carrying the actual remediation — copy the workflow, add
   the calling job, declare permissions at the call site — rather than a bare
   report of failure.

## Consequences

- Absence is caught; legitimate variation is not flagged. Validated against the
  live fleet at the time of writing: eight repos pass, `bookmarkit` fails, and it
  fails as `'default'` rather than `'none'` because its July default-setup
  analyses are still the most recent on `main`. It converges once
  qwts/bookmarkit#125 lands an advanced analysis there.
- A repo whose workflow exists but has never run reads as non-conformant. This
  is intended. A workflow that has produced no analysis is not protecting the
  repo, and reporting it as configured is precisely the false assurance that let
  `bookmarkit` go dark. The window is self-closing after one CI run.
- The drift token needs no new scope: the code-scanning read it already performs
  covers this, and no source-reading permission is introduced.
- The same `analysis_key` discriminator is the basis for the fleet dashboard's
  setup detection (qwts/playbook-dashboard#55), so governance and the dashboard
  agree by construction rather than by coincidence.
