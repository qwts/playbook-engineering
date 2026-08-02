import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Overlook generated-release golden task preserves the fleet invariant', () => {
  const task = JSON.parse(
    readFileSync(
      new URL('../golden-tasks/overlook-generated-release-projection.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(task.regressionEvidence.pullRequest, 'qwts/overlook#870');
  assert.match(task.regressionEvidence.commit, /^260fa140[0-9a-f]{32}$/u);
  const required = task.requiredOutcomes.join('\n');
  const forbidden = task.forbiddenOutcomes.join('\n');
  for (const expectation of [
    /repository-specific release-input contract/u,
    /reviewed repository, base, head, and author identity/u,
    /zero semantic releases/u,
    /exact-SHA CI/u,
    /both actor fields/u,
  ]) {
    assert.match(required, expectation);
  }
  assert.match(forbidden, /universal PR invariant/u);
  assert.match(forbidden, /branch-only exception/u);
  assert.match(forbidden, /empty Changeset marker/u);
});
