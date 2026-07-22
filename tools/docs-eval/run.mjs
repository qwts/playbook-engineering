#!/usr/bin/env node

// docs-eval — the Phase 2 evaluation loop of qwts/playbook-engineering#2,
// SkillOpt-shaped: score an agent's task success against a docs revision, so
// a doc edit is defended by evidence instead of taste.
//
// Where Phase 1 (docs-gov) governs FORM deterministically and gates merges,
// this measures whether the docs WORK, costs model calls, and is therefore
// run on demand — never as a merge gate.
//
// Pipeline per run:
//   1. Stage the doc set (benchmark.json docSet) from a git ref or the
//      working tree into a temp dir — the agent sees ONLY the docs, so code
//      cannot answer for them.
//   2. For each benchmark task, ask a fresh headless agent (`claude -p`) the
//      question with the staged dir as its whole world.
//   3. Grade deterministically: every mustMatch regex must match. No LLM
//      judge — grading flakiness would poison the ratchet.
//   4. Report train/validation splits separately; compare.mjs applies the
//      held-out gate between two runs.
//
// Usage:
//   node tools/docs-eval/run.mjs [--ref <git-ref>] [--model <id>]
//                                [--answers <file>] [--out <file>] [--stage-only]
//
// --answers <file> skips collection and grades pre-collected answers
// ({taskId: answerText}) — this decouples the executor, so answers may come
// from any agent harness while the grading stays identical.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function parseArgs(argv) {
  const args = {
    ref: null,
    model: 'claude-haiku-4-5-20251001',
    answers: null,
    out: null,
    stageOnly: false,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--ref':
        args.ref = argv[++i];
        break;
      case '--model':
        args.model = argv[++i];
        break;
      case '--answers':
        args.answers = argv[++i];
        break;
      case '--out':
        args.out = argv[++i];
        break;
      case '--stage-only':
        args.stageOnly = true;
        break;
      default:
        console.error(`docs-eval: unknown argument "${argv[i]}"`);
        process.exit(2);
    }
  }
  return args;
}

export function stageDocs(docSet, ref) {
  const dir = mkdtempSync(path.join(tmpdir(), 'docs-eval-'));
  if (ref) {
    const tar = execFileSync('git', ['-C', repoRoot, 'archive', ref, '--', ...docSet], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const result = spawnSync('tar', ['-x', '-C', dir], { input: tar });
    if (result.status !== 0) throw new Error(`tar extract failed for ${ref}`);
  } else {
    for (const entry of docSet) {
      cpSync(path.join(repoRoot, entry), path.join(dir, entry), { recursive: true });
    }
  }
  return dir;
}

function prompt(question) {
  return (
    'You are answering strictly from the documentation in the current directory — ' +
    'treat it as the entire repository and do not consult anything else. ' +
    'Read whatever files you need, then answer concisely.\n\n' +
    `Question: ${question}`
  );
}

function collectWithClaudeCli(task, stagedDir, model) {
  const result = spawnSync(
    'claude',
    ['-p', prompt(task.question), '--model', model, '--output-format', 'json', '--max-turns', '15'],
    { cwd: stagedDir, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0 && !result.stdout) {
    throw new Error(`claude CLI failed for ${task.id}: ${result.stderr?.slice(0, 300)}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (parsed.is_error) throw new Error(`claude CLI error for ${task.id}: ${parsed.result}`);
  return parsed.result;
}

export function grade(task, answer) {
  const missing = task.mustMatch.filter((re) => !new RegExp(re, 'i').test(answer ?? ''));
  const banned = (task.mustNotMatch ?? []).filter((re) => new RegExp(re, 'i').test(answer ?? ''));
  return { pass: missing.length === 0 && banned.length === 0, missing, banned };
}

export function score(benchmark, answers) {
  const perTask = benchmark.tasks.map((task) => {
    const answer = answers[task.id] ?? null;
    const graded = grade(task, answer);
    return { id: task.id, split: task.split, pass: graded.pass, missing: graded.missing, banned: graded.banned, answer };
  });
  const rate = (split) => {
    const subset = perTask.filter((t) => !split || t.split === split);
    // Fail fast rather than emit NaN: a result file with a hollow split would
    // silently corrupt every later comparison.
    if (subset.length === 0) {
      throw new Error(`benchmark has no ${split ?? ''} tasks — a score over zero tasks is meaningless`);
    }
    return subset.filter((t) => t.pass).length / subset.length;
  };
  return { perTask, scores: { overall: rate(null), train: rate('train'), validation: rate('validation') } };
}

function main() {
  const args = parseArgs(process.argv);
  const benchmark = JSON.parse(readFileSync(path.join(here, 'benchmark.json'), 'utf8'));

  let answers;
  let stagedDir = null;
  if (args.answers) {
    answers = JSON.parse(readFileSync(args.answers, 'utf8'));
  } else {
    stagedDir = stageDocs(benchmark.docSet, args.ref);
    if (args.stageOnly) {
      console.log(stagedDir);
      return;
    }
    answers = {};
    for (const task of benchmark.tasks) {
      process.stderr.write(`collecting ${task.id}…\n`);
      answers[task.id] = collectWithClaudeCli(task, stagedDir, args.model);
    }
  }

  const result = {
    ref: args.ref ?? 'working-tree',
    model: args.answers ? 'external' : args.model,
    ...score(benchmark, answers),
  };

  const summary =
    `docs-eval ${result.ref}: overall ${(result.scores.overall * 100).toFixed(0)}% ` +
    `(train ${(result.scores.train * 100).toFixed(0)}%, validation ${(result.scores.validation * 100).toFixed(0)}%)`;
  for (const t of result.perTask) {
    console.log(`${t.pass ? 'PASS' : 'FAIL'} [${t.split}] ${t.id}${t.pass ? '' : ` — missing ${t.missing.join(', ')}`}`);
  }
  console.log(summary);
  if (args.out) writeFileSync(path.resolve(args.out), JSON.stringify(result, null, 2) + '\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
