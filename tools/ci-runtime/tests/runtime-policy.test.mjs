import test from 'node:test';
import assert from 'node:assert/strict';

import { inspectWorkflow } from '../runtime-policy.mjs';

test('runner jobs require a literal whole-job timeout', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
  assert.deepEqual(findings.map(({ message }) => message), [
    'runner job build has no timeout-minutes',
  ]);
});

test('raw dependency installers are rejected even when the job is bounded', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Install
        run: npm ci
`);
  assert.match(findings[0].message, /raw dependency installer/u);
});

test('reusable jobs defer their timeout to the called workflow', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  docs:
    uses: ./.github/workflows/docs.yml
`);
  assert.deepEqual(findings, []);
});

test('a reviewed bounded exception must carry owner, maximum, review trigger, and reason', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  package:
    runs-on: macos-latest
    timeout-minutes: 60
    steps:
      - name: Install release tool
        run: |
          # ci-runtime: exception owner=release max=10m review=tool-change reason=upstream installer owns process cleanup
          timeout --kill-after=10s 600s brew install release-tool
`);
  assert.deepEqual(findings, []);
});

test('an exception annotation cannot waive a raw unbounded installer', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  package:
    runs-on: macos-latest
    timeout-minutes: 60
    steps:
      - run: |
          # ci-runtime: exception owner=release max=10m review=tool-change reason=upstream installer owns cleanup
          brew install release-tool
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /raw dependency installer/u);
});

test('an exception cannot claim a maximum shorter than its enforced timeout', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  package:
    runs-on: macos-latest
    timeout-minutes: 60
    steps:
      - run: |
          # ci-runtime: exception owner=release max=5m review=tool-change reason=upstream installer owns cleanup
          timeout --kill-after=10s 600s brew install release-tool
`);
  assert.equal(findings.length, 1);
});

test('timeout expressions and values beyond GitHub limits fail closed', () => {
  for (const timeout of ['${{ inputs.timeout }}', '361']) {
    const findings = inspectWorkflow(`name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: ${timeout}
    steps: []
`);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /timeout-minutes/u);
  }
});
