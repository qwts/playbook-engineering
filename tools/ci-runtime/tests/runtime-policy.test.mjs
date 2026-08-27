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

test('a bounded envelope whose worst case exceeds the remaining job budget is rejected', () => {
  // The Overlook E2E shape: install caps of 900s x 2 attempts cannot fit the
  // job budget left after a 30-minute bounded test step in a 45-minute job.
  const findings = inspectWorkflow(`name: CI
jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - name: Install browsers
        uses: qwts/playbook-engineering/.github/actions/bounded-command@4e70c773155c2c804e52a487352627010bea1897
        with:
          task: Install browsers
          executable: npx
          arguments-json: '["playwright", "install"]'
          timeout-seconds: '900'
          attempts: '2'
          retry-delay-seconds: '5'
      - name: Run E2E tests
        timeout-minutes: 30
        run: node run-e2e.mjs
`);
  assert.equal(findings.length, 1);
  assert.match(
    findings[0].message,
    /runner job e2e bounded steps can exceed the job budget: worst case 3625s plus 60s headroom > timeout-minutes 45 \(2700s\)/u,
  );
});

test('a bounded envelope that fits inside the job budget with headroom passes', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  post-merge:
    runs-on: ubuntu-latest
    timeout-minutes: 12
    concurrency:
      group: \${{ github.event_name == 'pull_request' && 'ci-install' || format('ci-install-{0}', github.run_id) }}
      cancel-in-progress: false
    steps:
      - name: Seed dependency cache
        uses: ./.github/actions/bounded-dependency-install
        with:
          ecosystem: npm
          timeout-seconds: '300'
          attempts: '2'
          retry-delay-seconds: '5'
          termination-grace-seconds: '10'
`);
  assert.deepEqual(findings, []);
});

test('envelope worst case includes default attempts and termination grace', () => {
  const workflow = (minutes) => `name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: ${minutes}
    steps:
      - uses: ./.github/actions/bounded-command
        with:
          timeout-seconds: '300'
`;
  // 1 x (300 + 10) + 60 headroom = 370s: over a 6-minute job, inside 7 minutes.
  assert.equal(inspectWorkflow(workflow(6)).length, 1);
  assert.deepEqual(inspectWorkflow(workflow(7)), []);
});

test('an envelope with an expression input fails closed', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ./.github/actions/bounded-command
        with:
          timeout-seconds: \${{ inputs.deadline }}
          attempts: '2'
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /bounded envelope needs literal integer timeout-seconds/u);
});

test('an envelope without timeout-seconds fails closed', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ./.github/actions/bounded-command
        with:
          attempts: '2'
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /bounded envelope needs literal integer timeout-seconds/u);
});

test('a non-literal sibling step timeout blocks envelope arithmetic', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ./.github/actions/bounded-command
        with:
          timeout-seconds: '60'
      - name: Test
        timeout-minutes: \${{ inputs.test-minutes }}
        run: npm test
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /bounded-step arithmetic needs a literal step timeout-minutes/u);
});

test('step timeouts in jobs without bounded envelopes stay out of scope', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Test
        timeout-minutes: \${{ inputs.test-minutes }}
        run: npm test
`);
  assert.deepEqual(findings, []);
});

test('a version comment on the action pin does not hide the envelope', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 6
    steps:
      - uses: qwts/playbook-engineering/.github/actions/bounded-command@4e70c773155c2c804e52a487352627010bea1897 # v1
        with:
          timeout-seconds: '300'
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /bounded steps can exceed the job budget/u);
});

test('findings point at the envelope line even after blank and comment lines', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 6
    steps:
      - name: Install

        # blank and comment lines must not shift the reported line
        uses: ./.github/actions/bounded-command
        with:
          timeout-seconds: '300'
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /bounded steps can exceed the job budget/u);
  assert.equal(findings[0].line, 10);
});

test('a timeout-minutes input of another action is not a step bound', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 11
    steps:
      - uses: ./.github/actions/bounded-command
        with:
          timeout-seconds: '300'
      - uses: some/other-action@v1
        with:
          timeout-minutes: '600'
`);
  assert.deepEqual(findings, []);
});

const installJob = (concurrency) => `name: CI
jobs:
  full:
    runs-on: ubuntu-latest
    timeout-minutes: 30
${concurrency}    steps:
      - name: Install locked dependencies
        uses: ./.github/actions/bounded-dependency-install
        with:
          ecosystem: npm
          timeout-seconds: '300'
          attempts: '2'
          retry-delay-seconds: '5'
`;

const BACKPRESSURE = `    concurrency:
      group: \${{ github.event_name == 'pull_request' && 'ci-install-full' || format('ci-install-full-{0}', github.run_id) }}
      cancel-in-progress: false
`;

test('an install lane without a backpressure group is rejected', () => {
  const findings = inspectWorkflow(installJob(''));
  assert.deepEqual(findings.map(({ message }) => message), [
    'runner job full installs dependencies without a backpressure concurrency group',
  ]);
});

test('the reviewed backpressure shape passes', () => {
  assert.deepEqual(inspectWorkflow(installJob(BACKPRESSURE)), []);
});

test('a constant backpressure group would supersede evidence lanes', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: ci-install-full
      cancel-in-progress: false
`));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /unique per run \(github\.run_id\)/u);
  // The finding anchors at the group expression, not at the job or the step.
  assert.equal(findings[0].line, 7);
});

test('a comment cannot supply the per-run escape', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: ci-install-full # \${{ github.run_id }}
      cancel-in-progress: false
`));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /unique per run \(github\.run_id\)/u);
});

test('a quoted constant naming run_id is still a constant group', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: 'ci-install-full-github.run_id'
      cancel-in-progress: false
`));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /unique per run \(github\.run_id\)/u);
});

test('a string literal inside the expression is not an evaluated escape', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: \${{ format('ci-install-full-{0}', 'github.run_id') }}
      cancel-in-progress: false
`));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /unique per run \(github\.run_id\)/u);
});

test('a literal whose neighbour is not a quote is still a literal', () => {
  for (const group of [
    `\${{ 'ci-install-full-github.run_id' }}`,
    `\${{ format('ci-install-full-{0}', 'literal/github.run_id') }}`,
  ]) {
    const findings = inspectWorkflow(installJob(`    concurrency:
      group: ${group}
      cancel-in-progress: false
`));
    assert.equal(findings.length, 1, group);
    assert.match(findings[0].message, /unique per run \(github\.run_id\)/u);
  }
});

test('an embedded quote inside a literal does not hide the escape', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: \${{ format('it''s-full-{0}', github.run_id) }}
      cancel-in-progress: false
`));
  assert.deepEqual(findings, []);
});

test('an unbalanced expression quote cannot be verified', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: \${{ format('ci-install-full-{0}, github.run_id) }}
      cancel-in-progress: false
`));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /unique per run \(github\.run_id\)/u);
});

test('YAML quote escaping is decoded before expression literals are masked', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: '\${{ ''literal/github.run_id'' }}'
      cancel-in-progress: false
`));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /unique per run \(github\.run_id\)/u);
});

test('a legitimately escaped single-quoted scalar keeps its escape', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: '\${{ format(''ci-install-full-{0}'', github.run_id) }}'
      cancel-in-progress: false
`));
  assert.deepEqual(findings, []);
});

test('an unterminated or trailing-junk quoted scalar cannot be verified', () => {
  for (const group of [
    `'\${{ format('ci-install-full-{0}', github.run_id) }}`,
    `'\${{ github.run_id }}' extra`,
  ]) {
    const findings = inspectWorkflow(installJob(`    concurrency:
      group: ${group}
      cancel-in-progress: false
`));
    assert.equal(findings.length, 1, group);
    assert.match(findings[0].message, /unique per run \(github\.run_id\)/u);
  }
});

test('a double-quoted scalar with backslash escapes fails closed', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: "\${{ format('ci-\\\\{0}', github.run_id) }}"
      cancel-in-progress: false
`));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /unique per run \(github\.run_id\)/u);
});

test('a quoted expression carries the escape', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: "\${{ format('ci-install-full-{0}', github.run_id) }}"
      cancel-in-progress: false
`));
  assert.deepEqual(findings, []);
});

test('backpressure must not cancel a running install', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: \${{ format('ci-install-full-{0}', github.run_id) }}
      cancel-in-progress: true
`));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /literal cancel-in-progress: false/u);
});

test('an expression cancel-in-progress fails closed on an install lane', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: \${{ format('ci-install-full-{0}', github.run_id) }}
      cancel-in-progress: \${{ github.event_name != 'push' }}
`));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /literal cancel-in-progress: false/u);
});

test('the concurrency string shorthand cannot express the install contract', () => {
  const findings = inspectWorkflow(installJob(`    concurrency: ci-install-full
`));
  assert.deepEqual(findings.map(({ message }) => message), [
    'runner job full backpressure needs an explicit concurrency group and cancel-in-progress',
  ]);
});

test('a folded backpressure group is read whole', () => {
  const findings = inspectWorkflow(installJob(`    concurrency:
      group: >-
        \${{ github.event_name == 'pull_request' && 'ci-install-full'
        || format('ci-install-full-{0}', github.run_id) }}
      cancel-in-progress: false
`));
  assert.deepEqual(findings, []);
});

test('backpressure is required of the install action, not of every bounded job', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ./.github/actions/bounded-command
        with:
          timeout-seconds: '300'
`);
  assert.deepEqual(findings, []);
});

test('an unbounded install lane reports both the missing timeout and the missing group', () => {
  const findings = inspectWorkflow(`name: CI
jobs:
  full:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/bounded-dependency-install@0000000000000000000000000000000000000000 # v1
        with:
          timeout-seconds: '300'
`);
  assert.deepEqual(findings.map(({ message }) => message), [
    'runner job full installs dependencies without a backpressure concurrency group',
    'runner job full has no timeout-minutes',
  ]);
});

test('--root requires a following path', () => {
  assert.throws(() => parseRootArgument(['--root']), /--root requires a path/u);
  assert.equal(parseRootArgument([], { cwd: '/workspace' }), '/workspace');
});
