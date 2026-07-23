#!/usr/bin/env node

// repos — governed-scope manifest gate (ENG-0011).
//
// governance/repos.json is the single source of truth for which repositories
// this playbook governs. This CLI validates that manifest and keeps the human
// table in docs/reference/governed-repos.md in sync with it:
//
//   check   (default)  validate the schema, then fail if the doc's generated
//                      table does not match a fresh render of the manifest.
//   --write            regenerate the table block in the doc from the manifest.
//
// Zero dependencies by design (matches tools/docs-gov): CI runs it from a bare
// checkout with no install.
//
// Usage:
//   node tools/repos/repos.mjs [check] [--write]
//                              [--root <dir>] [--manifest <file>] [--doc <file>]
//
// Exit code 1 on any schema violation, missing markers, or table drift.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadManifest, validateManifest, renderBlock, extractBlock, spliceBlock } from './lib/manifest.mjs';

function parseArgs(argv) {
  const args = { root: process.cwd(), manifest: null, doc: null, write: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case 'check':
        break;
      case '--write':
        args.write = true;
        break;
      case '--root':
        args.root = path.resolve(argv[++i]);
        break;
      case '--manifest':
        args.manifest = argv[++i];
        break;
      case '--doc':
        args.doc = argv[++i];
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  // Relative --manifest/--doc paths resolve against --root, matching
  // docs-gov's --config behavior; absolute paths win as path.resolve always
  // lets them.
  args.manifest = path.resolve(args.root, args.manifest ?? path.join('governance', 'repos.json'));
  args.doc = path.resolve(args.root, args.doc ?? path.join('docs', 'reference', 'governed-repos.md'));
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  let manifest;
  try {
    manifest = loadManifest(args.manifest);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    console.error(`Manifest ${path.relative(args.root, args.manifest)} has ${errors.length} problem(s):`);
    for (const message of errors) console.error(`  - ${message}`);
    process.exit(1);
  }

  const docRel = path.relative(args.root, args.doc);
  let docSource;
  try {
    docSource = readFileSync(args.doc, 'utf8');
  } catch {
    console.error(`governed-repos doc not found: ${docRel}`);
    process.exit(1);
  }

  if (args.write) {
    let next;
    try {
      next = spliceBlock(docSource, manifest);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    if (next !== docSource) {
      writeFileSync(args.doc, next);
      console.log(`Regenerated table in ${docRel} from ${path.relative(args.root, args.manifest)}.`);
    } else {
      console.log(`${docRel} already up to date.`);
    }
    return;
  }

  // check: the doc's block must match a fresh render exactly.
  const current = extractBlock(docSource);
  const expected = renderBlock(manifest);
  if (current === null) {
    console.error(`${docRel} is missing the generated-table markers. Run: node tools/repos/repos.mjs --write`);
    process.exit(1);
  }
  if (current !== expected) {
    console.error(`${docRel} is out of date with governance/repos.json. Run: node tools/repos/repos.mjs --write`);
    process.exit(1);
  }
  console.log(`Manifest valid and ${docRel} is in sync (${manifest.repos.length} repos).`);
}

main();
