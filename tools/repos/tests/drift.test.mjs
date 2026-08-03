import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codeqlSetupFrom } from '../drift.mjs';
import { plan } from '../lib/reconcile-plan.mjs';

const CODEQL_CHECK = 'code scanning (CodeQL, own workflow)';

const advanced = (key = '.github/workflows/ci.yml:analyze') => ({ analysis_key: key });
const defaultSetup = () => ({ analysis_key: 'dynamic/github-code-scanning/codeql:analyze' });

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
  assert.equal(codeqlSetupFrom([{ analysis_key: 42 }]), null);
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
  assert.match(out.human[0], /ci\.yml/);
  assert.match(out.human[0], /security-events/);
  assert.doesNotMatch(out.human[0], /no reconcile lane/);
});

test('a conformant repo produces no code-scanning action', () => {
  const out = plan({ name: 'quorum', status: 'active', failed: [] });
  assert.deepEqual(out.human, []);
  assert.deepEqual(out.seeds, []);
  assert.deepEqual(out.settings, []);
});
