# Static-analysis tooling survey — raw results (2026-07-22)

Supporting data for [ENG-0005](../decisions/ENG-0005-static-analysis-survey-results.md);
produced for [playbook#1](https://github.com/qwts/playbook-software-engineering/issues/1).

Repos surveyed at GitHub `main`: photos @0970249c, cartograph @c400349,
image-trail @9205f65, bookmarkit @da5b495. quorum created 2026-07-22, empty.

## Baseline audit (what exists today)

| Layer | photos | cartograph | image-trail | bookmarkit | quorum |
|---|---|---|---|---|---|
| CI lint/format | eslint+prettier | fmt+clippy -D warnings + eslint | eslint+prettier | eslint | — |
| Coverage/ratchets | yes (.guard) | tests | coverage+acceptance | — | — |
| CodeQL default setup | yes (0 alerts) | yes (incl. rust) | yes | yes | not configured |
| Secret scanning + push protection | yes | yes | yes | yes | yes |
| Dependabot security updates | yes | yes | yes | yes | yes |
| Dependency audit in CI | — | cargo-deny (advisories+licenses) | — | — | — |

ENG-0002's "only photos has gates" and "dependency and secret scanning absent
everywhere" are both stale. GitHub-native security layer is on org-wide;
cartograph is arguably better-gated than photos on the supply-chain side.

## Tool runs

### gitleaks 8.30.1 (full history, default config)
- photos: 6 findings, cartograph: 2, image-trail/bookmarkit: 0.
- **All 8 are false positives** (deterministic test fixtures `0123456789abcdef`,
  `sk-live-abcdef1234` in a redaction test, doc examples). Measured FP rate
  100% on this corpus; needs a baseline/allowlist to be gate-able.
- GitHub push protection already covers provider-pattern secrets org-wide.

### osv-scanner 2.4.0 (lockfiles, GitHub main)
- photos: 0. image-trail: 6 High (all dev deps; Dependabot open alerts match
  1:1 — parity). bookmarkit: 1 High (brace-expansion 1.1.14, dev) —
  **Dependabot has zero alerts in any state for it → genuine gap** in the
  GitHub-native layer (dependency graph lag/miss).
- cartograph: 17 findings, 16 = RUSTSEC unmaintained (GTK3 via Tauri Linux
  stack) + 1 glib unsound — exactly the class deny.toml deliberately scopes
  out with written justification. osv-scanner noisier than cargo-deny here;
  cargo-deny's in-repo justification model is the better fit for Rust.

### jscpd 5.0.12 (min-tokens default)
- photos 3.57%, image-trail 3.27%, bookmarkit 2.52%, cartograph 13.85%.
- cartograph's number is dominated by generated THIRD-PARTY-NOTICES.md (80
  clones) and per-language adapter crates (go/java/ts) sharing structure —
  structural/intentional, not rot. Useful as a trend metric, not a gate.

### scc / lizard (size + complexity)
- LOC: photos 138k, image-trail 129k, cartograph 75k, bookmarkit 9.7k.
- Functions over CCN 10: photos 135, image-trail 141, cartograph 83,
  bookmarkit 26. Org avg CCN 2.3 (healthy).
- bookmarkit worst per-line: CCN-58 filter fn, CCN-45/27 500-line components.

### Semgrep OSS 1.170.0 (p/default + p/security-audit)
- photos 43, cartograph 39, image-trail 23, bookmarkit 17 findings.
- Dominated by `github-actions-mutable-action-tag` (82 of 122 total).
- photos ERROR-level: 10× `gcm-no-tag-length` — verified hardening nits (tag
  is fixed 16-byte slice; forgery not possible); 1× `run-shell-injection` in
  ci.yml:385 (`${{ github.head_ref }}` interpolated into run:) — **verified
  real workflow-injection instance that CodeQL (actions enabled, 0 alerts)
  did not flag**; 1× secrets-inherit (deliberate, documented).
- Value concentrated in workflow security + a few real classes; code findings
  mostly hardening advice. Rust coverage thin in OSS rules.

### Qlty 0.637.0 (`qlty init --no` zero-config, bookmarkit)
- 40 issues, 9 security. Auto-composed: repo's eslint (complexity/max-lines
  via its own config), **zizmor** (5× artipacked, cache-poisoning,
  unpinned-uses, template-injection), osv-scanner (CVE match), ripgrep TODOs.
- zizmor's workflow-security findings are a category nothing in the current
  stack covers. Sampled findings checked out (unpinned v-tags confirmed).

### Qlty 0.637.0 (photos — the gated reference)
- Halted at its 50,000-issue ceiling: eslint 49,999 issues. Root cause is not
  missing deps — reproduced **with** `npm ci` complete. Qlty executes linters
  from a sandbox temp dir, which breaks typed-eslint type resolution; every
  typed rule degrades to `no-unsafe-* / type could not be resolved`. Scoped
  run on `src/main/crypto` alone: 1,773 issues; the repo's own
  `npm run lint` passes the same tree clean in CI.
- Conclusion: on a mature typed-TS repo the aggregator's eslint lane is
  actively wrong, not merely redundant. Typed lint must stay native; Qlty's
  value is the security/hygiene composition (zizmor, osv-scanner, actionlint).

### Trunk Check 1.25.0 (zero-config init, bookmarkit)
- 14 security + 37 lint issues. Auto-enabled 15 linters: actionlint, checkov,
  eslint (repo config), grype, markdownlint, osv-scanner, oxipng, pinact,
  prettier, svgo, taplo, trufflehog, yamllint.
- 12× pinact unpinned-action, **auto-fixable to SHA pins** (`trunk check --fix`).
- osv finding matches standalone run (brace-expansion).
- **Real bug found by accident**: `public/icon16/48/128.png` are not valid
  PNG files ("Invalid header detected") — shipped extension icons.
- Noise present: yamllint quoted-strings (high sev for style), markdownlint
  MD041 on changeset files. Needs a trim pass, but "hold the line" means
  existing issues don't block.
- Caveat: eslint via Trunk needs `npm ci` first (it runs the repo's flat
  config); identical to CI requirements.

### electronegativity 1.10.3 (photos)
- 11 findings: 6× OPEN_EXTERNAL (tentative), PERMISSION_REQUEST_HANDLER
  (certain/medium), CSP (low/firm), AUXCLICK, PRELOAD.
- Tool DB does not know Electron 42.x ("Unknown Electron release") — project
  reads dated; one-off audit value, weak as a recurring gate.

### Not run
- Mega-Linter: requires Docker; not installed on this machine. Docker-based
  CI-only design also fits the org worse than trunk/qlty CLIs.
- SonarQube Community Build: deferred per ENG-0002, out of scope per issue.

## Cross-cutting observations

1. The single biggest measured gap is **GitHub Actions workflow security**:
   unpinned mutable action tags in every repo (82 Semgrep findings, 12–14 per
   repo via pinact/zizmor), plus one verified template-injection in photos
   ci.yml. Nothing in the current stack (including CodeQL with `actions`
   enabled) flags any of this.
2. Dependency scanning: GitHub-native mostly works but demonstrably missed
   bookmarkit's brace-expansion; an in-CI osv-scanner is cheap redundancy for
   npm repos; cargo-deny already superior for Rust.
3. Secret scanning: gitleaks adds only false positives over the already-on
   GitHub push protection (100% FP on this corpus).
4. Complexity/duplication: real signal (esp. bookmarkit) but belongs as
   ratcheted trend metrics, not absolute gates, or existing debt blocks
   adoption. jscpd needs ignore-list curation before numbers mean anything.
5. Aggregators (both zero-config): Qlty composed the sharper security set
   (zizmor); Trunk had the broader linter set + SHA auto-pinning + hold-the-
   line ratcheting. Both wrap the repo's own eslint config rather than
   imposing one. Both keep config in-repo (.qlty/qlty.toml, .trunk/trunk.yaml).
