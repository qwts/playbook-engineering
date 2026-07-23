# ENG-0002: Static analysis — per-language natives now, central instrument later

**Status:** Accepted
**Date:** 2026-07-19
**Issue:** predates issue-first (ENG-0013)

## Context

With agents writing most of the code across a growing set of repos, the concern
is quality drift that no single review would catch. The initial idea was
SonarQube Community Edition as a gate before pushing pull requests.

Two things were wrong with that framing.

**Community Edition cannot gate pull requests.** Branch and PR analysis are
Developer Edition features. Community Build analyzes one branch per project, so
a PR scan is either unusable or misattributed to `main`, defeating the new-code
quality gate that makes Sonar worth gating on. Community Edition is also not a
security tool — taint and dataflow analysis is Developer Edition and up.

**The real goal was not a gate.** It was a feedback loop: use a broad, curated
rule catalog to discover what the hand-written enforcement is *not* checking,
then encode the worthwhile findings back into per-repo gates. Sonar as an
instrument, not an enforcement mechanism.

The intended language footprint is TypeScript/JS, Python, Go, Swift, Java, Rust,
C++, C, and C#/.NET. Community Build covers TS/JS, Python, Go, Java, and C#. It
does **not** cover Swift, C, or C++ — precisely the planned iOS/mobile
direction. Rust support was added recently; verify its tier before relying on it.

## Decision

No Sonar instance for now. Direction, in order:

1. **Per-language native linters are the enforcement layer.** `eslint`,
   `golangci-lint`, `ruff`, `clippy`, `swiftlint`, `clang-tidy`. Free, sharper
   per language than any generic ruleset, and they cover the languages Sonar
   Community cannot.
2. **Ratcheting gates in CI**, per repo, on the `qwts/photos` model — floors and
   budgets that only ever move one direction. Prevention beats detection, and it
   requires no server.
3. **A central cross-repo instrument is deferred**, revisited when the polyglot
   expansion is real and several repos are active at once. When that happens,
   evaluate polyglot aggregators with new-code ratcheting (Trunk Check, Qlty,
   Mega-Linter) alongside Sonar Community Build — they have no tier wall at
   Swift or C++ and need no server.

Buying Developer Edition is explicitly not the answer when Swift becomes real.

## Consequences

- No single pane of glass across repos yet. That is the accepted cost, and it is
  the main thing that would justify revisiting.
- Per-language natives mean per-repo configuration to maintain, with no shared
  ruleset and no aggregated trend history.
- Enforcement quality depends on each repo actually having gates. Today only
  `photos` does; the others have none. That gap is the real risk, larger than
  the absence of a dashboard.
- No cross-file duplication detection. `jscpd` covers this free and polyglot if
  it becomes a felt problem.
- Dependency vulnerability and secret scanning remain absent everywhere
  (`osv-scanner`, `gitleaks`, `trivy` are unadopted). Tracked separately.

## References

- [`qwts/photos#561`](https://github.com/qwts/photos/issues/561) — the original
  issue and the full reasoning trail that produced this record.
