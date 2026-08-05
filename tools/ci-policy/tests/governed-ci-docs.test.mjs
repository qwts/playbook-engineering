import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

test('all Changesets lanes share one semantic release-count contract', () => {
  const policy = read('docs/reference/ci-execution-policy.md');
  const rollout = read('docs/reference/governed-ci-rollout.md');
  const release = read('docs/sop/release-and-versioning.md');
  const action = read('.github/actions/changeset-release-count/action.yml');
  const counter = read('.github/actions/changeset-release-count/semantic-release-count.mjs');
  const contract = `${policy}\n${rollout}`;

  for (const lane of ['Version planning', 'tag planning', 'release verification']) {
    assert.match(contract, new RegExp(lane.replace(' ', '\\s+'), 'iu'));
  }
  assert.match(contract, /semantic `releases\.length`/u);
  assert.match(contract, /Empty or frontmatter-only\s+governance changesets/u);
  assert.match(contract, /a positive count fails\s+closed/u);
  assert.match(release, /may substitute `find \.changeset`, a file count/u);
  assert.match(action, /git fetch --no-tags --depth=1 origin/u);
  assert.match(counter, /'changeset', 'status', '--output'/u);
  assert.match(counter, /status\.releases\.length/u);
  assert.doesNotMatch(action, /find \.changeset|\.changeset\/\*\.md/u);
});

// The wording of the release-lifecycle policy is reviewed in the PR. What is pinned here is
// that exactly one document owns it and that the others point at it instead of restating it.
test('one document owns the generated-projection contract', () => {
  const policy = read('docs/reference/ci-execution-policy.md');
  const consumers = ['governed-ci-rollout', 'governed-ci-release-lifecycle-fleet']
    .map((name) => read(`docs/reference/${name}.md`))
    .concat(read('docs/decisions/ENG-0004-centralize-shared-cicd.md'));

  assert.match(policy, /`release-lifecycles\.json`/u);
  assert.match(policy, /`pull-requests: read`/u);
  assert.match(policy, /both `github\.actor` and `github\.triggering_actor`/u);
  assert.match(policy, /never required to retain the\s+Changesets it consumed/u);

  for (const consumer of consumers) {
    assert.match(consumer, /ci-execution-policy\.md/u, 'each consumer links the owning policy');
    assert.doesNotMatch(
      consumer,
      /base ref, head ref, canonical head repository, and author/u,
      'the projection identity tuple is restated outside the owning policy',
    );
  }
});

test('the release lifecycle catalog covers the governed manifest exactly once', () => {
  const manifest = JSON.parse(read('governance/repos.json'));
  const catalog = JSON.parse(read('governance/release-lifecycles.json'));
  const fleet = read('docs/reference/governed-ci-release-lifecycle-fleet.md');
  const governed = manifest.repos.filter((entry) => ['active', 'onboarding'].includes(entry.status));

  assert.equal(catalog.repositories.length, governed.length);
  for (const repo of governed) {
    const entries = catalog.repositories.filter((entry) => entry.repository === `qwts/${repo.name}`);
    assert.equal(entries.length, 1, `${repo.name} must appear in the catalog exactly once`);
    const [{ metadataSystem, generatedProjection }] = entries;
    assert.ok(fleet.includes(`\`${repo.name}\``), `${repo.name} has no published disposition`);
    if (metadataSystem === 'none') {
      assert.equal(generatedProjection, null, `${repo.name} has no release system but names a projection`);
      continue;
    }
    for (const field of ['baseRef', 'headRef', 'author']) {
      assert.ok(generatedProjection?.[field], `${repo.name} projection identity is missing ${field}`);
    }
  }
});

test('user-owned fallback preserves strict exact-SHA evidence and merge methods', () => {
  const policy = read('docs/reference/ci-execution-policy.md');
  const rollout = read('docs/reference/governed-ci-rollout.md');
  const workflow = read('.github/workflows/ci.yml');
  const contract = `${policy}\n${rollout}`;

  assert.match(contract, /limits merge queues to organization-owned repositories/u);
  assert.match(contract, /governed\s+`chores-dumb\[bot\]` ready-branch updater/u);
  assert.match(contract, /updater changes\s+receive a fresh complete suite/u);
  assert.match(contract, /tree equivalence, and an earlier\s+`main` success do not count/u);
  assert.match(contract, /Do not change enabled merge methods/u);
  assert.match(rollout, /organization-owned repositories prefer GitHub's native merge queue/u);
  assert.match(workflow, /head_sha=\$GITHUB_SHA/u);
  assert.match(workflow, /needs\.merge-evidence\.outputs\.validated != 'true'/u);
});

test('required contexts are bound to their real publishers', () => {
  const policy = read('docs/reference/ci-execution-policy.md');
  const rollout = read('docs/reference/governed-ci-rollout.md');
  const contract = `${policy}\n${rollout}`;

  assert.match(contract, /`CodeQL` \| GitHub Advanced Security App/u);
  assert.match(contract, /`CI` \| GitHub Actions/u);
  assert.match(contract, /`chores-dumb\[bot\]` initiates governed writes but publishes none/u);
  assert.match(contract, /not transient `E2E`/u);
  for (const publisher of ['GitHub Advanced Security App', 'GitHub Actions']) {
    assert.match(rollout, new RegExp(publisher, 'u'));
  }
});

test('every privileged chores-dumb consumer uses the Client ID and private key boundary', () => {
  const policy = read('docs/reference/ci-execution-policy.md');
  const rollout = read('docs/reference/governed-ci-rollout.md');

  for (const consumer of [
    'ready-branch updater',
    'Version packages PR',
    'tag creation',
    'release-recovery dispatch',
    'harness synchronization',
  ]) {
    assert.match(`${policy}\n${rollout}`, new RegExp(consumer, 'u'));
  }
  const contract = `${policy}\n${rollout}`;
  assert.match(contract, /`CHORES_DUMB_CLIENT_ID`/u);
  assert.match(contract, /`CHORES_DUMB_PRIVATE_KEY`/u);
  assert.match(contract, /Do not substitute an App ID variable/u);
  assert.match(contract, /mint again after any wait that could approach one hour/u);
  assert.match(contract, /Never pass App credentials or tokens to third-party actions/u);
  assert.match(contract, /secret merely for actor\s+authorization/u);
});

test('repository settings and concurrency rollout evidence stay explicit', () => {
  const policy = read('docs/reference/ci-execution-policy.md');
  const rollout = read('docs/reference/governed-ci-rollout.md');
  const workflow = read('.github/workflows/ci.yml');

  assert.match(workflow, /format\('pr-\{0\}', github\.event\.pull_request\.number\)/u);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name != 'push' \}\}/u);
  assert.match(`${policy}\n${rollout}`, /policy and reference\s+workflow stay unchanged/u);
  assert.match(rollout, /No\s+deterministic group or expression defect was found/iu);
  for (const setting of [
    'Workflow execution protections',
    'full-commit-SHA pinning',
    'read-only default token',
    'Allow GitHub Actions to create and approve pull requests',
    'CodeQL analysis',
  ]) {
    assert.match(rollout, new RegExp(setting, 'u'));
  }
});

test('dependency remediation preserves traced analysis and packaging exceptions', () => {
  const conventions = read('docs/reference/agent-conventions.md');
  const release = read('docs/sop/release-and-versioning.md');

  assert.match(conventions, /configuration as behavior, not\s+generated cleanup/u);
  assert.match(conventions, /ignored binary, dependency, export, platform command, or\s+packaging input/u);
  assert.match(release, /does not accept a tool's autofix as proof/u);
  assert.match(release, /runs\s+the complete contract suite/u);
});

test('semantic ratchets keep deterministic enforcement separate from advisory model judgment', () => {
  const workflow = read('.github/workflows/semantic-ratchet.yml');
  const policy = read('docs/reference/semantic-ratchets.md');

  assert.match(workflow, /^  workflow_call:$/mu);
  assert.match(workflow, /ref: [0-9a-f]{40}$/mu);
  assert.match(workflow, /OPENAI_BASE_URL: https:\/\/router\.huggingface\.co\/v1/u);
  assert.match(workflow, /OPENAI_API_KEY: \$\{\{ secrets\.HF_TOKEN \}\}/u);
  assert.match(workflow, /context-footprint --base "\$BASE_REF"/u);
  assert.match(workflow, /context-footprint --self-test --json/u);
  assert.match(workflow, /dynamic Hugging Face routing cannot carry pinned calibration evidence/u);
  assert.doesNotMatch(workflow, /--enforce/u);

  assert.match(policy, /Numeric ratchets remain the deterministic merge gate/u);
  assert.match(policy, /No model call belongs in a commit or push hook/u);
  assert.match(policy, /authoritative judge is\s+required only to grant a per-file ceiling exception/u);
  assert.match(policy, /never switch to `pull_request_target`/u);
});
