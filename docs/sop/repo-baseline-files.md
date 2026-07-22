# SOP: Repository baseline files

**Scope:** every `qwts` repository. **Model:** [ENG-0008](../decisions/ENG-0008-shared-sop-inheritance.md) —
inherit by default, vary by explicit delta.

## Required in every repo (mandatory — extend, don't drop)

| File | Rule |
| --- | --- |
| `README.md` | What it is, how to run it, where deeper docs live. |
| `LICENSE` | Exactly this filename. Licensing is deliberately per-repo (MIT, PolyForm NC, proprietary, Apache-2.0 all in use); *absence* is the only violation. |
| `AGENTS.md` | Canonical agent context per [ENG-0006](../decisions/ENG-0006-agentic-primitives-governance.md); vendor files are thin adapters. |
| `CONTRIBUTING.md` | May be a pointer stub into `docs/` (the photos pattern). |
| `.github/CODEOWNERS` | Minimum: `* @qwts` plus explicit `/.github/` ownership. |
| Feature issue template | The shared [feature-lifecycle](feature-lifecycle.md) form ([ENG-0007](../decisions/ENG-0007-feature-lifecycle-convention.md)); repos may add fields, not drop sections. |

## Required when applicable

| File | Trigger |
| --- | --- |
| `CHANGELOG.md` | The repo cuts versions/releases. |
| `THIRD-PARTY-NOTICES.md` | The repo distributes bundled third-party code. Use this exact name in new repos (existing `THIRD-PARTY-LICENSES.txt` in image-trail is a recorded delta, not a pattern to copy). |
| Design docs | Anything beyond a trivial tool: `DESIGN.md` for small repos, `docs/design/` or `design/` for large ones. Location is free; existence is not. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Only when the repo needs more than the org default (gates, coverage maps); otherwise inherit. |

## Inherited from `qwts/.github` (do not copy into repos)

`SECURITY.md`, `SUPPORT.md`, and the default PR template are served
automatically to any repo that lacks its own. A repo adds a local copy only
as a deliberate delta (e.g. photos' gate-specific PR template) — never as a
duplicate of the default.

## Repo-side settings that accompany the files

Private vulnerability reporting **enabled** (SECURITY.md depends on it);
secret scanning + push protection and Dependabot security updates **on**
(the ENG-0005 baseline); CodeQL default setup **on** once the repo has code.

## Changelog

- 2026-07-22 — initial version, from the basic-docs audit following PR #8.
- 2026-07-22 — point the feature-template row at the new [feature-lifecycle SOP](feature-lifecycle.md) (playbook#9).
