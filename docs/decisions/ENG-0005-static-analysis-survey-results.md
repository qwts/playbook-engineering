# ENG-0005: Static-analysis survey — close the workflow-security gap, keep natives

**Status:** Proposed
**Date:** 2026-07-22
**Issue:** predates issue-first (ENG-0013)

## Context

[ENG-0002](ENG-0002-static-analysis-direction.md) chose per-language natives
over a central Sonar instance and left one question open: what exists in the
code-quality tooling landscape that has not been evaluated? This record is the
outcome of that survey
([playbook#1](https://github.com/qwts/playbook-software-engineering/issues/1)),
which was run hands-on against the org's repos at `main` on 2026-07-22: `photos`
(TS/Electron, the well-gated reference), `cartograph` (Rust/Tauri),
`image-trail` (TS), `bookmarkit` (JS, lightest gates). `quorum` (agent
orchestration/collaboration) was created the same day and is empty — the
greenfield the recommended baseline applies to from day one.

Tools actually run, with real output: Qlty, Trunk Check, Semgrep OSS,
`osv-scanner`, `gitleaks`, `jscpd`, `scc`, `lizard`, `electronegativity`.
Mega-Linter was not run hands-on (requires Docker, unavailable on the survey
machine; its Docker-only CI design also fits worst of the three aggregators).

## What the audit corrected before any tool ran

Two factual premises of ENG-0002 were stale within days of writing it:

- **"Only `photos` has gates" is false.** cartograph runs `cargo fmt` +
  `clippy -D warnings` + `cargo-deny` (advisories *and* licenses, with written
  justifications in `deny.toml`); image-trail has lint/format/coverage/
  acceptance gates; bookmarkit has lint+test+build. The real spread is
  "every repo has gates; their depth varies."
- **"Dependency and secret scanning absent everywhere" is false.** CodeQL
  default setup, secret scanning with push protection, and Dependabot security
  updates are enabled on **all** repos (CodeQL configured per-repo in settings,
  so no workflow file exists to grep — the trap noted in the issue). Only
  `quorum` lacks CodeQL, because it has no code yet.

ENG-0002's *direction* survives contact with the survey; its gap analysis did
not. The measured gaps are different from the assumed ones.

## Measured results

| Tool | Result | Verdict |
| --- | --- | --- |
| `gitleaks` (full history, all repos) | 8 findings, **8 false positives** (test fixtures, doc examples) | Redundant behind push protection; needs a baseline file to be gate-able |
| `osv-scanner` (lockfiles) | photos 0 · image-trail 6 (= Dependabot, parity) · **bookmarkit 1 High that Dependabot never alerted on** · cartograph 17, of which 16 are RUSTSEC-unmaintained noise `deny.toml` already scopes out deliberately | Adopt for npm repos as cheap redundancy; `cargo-deny` stays best-in-class for Rust |
| Semgrep OSS (`p/default` + `p/security-audit`) | 122 findings across repos; 82 are unpinned-action-tag; photos' 10 ERROR-level crypto findings verified as hardening nits (fixed 16-byte tag slice); **1 verified real workflow injection** (`${{ github.head_ref }}` in a `run:` block, photos `ci.yml`) | Unique value here is workflow security — covered better by zizmor/pinact below; not adopted as a recurring gate |
| CodeQL default setup (already on) | 0 open alerts on photos **including the `actions` language** — it did not flag the injection Semgrep found | Keep, but do not treat as covering workflow security |
| Qlty (zero-config, bookmarkit) | 40 issues, 9 security: composed repo-own eslint + **zizmor** (artipacked ×5, cache-poisoning, unpinned-uses, template-injection) + osv-scanner | Sharpest zero-config security composition of the aggregators |
| Trunk Check (zero-config, bookmarkit) | 51 issues via 15 auto-enabled linters incl. `pinact` (12 unpinned actions, **auto-fixable to SHA pins**), trufflehog, checkov; found the extension's `icon*.png` files are not valid PNGs | Broadest coverage + best auto-fix; more style noise (yamllint/markdownlint) |
| Aggregators on the gated repo (photos) | Qlty's sandboxed eslint breaks typed-rule type resolution (runs from a temp dir): ~50k bogus `no-unsafe-*` findings, 1,773 in one directory that the repo's own `npm run lint` passes clean — with `node_modules` fully installed | On a mature typed-TS repo the aggregator's lint lane is actively wrong, not merely redundant; typed eslint must stay native |
| `jscpd` | photos 3.6% · image-trail 3.3% · bookmarkit 2.5% · cartograph 13.9% — dominated by generated THIRD-PARTY-NOTICES and intentional per-language adapter symmetry | Trend metric only; numbers meaningless without an ignore list |
| `lizard` / `scc` | 385 functions over CCN 10 org-wide (~2% of 11.5k functions, avg CCN 2.3); bookmarkit worst per-line (CCN-58 filter, CCN-45 500-line component) | Cheap CSV-able trend instrument; not a gate |
| `electronegativity` (photos) | 11 findings, mostly TENTATIVE `openExternal`; its DB does not know Electron 42.x | One-off audit value only; too stale to gate on |

## Decision

1. **ENG-0002's direction stands.** Per-language natives remain the
   enforcement layer; no central server; Sonar stays deferred. This record
   amends ENG-0002's facts, it does not supersede its direction.
2. **The measured gap is GitHub Actions workflow security; closing it
   org-wide is the direction this record sets.** Every repo has unpinned
   mutable action tags; photos `ci.yml`
   carries a real `github.head_ref` shell-injection; CodeQL's `actions`
   analysis flagged none of it. Adopt per repo: pin all third-party actions to
   SHAs (mechanical via `pinact` or `trunk check --fix`) and run **zizmor** in
   CI — a natural ENG-0004 phase-1 reusable workflow alongside `osv-scanner`.
3. **Dependency scanning:** `osv-scanner` in CI for the npm repos (it caught a
   High advisory Dependabot missed on bookmarkit); `cargo-deny` unchanged for
   Rust — its justified-ignore model measured *better* than osv-scanner's raw
   output on cartograph.
4. **Secret scanning:** GitHub push protection is already the gate.
   `gitleaks` (planned in ENG-0004 phase 1) ships **only with a committed
   baseline/allowlist**; unconfigured it measured 100% false positives here.
5. **Ungated and greenfield repos get an aggregator baseline: Qlty, with its
   eslint lane scoped to what it measured well.** `qlty init` + `qlty check`
   on bookmarkit and on quorum from day one — zero-config it composed the
   repo's own eslint plus zizmor plus osv-scanner with the least noise, its
   config lives in-repo (`.qlty/qlty.toml`), it ratchets via diff-aware
   checks, and the CLI is open source with no server. One hard limit,
   measured: its sandboxed execution breaks typed-eslint type resolution, so
   **typed lint always runs natively in CI** (`npm run lint`), and Qlty's
   eslint plugin is disabled the day a repo adopts typed rules. Trunk Check is
   the runner-up (kept in mind for its auto-pinning and broader formatter
   set); `pinact` is adopted regardless. The well-gated repos (photos,
   cartograph, image-trail) keep their native setups — on a mature tuned repo
   the aggregator's lint lane measured actively wrong, not merely redundant.
6. **Trend instruments (`scc`, `lizard`, `jscpd`) are optional scripts, not
   gates.** Adopt only if a felt need for cross-repo trend lines appears;
   curate ignore lists first or the numbers mislead.

## Consequences

- Workflow-security adoption is new work in every repo (SHA pinning is
  auto-fixable; zizmor wiring rides ENG-0004 phase 1). Until done, the org's
  most-verified real vulnerability class stays open.
- SHA-pinned third-party actions trade the moving-tag convenience ENG-0004
  chose for its *own* reusable workflows. The two coexist by policy:
  third-party actions pin to SHAs; `qwts/playbook-software-engineering`
  workflows stay on the test-gated moving `@v1`. That asymmetry is deliberate
  and should be stated in the shared workflows' docs.
- Qlty on greenfield adds a second quality entry point next to plain eslint in
  repos that adopt it; the cost is one more tool version to track. If Qlty's
  hosted ambitions ever compromise the CLI, fall back to composing zizmor +
  osv-scanner + natives directly — everything it runs is itself open source.
- gitleaks with a baseline is weaker than "gitleaks anywhere, no config" —
  accepted; push protection already covers the high-value patterns, and a
  100%-FP gate would be deleted within a month anyway.
- Per-repo follow-ups surfaced by the survey are filed in their own repos, not
  here: the photos `ci.yml` injection fix, bookmarkit's invalid PNG icons and
  `brace-expansion` bump, CodeQL default setup on quorum once code lands.
- Repos the org direction says matter (Swift, C++, Obj-C, Ruby, .NET, Java)
  were evaluated on paper only — no repo in those languages exists yet. Qlty
  and Trunk both cover them; revisit with real code, not before.

## References

- [playbook#1](https://github.com/qwts/playbook-software-engineering/issues/1) — the survey issue, candidate list, and acceptance criteria
- [ENG-0002](ENG-0002-static-analysis-direction.md) — the direction this record confirms and factually amends
- [ENG-0004](ENG-0004-centralize-shared-cicd.md) — phase 1 is the delivery vehicle for zizmor/osv-scanner/gitleaks reusable workflows
- [Raw survey output](../reference/static-analysis-survey-2026-07-22.md) — tool versions, per-repo numbers, and the verified findings behind every claim above
