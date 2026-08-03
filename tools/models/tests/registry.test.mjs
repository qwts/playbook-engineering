import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHINESE_ACCESS,
  PHASES,
  TIERS,
  VENDOR_GROUPS,
  loadRegistry,
  routingFor,
  staleness,
  validateRegistry,
} from '../registry.mjs';
import { refreshTaskBody } from '../refresh-task.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const clone = (o) => JSON.parse(JSON.stringify(o));
const base = () => loadRegistry(ROOT);

test('the committed registry is valid', () => {
  assert.deepEqual(validateRegistry(base()), []);
});

test('an unverified slot may not carry a model name', () => {
  // The failure this prevents: a slot nobody confirmed that still reads as a
  // recommendation. A plausible model name is indistinguishable from a correct
  // one to everyone downstream, so the schema forbids the combination outright.
  const r = clone(base());
  r.tiers.T1.vendors.openai.plan = { model: 'some-model', reasoning: 'high', status: 'unverified' };
  assert.match(validateRegistry(r).join('\n'), /unverified and must leave model and reasoning null/);
});

test('a verified or seeded slot must actually name a model', () => {
  const r = clone(base());
  r.tiers.T2.vendors.anthropic.build = { model: null, reasoning: 'medium', status: 'verified' };
  assert.match(validateRegistry(r).join('\n'), /claims status verified but names no model/);
});

test('the Chinese-access policy cannot be widened by editing the registry', () => {
  // Access is policy, not availability: reaching a model through an IDE we
  // already run is a different posture from installing the vendor's product. A
  // refresh reading vendor docs would otherwise find a direct API route and
  // "helpfully" adopt it, so both the policy list and each entry are pinned.
  const widened = clone(base());
  widened.policy.chinese_models.access = ['cursor', 'devin', 'api'];
  assert.match(validateRegistry(widened).join('\n'), /widening it is a human decision/);

  const smuggled = clone(base());
  smuggled.tiers.T1.vendors.chinese.available_in = ['cursor', 'devin', 'direct-api'];
  assert.match(validateRegistry(smuggled).join('\n'), /may not include direct-api/);
});

test('every tier and vendor group is present, and a missing one fails', () => {
  const r = clone(base());
  delete r.tiers.T3.vendors.ide_native;
  assert.match(validateRegistry(r).join('\n'), /T3 is missing vendor group ide_native/);

  const noTier = clone(base());
  delete noTier.tiers.T2;
  assert.match(validateRegistry(noTier).join('\n'), /tier T2 is missing/);
});

test('verified_at is a date or explicitly null, never a loose string', () => {
  const r = clone(base());
  r.verified_at = 'recently';
  assert.match(validateRegistry(r).join('\n'), /verified_at must be null or an ISO date/);
  r.verified_at = '2026-08-03';
  assert.deepEqual(validateRegistry(r), []);
});

test('unverified slots are rendered as unknown, not omitted', () => {
  // A silently dropped row reads as "no recommendation exists here". A visible
  // "unverified" is a gap the issue author will actually mention.
  const rows = routingFor(base(), 'T1');
  assert.equal(rows.length, VENDOR_GROUPS.length);
  const openai = rows.find((r) => r.vendor === 'openai');
  assert.match(openai.plan, /unverified — do not guess/);
  const anthropic = rows.find((r) => r.vendor === 'anthropic');
  assert.match(anthropic.plan, /reasoning high/);
  assert.match(anthropic.plan, /provisional/, 'a hand-seeded slot must not read as confirmed');
});

test('staleness counts every slot, so nothing hides', () => {
  const s = staleness(base());
  assert.equal(s.seeded.length + s.unverified.length, TIERS.length * VENDOR_GROUPS.length * PHASES.length);
  assert.equal(s.verified_at, null, 'no refresh run has confirmed the seeded registry yet');
});

test('the refresh task names the sources and the slots that need work', () => {
  const body = refreshTaskBody(base(), 'GLM shipped a new model');
  assert.match(body, /GLM shipped a new model/);
  assert.match(body, /platform\.openai\.com/);
  assert.match(body, /no source pinned yet/, 'a missing source must be called out, not silently skipped');
  assert.match(body, /18 slot\(s\) unverified/);
  assert.match(body, /Advance `verified_at` only on a successful read/);
  assert.match(body, new RegExp(CHINESE_ACCESS.join('|')));
});

test('the refresh workflow is manual, owner-gated, and fails rather than skips', () => {
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'model-registry-refresh.yml'), 'utf8');
  assert.match(wf, /on:\n\s+workflow_dispatch:/);
  assert.doesNotMatch(wf, /schedule:/, 'a cron run that reaches nothing is indistinguishable from no change');
  // triggering_actor, not actor: they diverge on a re-run, and guarding the
  // wrong one lets a re-run launder an unauthorized trigger.
  assert.match(wf, /github\.triggering_actor != 'qwts'/);
  assert.doesNotMatch(wf, /github\.actor != /);
  // A job-level `if:` would mark the job skipped, which renders neutral and
  // leaves an unauthorized attempt with no visible trace.
  assert.match(wf, /if: github\.triggering_actor != 'qwts'\n\s+run: \|/);
  assert.match(wf, /exit 1/);
});
