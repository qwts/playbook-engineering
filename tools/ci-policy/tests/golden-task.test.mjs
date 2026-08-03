import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const directory = new URL('../golden-tasks/', import.meta.url);

// Golden tasks are agent evaluation inputs, so this asserts the shape a harness relies on.
// Their wording is reviewed in the PR rather than pinned by a regex.
test('every golden task is a well-formed evaluation input', () => {
  const files = readdirSync(directory).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0, 'no golden tasks are defined');

  for (const file of files) {
    const task = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
    assert.equal(`${task.id}.json`, file, `${file} must be named for its id`);
    for (const field of ['title', 'prompt']) {
      assert.ok(task[field]?.length > 0, `${file} is missing ${field}`);
    }
    for (const field of ['requiredOutcomes', 'forbiddenOutcomes']) {
      assert.ok(task[field]?.length > 0, `${file} is missing ${field}`);
      assert.ok(task[field].every((outcome) => outcome.length > 0), `${file} has an empty ${field} entry`);
    }
    assert.match(task.regressionEvidence.pullRequest, /^[\w.-]+\/[\w.-]+#\d+$/u);
    assert.match(task.regressionEvidence.commit, /^[0-9a-f]{40}$/u);
  }
});
