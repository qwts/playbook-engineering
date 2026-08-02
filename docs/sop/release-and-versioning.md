# SOP: Release and versioning

How a `qwts` repo that cuts releases tracks versions, records changes, and
handles dependency bumps. Shared baseline under [ENG-0008](../decisions/ENG-0008-shared-sop-inheritance.md).
This SOP is deliberately thin: release *mechanics* (tooling, tag format,
changeset flow) are still largely repo-local, so the baseline states only the
rules that already hold everywhere and marks the rest as recorded deltas.

## When this SOP applies

A repo is in scope once it cuts versions or releases. A repo that ships no
versioned artifact inherits nothing here and needs no delta — this SOP simply
does not apply to it.

## Changelog and version consistency (mandatory when applicable)

- A repo that cuts releases maintains a `CHANGELOG.md` (the trigger recorded in
  [repository baseline files](repo-baseline-files.md)); the release entry lands
  in the same unit of work as the change, not in a later sweep.
- The declared version stays consistent across the repo's manifests and
  lockfiles. Where a repo has a version-consistency check, that check is part of
  the merge bar.

## Dependency bumps

- Dependency versions are locked by a committed lockfile. Automated bumps come
  from Dependabot as the single version-bumping actor; contributor PRs do not
  hand-bump dependencies as a side effect of unrelated work.
- Dependabot security updates are on for every repo — the security floor recorded
  in [repository baseline files](repo-baseline-files.md) — and a bump follows the
  same review bar as any other change.
- A dependency-remediation commit does not accept a tool's autofix as proof that
  configuration can be deleted. It traces ignored binaries, dependencies,
  exports, platform commands, and packaging inputs to their consumers and runs
  the complete contract suite. Removing an exception is a reviewed behavior
  change, not incidental cleanup in a version bump.

## Validation reuse across versioning and release (mandatory)

- A changesets or equivalent version-packages PR is a ready PR. The generated
  version commit passes the repository's complete suite once under the
  [CI execution policy](../reference/ci-execution-policy.md).
- Version-cut automation generates and validates the version diff. It does not
  manually dispatch a second equivalent CI run in addition to the version PR's
  normal ready-PR run.
- Tag and release automation verifies that the exact source commit is on the
  protected default branch and has successful complete-suite evidence. Missing
  evidence stops publication or triggers an explicit complete-suite recovery
  run for that commit.
- Release automation does not repeat generic merge gates such as lint, format,
  typecheck, unit, Storybook, development-mode E2E, security, or docs-gov.
- Release-only validation remains: version/tag/provenance checks, the artifact
  build, packaging, signing, notarization, checksums, asset inspection, and
  packaged-mode install, launch, smoke, or E2E checks. These validate the thing
  being published and are not removed as duplicate CI.

### Semantic changeset planning

Repositories using Changesets distinguish raw `.changeset/*.md` presence from
semantic pending releases. Empty or frontmatter-only governance changesets may
satisfy a repository PR gate, but they do not open or refresh a Version packages
PR, block stranded-tag recovery, or make release verification reject an
otherwise valid source.

A generated Version packages PR is not a source PR. It has already consumed the
release intent into its version and changelog diff, so never manufacture an
empty input file to keep it green — see the
[CI policy](../reference/ci-execution-policy.md#changesets-version-prs-and-releases).

Version planning, tag planning, and release verification all consume the same
semantic release count produced by `changeset status --output`. A positive
`releases.length` fails closed before tagging or publishing. None of those lanes
may substitute `find .changeset`, a file count, or another raw-file heuristic.

## Changing a shared baseline

A substantive edit to a shared SOP or reusable workflow is itself a release: it
rides the [ENG-0004](../decisions/ENG-0004-centralize-shared-cicd.md)
review-then-propagate discipline — land it here behind review with the SOP
changelog updated, then let consumers re-point. A shared change never moves a
`@v1` tag before this repo's own gate is green.

## Recorded deltas (see the inventory for the full list)

- **photos** and **cartograph** each run a repo-local version-consistency gate
  (a `version:check`-style script) as part of CI; the exact command is a per-repo
  delta.
- **photos** additionally pins dependencies to exact versions (no semver ranges);
  most repos rely on the committed lockfile instead.
- Any repo that adopts a changeset tool records that tool and its flow as a delta
  until enough repos share it to promote the mechanics up here.

## Changelog

- 2026-08-02 — distinguished source release inputs from generated release
  projections and prohibited empty marker files as a regeneration workaround.
- 2026-08-01 — distinguish semantic Changesets releases from governance-only
  files and require dependency remediation to preserve traced tool exceptions.
- 2026-07-31 — required version PRs to receive one complete-suite validation
  and release workflows to reuse its exact-commit evidence while retaining
  release-specific provenance, packaging, signing, and artifact checks
  (ENG-0004).
- 2026-07-22 — initial version; captured the changelog, version-consistency, and
  dependency-bump rules already common across repos, and scoped the rest as
  recorded deltas pending promotion (ENG-0008).
