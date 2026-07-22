import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { grade, score } from '../run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const compareCli = path.join(here, '..', 'compare.mjs');

const task = { id: 't', split: 'train', mustMatch: ['alpha', '(beta|gamma)'] };

test('grade requires every mustMatch regex, case-insensitively', () => {
  assert.equal(grade(task, 'Alpha and BETA are both here').pass, true);
  assert.deepEqual(grade(task, 'only alpha').missing, ['(beta|gamma)']);
  assert.equal(grade(task, null).pass, false);
});

test('grade rejects mustNotMatch hits', () => {
  const t = { ...task, mustNotMatch: ['forbidden'] };
  assert.equal(grade(t, 'alpha beta forbidden').pass, false);
  assert.equal(grade(t, 'alpha beta fine').pass, true);
});

test('score reports splits separately', () => {
  const benchmark = {
    tasks: [
      { id: 'a', split: 'train', mustMatch: ['yes'] },
      { id: 'b', split: 'validation', mustMatch: ['yes'] },
    ],
  };
  const { scores } = score(benchmark, { a: 'yes', b: 'no' });
  assert.equal(scores.train, 1);
  assert.equal(scores.validation, 0);
  assert.equal(scores.overall, 0.5);
});

function runCompare(baselineScores, candidateScores) {
  const dir = mkdtempSync(path.join(tmpdir(), 'docs-eval-test-'));
  const mk = (name, scores) => {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify({ ref: name, scores, perTask: [] }));
    return file;
  };
  try {
    const out = execFileSync(
      process.execPath,
      [compareCli, mk('baseline.json', baselineScores), mk('candidate.json', candidateScores)],
      { encoding: 'utf8' },
    );
    return { accepted: true, out };
  } catch (error) {
    return { accepted: false, out: `${error.stdout}` };
  }
}

test('compare accepts only strict held-out improvement', () => {
  const base = { train: 0.6, validation: 0.5 };
  assert.equal(runCompare(base, { train: 0.6, validation: 0.8 }).accepted, true);
  // Validation improvement is the evidence, even if train slipped.
  assert.equal(runCompare(base, { train: 0.4, validation: 0.8 }).accepted, true);
  // Validation regression rejected even when train improves.
  assert.equal(runCompare(base, { train: 1.0, validation: 0.4 }).accepted, false);
  // No movement anywhere: not defended by evidence.
  assert.equal(runCompare(base, { train: 0.6, validation: 0.5 }).accepted, false);
  // Train-only improvement with validation flat is overfitting — rejected.
  const trainOnly = runCompare(base, { train: 0.8, validation: 0.5 });
  assert.equal(trainOnly.accepted, false);
  assert.match(trainOnly.out, /overfit/i);
});

test('score fails fast on an empty split instead of emitting NaN', () => {
  assert.throws(
    () => score({ tasks: [{ id: 'a', split: 'train', mustMatch: ['x'] }] }, { a: 'x' }),
    /no validation tasks/,
  );
});
