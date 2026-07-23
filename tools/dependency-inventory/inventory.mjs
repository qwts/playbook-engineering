#!/usr/bin/env node

// dependency-inventory — inventory the dependencies and tooling a governed repo
// uses (qwts/playbook-engineering, ENG-0011).
//
// Two goals: a license/compliance record of what is used, and a reuse signal so
// a new project can adopt the stack the fleet already runs rather than
// recreating the wheel. It is report-only by design — it never fails a build;
// license *enforcement* stays with osv-scanner / cargo-deny (ENG-0005).
//
// Zero dependencies, like docs-gov: the reusable workflow runs this from a bare
// checkout of the playbook repo inside any consumer, with no install. License
// detection is delegated to Syft (which produces the CycloneDX SBOM this reads),
// so the one hard part is not reimplemented here.
//
// Usage:
//   Per-repo inventory:
//     node tools/dependency-inventory/inventory.mjs \
//       --sbom <cyclonedx.json> [--config <file>] [--root <dir>] \
//       [--repo <name>] [--generated-at <value>] [--report inventory.json]
//
//   Fleet aggregation (many *.inventory.json → one catalog):
//     node tools/dependency-inventory/inventory.mjs \
//       --aggregate <dir> [--report CATALOG.json] [--markdown CATALOG.md] \
//       [--generated-at <value>]

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildInventory } from './lib/inventory.mjs';
import { buildCatalog, renderCatalogMarkdown } from './lib/catalog.mjs';

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    config: null,
    sbom: null,
    repo: null,
    generatedAt: process.env.INVENTORY_GENERATED_AT ?? null,
    report: null,
    markdown: null,
    aggregate: null,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--root':
        args.root = path.resolve(argv[++i]);
        break;
      case '--config':
        args.config = argv[++i];
        break;
      case '--sbom':
        args.sbom = argv[++i];
        break;
      case '--repo':
        args.repo = argv[++i];
        break;
      case '--generated-at':
        args.generatedAt = argv[++i];
        break;
      case '--report':
        args.report = argv[++i];
        break;
      case '--markdown':
        args.markdown = argv[++i];
        break;
      case '--aggregate':
        args.aggregate = path.resolve(argv[++i]);
        break;
      default:
        console.error(`dependency-inventory: unknown argument "${argv[i]}"`);
        process.exit(2);
    }
  }
  return args;
}

function fail(message, error) {
  console.error(`dependency-inventory: ${message}`);
  if (error) console.error(`  - ${error.message}`);
  process.exit(2);
}

function aggregate(args) {
  let files;
  try {
    files = readdirSync(args.aggregate).filter((f) => f.endsWith('.inventory.json'));
  } catch (error) {
    fail(`could not read aggregate directory ${args.aggregate}`, error);
  }
  if (files.length === 0) {
    fail(`no *.inventory.json files in ${args.aggregate} — nothing to aggregate`);
  }
  const inventories = files.sort().map((f) => JSON.parse(readFileSync(path.join(args.aggregate, f), 'utf8')));
  const catalog = buildCatalog(inventories, { generatedAt: args.generatedAt });

  if (args.report) writeFileSync(path.resolve(args.report), JSON.stringify(catalog, null, 2) + '\n');
  if (args.markdown) writeFileSync(path.resolve(args.markdown), renderCatalogMarkdown(catalog) + '\n');
  console.log(
    `dependency-inventory catalog: ${catalog.repos.length} repos, ${catalog.components.length} distinct packages, ` +
      `${catalog.actions.filter((a) => a.unpinnedIn.length).length} actions unpinned somewhere.`,
  );
}

function single(args) {
  let sbomRaw;
  try {
    sbomRaw = readFileSync(path.resolve(args.sbom), 'utf8');
  } catch (error) {
    fail(`could not read SBOM ${args.sbom}`, error);
  }
  const configPath = path.resolve(args.root, args.config ?? 'dependency-inventory.config.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail(`could not read config ${configPath}`, error);
  }

  let inventory;
  try {
    inventory = buildInventory({
      root: args.root,
      repo: args.repo,
      sbomRaw,
      config,
      generatedAt: args.generatedAt,
    });
  } catch (error) {
    fail('could not build inventory', error);
  }

  if (args.report) writeFileSync(path.resolve(args.report), JSON.stringify(inventory, null, 2) + '\n');
  console.log(
    `dependency-inventory OK: ${inventory.counts.components} components ` +
      `(${inventory.counts.devTooling} dev-tooling, ${inventory.counts.unlicensed} unlicensed), ` +
      `${inventory.actions.length} actions, ${inventory.toolConfigs.length} tool configs.`,
  );
}

function main() {
  const args = parseArgs(process.argv);
  if (args.aggregate) return aggregate(args);
  if (!args.sbom) fail('one of --sbom <file> or --aggregate <dir> is required');
  return single(args);
}

main();
