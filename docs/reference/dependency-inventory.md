# Dependency & tooling inventory

A report-only inventory of what each governed repo depends on and which tools it
runs, for two uses: a license/compliance record, and a fleet-wide catalog so new
projects adopt the existing stack rather than rebuild it. The tooling lives in
[`tools/dependency-inventory/`](../../tools/dependency-inventory/inventory.mjs)
and reaches every qwts repo through a reusable workflow. Decision record:
[ENG-0011](../decisions/ENG-0011-dependency-inventory.md). It never fails a
build — enforcement stays with osv-scanner and cargo-deny (ENG-0005).

## How it works

Syft scans the repo and emits a CycloneDX SBOM (packages with detected
licenses). The zero-dependency normalizer then folds that SBOM together with two
things an SBOM does not carry — the GitHub Actions the repo's workflows use, and
the tool-config files it keeps — into a single JSON document. License detection
is Syft's; the normalizer never re-implements SPDX matching.

## The inventory schema

Per repo, `inventory.mjs --sbom … --report inventory.json` produces:

| Field | Contents |
| --- | --- |
| `components[]` | Every package: `name`, `version`, `ecosystem`, `licenses[]`, `purl`, and `type` (`runtime` or `dev-tooling`) |
| `actions[]` | Each GitHub Action a workflow uses: `uses`, `ref`, and `pinnedSha` (null when unpinned — the ENG-0005 signal) |
| `toolConfigs[]` | Config files present (e.g. `.markdownlint.json`, `deny.toml`), the direct "which tools" signal |
| `counts` | Component, dev-tooling, and unlicensed totals for quick diffing |

A package is `dev-tooling` when a repo declares it as a direct dev dependency
(npm `devDependencies`, cargo `[dev-dependencies]`/`[build-dependencies]`);
everything else is `runtime`. Configuration is per-repo in
`dependency-inventory.config.json` (manifest paths, workflow globs, tool-config
globs), so each repo names what counts while the normalizer stays shared.

## Running locally

```bash
node tools/dependency-inventory/inventory.mjs --sbom <sbom.json> --root . --repo <name>
```

In this repository, `npm run inventory` invokes the same CLI. Aggregate several
per-repo reports into a fleet catalog with `--aggregate <dir>`, which writes a
JSON catalog and a Markdown rendering sorted by fleet reach.

## Consuming from another repo

```yaml
jobs:
  dependency-inventory:
    uses: qwts/playbook-engineering/.github/workflows/dependency-inventory.yml@v1
```

The reusable workflow checks out the caller, runs Syft, fetches this repo's
normalizer, and uploads `dependency-inventory.json` as an artifact. As with
docs-gov, the `v1` tag only moves after this repo's own CI has exercised the
workflow (the ENG-0004 safety condition).

## The fleet catalog

`inventory-catalog.yml` runs weekly and on demand: it reads the fleet list in
`inventory-fleet.json`, inventories each repo, and aggregates one cross-repo
catalog artifact — shared tooling by reach, licenses in use, and which Actions
are unpinned where. It needs a repo-scoped `FLEET_INVENTORY_TOKEN` secret to
read private fleet repos; provision it before the first run.

## The SHA-pin asymmetry

Third-party actions in these workflows are pinned to full commit SHAs, while the
reusable workflow itself is consumed at the moving `@v1` tag. That split is
deliberate (ENG-0005): external code is pinned to an immutable commit, and this
repo's own workflows ride a tag its CI gates before moving. The inventory
reports pin status precisely so the first half of that policy stays visible.

## What this deliberately does not do

- **No enforcement.** It does not fail on a disallowed license or a known
  advisory; that is osv-scanner's and cargo-deny's job.
- **No transitive tooling.** It classifies tools from direct dependencies, so a
  linter pulled in transitively reads as runtime.
- **No committed catalog.** The fleet catalog is an artifact; a fleet-sized
  table would exceed the docs-gov per-doc token budget.
