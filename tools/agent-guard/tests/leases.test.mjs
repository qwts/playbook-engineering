// The lease store: cross-repo visibility, and reaping that cannot wedge.
//
// Every test points AGENT_GUARD_STATE_DIR at a scratch directory, which is the
// only sanctioned use of that variable — the command hook blocks agents from
// setting it, because a private lease namespace is the per-worktree bug wearing
// a different hat.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { acquireLease, heartbeatLease, isProcessAlive, readLeases, releaseLease } from '../lib/leases.mjs';
import { ensureStateDirs, leasesDir, machineToken } from '../lib/protocol.mjs';

const roots = [];
let env;

function scratchEnv() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-guard-test-'));
  roots.push(root);
  return { ...process.env, AGENT_GUARD_STATE_DIR: root };
}

beforeEach(() => {
  env = scratchEnv();
  ensureStateDirs(env);
});

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A pid that is real but certainly not running. 0 and negative values are
// special-cased by kill(2), so use a high pid the OS will not have reached.
const DEAD_PID = 4_194_303;

describe('lease lifecycle', () => {
  test('an acquired lease is visible to any other reader on the machine', () => {
    acquireLease({ env, label: 'test:e2e', estimatedMb: 3072, repo: 'overlook', worktree: '/w/overlook', harness: 'claude' });
    // A different repo's guard, reading the same machine-scoped directory —
    // the whole point of moving state out of <worktree>/.guard.
    const seen = readLeases(env);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].label, 'test:e2e');
    assert.equal(seen[0].repo, 'overlook');
    assert.equal(seen[0].estimatedMb, 3072);
  });

  test('leases from different repos and harnesses accumulate in one namespace', () => {
    acquireLease({ env, label: 'test:e2e', estimatedMb: 3072, repo: 'overlook', harness: 'claude' });
    acquireLease({ env, label: 'ci', estimatedMb: 2048, repo: 'image-trail', harness: 'codex' });
    const seen = readLeases(env);
    assert.equal(seen.length, 2);
    assert.deepEqual(new Set(seen.map((lease) => lease.harness)), new Set(['claude', 'codex']));
  });

  test('release frees the budget', () => {
    const lease = acquireLease({ env, label: 'test', estimatedMb: 512 });
    assert.equal(readLeases(env).length, 1);
    releaseLease(lease);
    assert.equal(readLeases(env).length, 0);
  });

  test('a heartbeat records observed usage without disturbing the reservation', () => {
    const lease = acquireLease({ env, label: 'test', estimatedMb: 2048 });
    heartbeatLease(lease, 700);
    const [seen] = readLeases(env);
    assert.equal(seen.observedMb, 700);
    assert.equal(seen.estimatedMb, 2048);
    assert.notEqual(seen.heartbeatAt, undefined);
  });
});

describe('reaping', () => {
  test('a force-quit agent does not wedge the machine forever', () => {
    acquireLease({ env, label: 'orphan', estimatedMb: 4096, pid: DEAD_PID });
    assert.equal(readLeases(env).length, 0, 'a dead pid holds no budget');
    assert.equal(readdirSync(leasesDir(env)).filter((name) => name.endsWith('.json')).length, 0, 'and its file is removed');
  });

  test('validity is liveness — never a hostname (qwts/overlook#842)', () => {
    // #842: hostnames drift .local ↔ .lan with network state, which made
    // crashed same-machine locks permanently unreclaimable. A lease carrying a
    // stale hostname must be judged on its pid alone, and a live pid keeps it.
    const lease = acquireLease({ env, label: 'live', estimatedMb: 512 });
    writeFileSync(lease.file, JSON.stringify({ ...lease, file: undefined, hostname: 'some-old-name.local' }));
    assert.equal(readLeases(env).length, 1, 'a live pid keeps its lease whatever any name says');
  });

  test('a restored or copied state directory is discarded, not trusted', () => {
    // The cross-machine trap #842 taught, arriving through a different door: a
    // synced directory would otherwise hand us foreign pids that collide with
    // local ones. The machine token has no source but itself, so it cannot
    // drift the way a hostname can.
    const foreign = { protocol: 1, id: 'foreign', pid: process.pid, estimatedMb: 4096, grantedAt: new Date().toISOString(), machineToken: 'not-this-machine' };
    writeFileSync(path.join(leasesDir(env), 'foreign.json'), JSON.stringify(foreign));
    assert.equal(readLeases(env).length, 0, 'a live local pid is not enough if the state is foreign');
  });

  test('junk in the lease directory cannot hold budget or crash the reader', () => {
    writeFileSync(path.join(leasesDir(env), 'truncated.json'), '{"protocol":1,"pid":');
    writeFileSync(path.join(leasesDir(env), 'wrong-shape.json'), '"a string"');
    writeFileSync(path.join(leasesDir(env), 'missing-fields.json'), '{"protocol":1}');
    writeFileSync(path.join(leasesDir(env), 'not-a-lease.txt'), 'ignored');
    assert.deepEqual(readLeases(env), []);
  });

  test('reap: false inspects without mutating, so status never destroys evidence', () => {
    acquireLease({ env, label: 'orphan', estimatedMb: 4096, pid: DEAD_PID });
    assert.equal(readLeases(env, { reap: false }).length, 0);
    assert.equal(readdirSync(leasesDir(env)).filter((name) => name.endsWith('.json')).length, 1);
  });

  test('a lease from a newer protocol version still counts against the budget', () => {
    // A mixed-vintage fleet is the normal state during a rollout. Ignoring a
    // neighbour's lease because its version is unfamiliar would silently
    // restore over-subscription.
    const future = {
      protocol: 99,
      id: 'from-the-future',
      pid: process.pid,
      estimatedMb: 2048,
      grantedAt: new Date().toISOString(),
      machineToken: machineToken(env),
      somethingNew: { we: 'do not understand this' },
    };
    writeFileSync(path.join(leasesDir(env), 'future.json'), JSON.stringify(future));
    const seen = readLeases(env);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].estimatedMb, 2048);
  });

  test('a missing state directory reads as empty rather than throwing', () => {
    assert.deepEqual(readLeases({ ...process.env, AGENT_GUARD_STATE_DIR: path.join(tmpdir(), 'agent-guard-absent-dir') }), []);
  });
});

describe('liveness probe', () => {
  test('this process is alive and an unreached pid is not', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(DEAD_PID), false);
  });

  test('pid 1 is alive even though it belongs to another user (EPERM)', () => {
    assert.equal(isProcessAlive(1), true);
  });
});
