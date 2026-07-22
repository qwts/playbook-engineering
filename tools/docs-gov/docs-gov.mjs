#!/usr/bin/env node

// docs-gov — deterministic documentation governance (qwts/playbook-engineering#2).
//
// Gates docs the way code is gated, on the premise that the primary reader is
// an agent: the metric is task success per token of context, so the checks
// govern context cost, chunkability, integrity, and the anti-patterns that
// specifically break agents. `--list-rules` prints every rule with the agent
// failure it prevents — a rule that cannot name one is not allowed in.
//
// Zero dependencies by design: the reusable workflow runs this from a bare
// checkout of the playbook repo inside any consumer repo, with no install.
//
// Usage:
//   node tools/docs-gov/docs-gov.mjs [--root <dir>] [--config <file>]
//                                    [--report <file>] [--list-rules]
//
// Exit code 1 when any finding is reported; the output lists each finding as
// file:line, grouped by rule, with the rule's justification in the header.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { RULES, resolveConfig, runChecks } from './lib/checks.mjs';
import { matchesAny } from './lib/glob.mjs';

// Never scanned regardless of include globs: VCS internals, dependencies, and
// the directory the reusable workflow checks this tooling out into.
const HARD_EXCLUDES = ['.git/**', 'node_modules/**', '**/node_modules/**', '.docs-gov/**'];

function parseArgs(argv) {
  const args = { root: process.cwd(), config: null, report: null, listRules: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--root':
        args.root = path.resolve(argv[++i]);
        break;
      case '--config':
        args.config = argv[++i];
        break;
      case '--report':
        args.report = argv[++i];
        break;
      case '--list-rules':
        args.listRules = true;
        break;
      default:
        console.error(`docs-gov: unknown argument "${argv[i]}"`);
        process.exit(2);
    }
  }
  return args;
}

function walk(root, dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (matchesAny(rel, HARD_EXCLUDES) || matchesAny(rel + '/**', HARD_EXCLUDES)) continue;
    const stats = statSync(abs);
    if (stats.isDirectory()) walk(root, abs, out);
    else out.push(rel);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);

  if (args.listRules) {
    for (const rule of RULES) {
      console.log(`${rule.id}`);
      console.log(`  what:     ${rule.summary}`);
      console.log(`  prevents: ${rule.prevents}`);
    }
    return;
  }

  const configPath = path.resolve(args.root, args.config ?? 'docs-gov.config.json');
  let rawConfig;
  try {
    rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`docs-gov: could not read config ${configPath}`);
    console.error(`  - ${error.message}`);
    process.exit(2);
  }
  const config = resolveConfig(rawConfig);

  const allFiles = walk(args.root, args.root, []);
  const included = allFiles
    .filter((rel) => rel.endsWith('.md'))
    .filter((rel) => matchesAny(rel, config.include))
    .filter((rel) => !matchesAny(rel, config.exclude))
    .sort();

  if (included.length === 0) {
    console.error('docs-gov: include globs matched no markdown files — the gate is checking nothing.');
    process.exit(2);
  }

  const { findings, stats } = runChecks(args.root, included, config);

  if (args.report) {
    // The report is the drift record: one JSON per run, uploaded as a CI
    // artifact, so token totals and finding counts are comparable over time.
    writeFileSync(
      path.resolve(args.report),
      JSON.stringify({ config: configPath, stats, findings }, null, 2) + '\n',
    );
  }

  if (findings.length === 0) {
    console.log(
      `docs-gov OK: ${included.length} docs, ~${stats.totalTokens} estimated tokens, 0 findings.`,
    );
    return;
  }

  const byRule = new Map();
  for (const finding of findings) {
    const list = byRule.get(finding.rule) ?? [];
    list.push(finding);
    byRule.set(finding.rule, list);
  }
  console.error(`docs-gov failed: ${findings.length} finding${findings.length === 1 ? '' : 's'}.`);
  for (const rule of RULES) {
    const list = byRule.get(rule.id);
    if (!list) continue;
    console.error(`\n${rule.id} — prevents: ${rule.prevents}`);
    for (const finding of list) {
      console.error(`  ${finding.file}:${finding.line} ${finding.message}`);
    }
  }
  process.exitCode = 1;
}

main();
