import test from 'node:test';
import assert from 'node:assert/strict';

import { inspectWorkflow, parseRootArgument } from '../runtime-policy.mjs';

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

test('runner jobs are parsed with valid alternate indentation and quoted identifiers', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
    "build-job":
      runs-on: ubuntu-latest
      steps: []
`);
  assert.deepEqual(findings.map(({ message }) => message), [
    'runner job build-job has no timeout-minutes',
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

test('the timeout deadline operand is distinct from --kill-after', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  package:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - run: |
          # ci-runtime: exception owner=release max=10s review=tool-change reason=bootstrap owns cleanup
          timeout --kill-after=10s 600 npm ci
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /raw dependency installer/u);
});

test('unitless GNU timeout deadlines default to seconds', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  package:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - run: |
          # ci-runtime: exception owner=release max=10m review=tool-change reason=bootstrap owns cleanup
          timeout --signal TERM --kill-after 10s 600 npm ci
`);
  assert.deepEqual(findings, []);
});

test('a zero GNU timeout deadline cannot waive an installer boundary', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  package:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - run: |
          # ci-runtime: exception owner=release max=10m review=tool-change reason=bootstrap owns cleanup
          timeout 0 npm ci
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /raw dependency installer/u);
});

test('installer checks reconstruct shell backslash continuations', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - run: |
          npm \\
            ci
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /raw dependency installer/u);
});

test('a timeout for an earlier shell command does not bound a later installer', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  package:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - run: |
          # ci-runtime: exception owner=release max=10m review=tool-change reason=bootstrap owns cleanup
          timeout 30s curl https://example.invalid/tool && npm ci
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /raw dependency installer/u);
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
    assert.match(findings[0].message, /must be a literal integer between 1 and 360/u);
  }
});

test('--root requires a following path', () => {
  assert.throws(() => parseRootArgument(['--root']), /--root requires a path/u);
  assert.equal(parseRootArgument([], { cwd: '/workspace' }), '/workspace');
});
