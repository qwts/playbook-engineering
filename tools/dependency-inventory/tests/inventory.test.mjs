import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSbom } from '../lib/sbom.mjs';
import { collectActions } from '../lib/workflows.mjs';
import { collectToolConfigs } from '../lib/toolconfigs.mjs';
import { buildInventory } from '../lib/inventory.mjs';
import { buildCatalog, renderCatalogMarkdown } from '../lib/catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'inventory.mjs');
const repo = path.join(here, 'fixtures', 'repo');
const sbomPath = path.join(here, 'fixtures', 'sbom.cyclonedx.json');
const config = JSON.parse(readFileSync(path.join(repo, 'dependency-inventory.config.json'), 'utf8'));

function componentsByName(inv) {
  return new Map(inv.components.map((c) => [c.name, c]));
}

test('parseSbom: normalizes the three license shapes and rejects non-CycloneDX', () => {
  const components = parseSbom(readFileSync(sbomPath, 'utf8'));
  const byName = new Map(components.map((c) => [c.name, c]));
  assert.deepEqual(byName.get('lodash').licenses, ['MIT']); // license.id
  assert.deepEqual(byName.get('prettier').licenses, ['The Prettier License']); // license.name
  assert.deepEqual(byName.get('@types/node').licenses, ['(MIT OR Apache-2.0)']); // expression
  assert.deepEqual(byName.get('mystery-lib').licenses, ['UNKNOWN']); // none
  assert.equal(byName.get('@types/node').ecosystem, 'npm'); // group folded into name
  assert.equal(byName.get('serde').ecosystem, 'cargo'); // ecosystem from purl
  assert.throws(() => parseSbom('{"components":[]}'), /not a CycloneDX/);
});

test('buildInventory: classifies dev-tooling from direct manifests', () => {
  const inv = buildInventory({ root: repo, repo: 'fixture', sbomRaw: readFileSync(sbomPath, 'utf8'), config });
  const byName = componentsByName(inv);
  // eslint/prettier/@types/node are npm devDependencies; criterion is a cargo
  // dev-dependency. lodash/serde/mystery-lib are runtime.
  assert.equal(byName.get('eslint').type, 'dev-tooling');
  assert.equal(byName.get('prettier').type, 'dev-tooling');
  assert.equal(byName.get('@types/node').type, 'dev-tooling');
  assert.equal(byName.get('criterion').type, 'dev-tooling');
  assert.equal(byName.get('lodash').type, 'runtime');
  assert.equal(byName.get('serde').type, 'runtime');
  assert.equal(byName.get('mystery-lib').type, 'runtime');
  assert.equal(inv.counts.components, 7);
  assert.equal(inv.counts.devTooling, 4);
  assert.equal(inv.counts.unlicensed, 1);
});

test('collectActions: reports pin status and exempts local uses', () => {
  const actions = collectActions(repo, config.workflows);
  const byUses = new Map(actions.map((a) => [a.uses, a]));
  assert.equal(byUses.get('actions/checkout').pinnedSha, '3d3c42e5aac5ba805825da76410c181273ba90b1');
  assert.equal(byUses.get('actions/setup-node').pinnedSha, null); // mutable tag @v4
  assert.equal(byUses.get('some/action').pinnedSha, null); // short ref, not a SHA
  assert.equal(byUses.get('./.github/actions/local-thing').ref, null); // local, no @ref
});

test('collectToolConfigs: detects configured config files only', () => {
  const found = collectToolConfigs(repo, config.toolConfigs);
  assert.ok(found.includes('.markdownlint.json'));
  assert.ok(found.includes('tsconfig.json'));
  assert.ok(!found.some((p) => p.endsWith('package.json'))); // not in the glob list
});

function runCli(extraArgs) {
  return execFileSync(process.execPath, [cli, ...extraArgs], { encoding: 'utf8' });
}

test('CLI single mode: writes a deterministic inventory report', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dep-inv-'));
  const report = path.join(dir, 'out.json');
  const args = ['--sbom', sbomPath, '--config', 'dependency-inventory.config.json', '--root', repo, '--repo', 'fixture', '--generated-at', 'FIXED', '--report', report];
  const first = runCli(args);
  const invA = readFileSync(report, 'utf8');
  runCli(args);
  const invB = readFileSync(report, 'utf8');
  assert.equal(invA, invB, 'same input must produce byte-identical output');
  assert.match(first, /dependency-inventory OK: 7 components/);
  const inv = JSON.parse(invA);
  assert.equal(inv.generatedAt, 'FIXED');
  assert.equal(inv.schema, 'qwts.dependency-inventory/v1');
});

test('CLI aggregate mode: builds a fleet catalog with markdown', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dep-inv-agg-'));
  for (const name of ['alpha', 'beta']) {
    runCli([
      '--sbom', sbomPath, '--config', 'dependency-inventory.config.json', '--root', repo,
      '--repo', name, '--generated-at', 'FIXED', '--report', path.join(dir, `${name}.inventory.json`),
    ]);
  }
  const catalogJson = path.join(dir, 'CATALOG.json');
  const catalogMd = path.join(dir, 'CATALOG.md');
  const out = runCli(['--aggregate', dir, '--generated-at', 'FIXED', '--report', catalogJson, '--markdown', catalogMd]);
  assert.match(out, /2 repos/);
  const catalog = JSON.parse(readFileSync(catalogJson, 'utf8'));
  assert.deepEqual(catalog.repos, ['alpha', 'beta']);
  const eslint = catalog.components.find((c) => c.name === 'eslint');
  assert.deepEqual(eslint.usedBy, ['alpha', 'beta']);
  assert.equal(eslint.type, 'dev-tooling');
  const setupNode = catalog.actions.find((a) => a.uses === 'actions/setup-node');
  assert.deepEqual(setupNode.unpinnedIn, ['alpha', 'beta']); // mutable tag flagged in both
  const checkout = catalog.actions.find((a) => a.uses === 'actions/checkout');
  assert.deepEqual(checkout.unpinnedIn, []); // SHA-pinned, clean
  const md = readFileSync(catalogMd, 'utf8');
  assert.match(md, /## Shared tooling/);
  assert.match(md, /## GitHub Actions/);
});

test('buildCatalog: a package used as tooling anywhere is tooling fleet-wide', () => {
  const runtimeOnly = { repo: 'r1', components: [{ name: 'x', ecosystem: 'npm', type: 'runtime', licenses: ['MIT'], version: '1' }], actions: [], toolConfigs: [] };
  const asTooling = { repo: 'r2', components: [{ name: 'x', ecosystem: 'npm', type: 'dev-tooling', licenses: ['MIT'], version: '1' }], actions: [], toolConfigs: [] };
  const catalog = buildCatalog([runtimeOnly, asTooling]);
  assert.equal(catalog.components.find((c) => c.name === 'x').type, 'dev-tooling');
});
