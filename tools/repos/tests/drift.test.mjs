import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codeqlFreshness, codeqlSetupFrom, retiredDriftChecks } from '../drift.mjs';
import { plan, promotionPlan } from '../lib/reconcile-plan.mjs';
import { RETIRED_HARNESS_FILES } from '../lib/baseline-files.mjs';

const CODEQL_CHECK = 'code scanning (CodeQL, own workflow, current)';

const advanced = (key = '.github/workflows/ci.yml:analyze') => ({ analysis_key: key, tool: { name: 'CodeQL' } });
const defaultSetup = () => ({ analysis_key: 'dynamic/github-code-scanning/codeql:analyze', tool: { name: 'CodeQL' } });
const otherTool = (name = 'Semgrep') => ({ analysis_key: '.github/workflows/semgrep.yml:scan', tool: { name } });

test('the setup is read from the marker GitHub stamps on each analysis', () => {
  // Both strings are verbatim from live analyses: playbook-engineering (advanced)
  // and bookmarkit before it went dark (default). The `dynamic/` prefix is
  // GitHub's own default-setup marker; anything else is a workflow path.
  assert.equal(codeqlSetupFrom([advanced()]), 'advanced');
  assert.equal(codeqlSetupFrom([defaultSetup()]), 'default');
  assert.equal(codeqlSetupFrom([advanced('.github/workflows/codeql.yml:analyze')]), 'advanced');
});

test('a repo mid-migration reports advanced, the superset, in either order', () => {
  assert.equal(codeqlSetupFrom([defaultSetup(), advanced()]), 'advanced');
  assert.equal(codeqlSetupFrom([advanced(), defaultSetup()]), 'advanced');
});

test('another scanner uploading SARIF cannot pass as CodeQL', () => {
  // The analyses endpoint returns every tool's uploads. A Semgrep or Trivy run
  // carries an analysis_key that is not GitHub's default-setup marker, so an
  // unfiltered classifier would read it as an advanced CodeQL setup and pass a
  // repo with no CodeQL at all.
  assert.equal(codeqlSetupFrom([otherTool()]), 'none');
  assert.equal(codeqlSetupFrom([otherTool('Trivy'), otherTool('Semgrep')]), 'none');
  // A real CodeQL run alongside other scanners still classifies on CodeQL.
  assert.equal(codeqlSetupFrom([otherTool(), advanced()]), 'advanced');
  assert.equal(codeqlSetupFrom([otherTool(), defaultSetup()]), 'default');
});

test('an analysis whose tool cannot be identified is unknown, not ignored', () => {
  // Dropping unidentifiable entries would silently downgrade a scanning repo to
  // 'none'; returning null makes it non-conformant *and* visibly unreadable.
  assert.equal(codeqlSetupFrom([{ analysis_key: '.github/workflows/ci.yml:analyze' }]), null);
  assert.equal(codeqlSetupFrom([{ ...advanced(), tool: { name: 42 } }]), null);
  assert.equal(codeqlSetupFrom([advanced(), { analysis_key: 'x' }]), null);
});

test('unknown is never collapsed into a guessed answer', () => {
  // `api` returns null for both 403 and 404, and a governance gate must not turn
  // "could not read" into "configured". Everything unreadable stays null; only a
  // genuinely empty list is 'none'.
  assert.equal(codeqlSetupFrom([]), 'none');
  assert.equal(codeqlSetupFrom(null), null);
  assert.equal(codeqlSetupFrom(undefined), null);
  assert.equal(codeqlSetupFrom('not-an-array'), null);
  assert.equal(codeqlSetupFrom({ analyses: [advanced()] }), null);
  assert.equal(codeqlSetupFrom([{}]), null);
  assert.equal(codeqlSetupFrom([{ analysis_key: 42, tool: { name: 'CodeQL' } }]), null);
});

test('only advanced satisfies the gate — default setup is drift, not a pass', () => {
  // Default setup runs as the unselectable github-advanced-security[bot] actor,
  // which sits outside the repository Actions Policy. A repo scanning via default
  // setup is being scanned but is not conformant, and the gate must say so.
  const conformant = (analyses) => codeqlSetupFrom(analyses) === 'advanced';
  assert.equal(conformant([advanced()]), true);
  assert.equal(conformant([defaultSetup()]), false);
  assert.equal(conformant([]), false);
  assert.equal(conformant(null), false);
});

test('the reconciler routes code scanning to the human lane with the actual fix', () => {
  // Not a seed: the workflow is `workflow_call` only, so copying the file in does
  // nothing until the repo's own ci.yml invokes it — and ci.yml is per-repo, so
  // no automated lane can safely edit it. The plan must carry that instruction
  // rather than the generic "no reconcile lane" fallback.
  const out = plan({ name: 'bookmarkit', status: 'active', failed: [CODEQL_CHECK] });
  assert.equal(out.settings.length, 0);
  assert.equal(out.seeds.length, 0, 'a file seed would land a workflow nothing calls');
  assert.equal(out.human.length, 1);
  assert.match(out.human[0], /codeql\.yml/);
  assert.match(out.human[0], /stopped|predates/, 'the message must cover both ways this check fails');
  assert.match(out.human[0], /ci\.yml/);
  assert.match(out.human[0], /security-events/);
  assert.doesNotMatch(out.human[0], /no reconcile lane/);
});

test('a workflow that stopped running is drift, however clean its history', () => {
  // The failure codex found: GitHub keeps historical analyses forever, so a repo
  // whose workflow is deleted or disabled keeps classifying as 'advanced' off
  // runs from weeks ago. That is the same went-dark failure this check exists to
  // catch, only slower to notice.
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-08-03T20:00:00Z');
  const old = [{ ...advanced(), commit_sha: 'aaa', created_at: '2026-07-01T00:00:00Z' }];

  assert.equal(
    codeqlFreshness({ analyses: old, headSha: 'bbb', headCommittedAt: '2026-07-20T00:00:00Z', now }),
    'stale',
  );
  // Same analysis, still the head commit — nothing has moved, so nothing is stale.
  assert.equal(
    codeqlFreshness({ analyses: old, headSha: 'aaa', headCommittedAt: '2026-07-01T00:00:00Z', now }),
    'current',
  );
  // A merge that landed minutes ago must not read as drift while CI is running.
  assert.equal(
    codeqlFreshness({ analyses: old, headSha: 'bbb', headCommittedAt: new Date(now - day / 24).toISOString(), now }),
    'current',
  );
});

test('freshness picks the newest analysis rather than trusting list order', () => {
  const now = Date.parse('2026-08-03T20:00:00Z');
  const outOfOrder = [
    { ...advanced(), commit_sha: 'old', created_at: '2026-07-01T00:00:00Z' },
    { ...advanced(), commit_sha: 'head', created_at: '2026-08-03T19:00:00Z' },
  ];
  assert.equal(codeqlFreshness({ analyses: outOfOrder, headSha: 'head', headCommittedAt: '2026-08-03T18:00:00Z', now }), 'current');
});

test('freshness is unknown rather than guessed when inputs are unusable', () => {
  const now = Date.parse('2026-08-03T20:00:00Z');
  const a = [{ ...advanced(), commit_sha: 'aaa', created_at: '2026-07-01T00:00:00Z' }];
  assert.equal(codeqlFreshness({ analyses: a, headSha: undefined, headCommittedAt: 'x', now }), null);
  assert.equal(codeqlFreshness({ analyses: null, headSha: 'bbb', headCommittedAt: 'x', now }), null);
  assert.equal(codeqlFreshness({ analyses: [otherTool()], headSha: 'bbb', headCommittedAt: 'x', now }), null);
  assert.equal(codeqlFreshness({ analyses: a, headSha: 'bbb', headCommittedAt: 'not-a-date', now }), null);
});

test('a conformant repo produces no code-scanning action', () => {
  const out = plan({ name: 'quorum', status: 'active', failed: [] });
  assert.deepEqual(out.human, []);
  assert.deepEqual(out.seeds, []);
  assert.deepEqual(out.settings, []);
});

test('retired-file drift is audited on active repos only', () => {
  // The sync opens retraction PRs solely for active entries, so auditing an
  // onboarding repo on retired files would deadlock --promote: promotion
  // refuses any failed check, and no automated lane could clear this one. The
  // promotion itself pushes governance/repos.json — a sync trigger path — so
  // the retraction PR opens the moment the repo turns active.
  assert.deepEqual(retiredDriftChecks({ status: 'active' }), RETIRED_HARNESS_FILES);
  assert.deepEqual(retiredDriftChecks({ status: 'onboarding' }), []);
  assert.deepEqual(
    retiredDriftChecks({ status: 'active', codexSync: { exclude: ['.codex/scripts/setup.sh'] } }),
    RETIRED_HARNESS_FILES.filter((path) => path !== '.codex/scripts/setup.sh'),
  );
  const stranded = promotionPlan({
    name: 'newcomer',
    status: 'onboarding',
    failed: retiredDriftChecks({ status: 'onboarding' }),
  });
  assert.equal(stranded.eligible, true, 'a stranded retired file never blocks promotion');
});
