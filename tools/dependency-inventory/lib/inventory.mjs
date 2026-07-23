// Build one repo's inventory document from an SBOM + the repo checkout.
//
// The schema is the playbook's own, not CycloneDX: it folds Syft's package/
// license data together with the two things an SBOM does not carry — the
// GitHub Actions a repo runs and the tool-config files it keeps — into the
// single shape the fleet catalog aggregates. See docs/reference/dependency-inventory.md.

import { parseSbom } from './sbom.mjs';
import { devToolingNames } from './manifests.mjs';
import { collectActions } from './workflows.mjs';
import { collectToolConfigs } from './toolconfigs.mjs';

export function resolveConfig(raw) {
  return {
    manifests: raw.manifests ?? {},
    workflows: raw.workflows ?? ['.github/workflows/*.yml', '.github/workflows/*.yaml'],
    toolConfigs: raw.toolConfigs ?? [],
  };
}

// `generatedAt` is passed in from CI (a commit/run timestamp), never read from
// the clock here — two runs of the same commit must produce byte-identical
// output so a diff shows real change, not wall-clock drift.
export function buildInventory({ root, repo, sbomRaw, config, generatedAt = null }) {
  const cfg = resolveConfig(config);
  const devNames = devToolingNames(root, cfg.manifests);

  const components = parseSbom(sbomRaw).map((c) => ({
    ...c,
    type: devNames.has(c.name) ? 'dev-tooling' : 'runtime',
  }));

  return {
    schema: 'qwts.dependency-inventory/v1',
    repo: repo ?? null,
    generatedAt,
    sbomSource: 'cyclonedx',
    counts: {
      components: components.length,
      devTooling: components.filter((c) => c.type === 'dev-tooling').length,
      unlicensed: components.filter((c) => c.licenses.includes('UNKNOWN')).length,
    },
    components,
    actions: collectActions(root, cfg.workflows),
    toolConfigs: collectToolConfigs(root, cfg.toolConfigs),
  };
}
