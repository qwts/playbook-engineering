// The lease store: cross-repo visibility, and reaping that cannot wedge.
//
// Every test points AGENT_GUARD_STATE_DIR at a scratch directory, which is the
// only sanctioned use of that variable — the command hook blocks agents from
// setting it, because a private lease namespace is the per-worktree bug wearing
// a different hat.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import {
  acquireLease,
  heartbeatLease,
  isProcessAlive,
  isProcessGroupAlive,
  leaseExists,
  psExecutable,
  readLeases,
  releaseLease,
  retargetLease,
  withAdmissionLock,
} from '../lib/leases.mjs';
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

  test('a detached child group keeps its lease after the wrapper pid dies', () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const lease = acquireLease({ env, label: 'detached', estimatedMb: 512 });
    try {
      assert.equal(isProcessGroupAlive(child.pid), true);
      assert.equal(retargetLease(lease, { pid: DEAD_PID, processGroupId: child.pid }), true);
      assert.equal(readLeases(env).length, 1, 'group liveness, not the dead wrapper pid, holds the reservation');
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The child may have exited independently.
      }
      releaseLease(lease);
    }
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

  test('non-positive lease reservations cannot reduce the machine budget', () => {
    for (const [name, pid, estimatedMb] of [
      ['zero-pid', 0, 1024],
      ['zero-budget', process.pid, 0],
      ['negative-budget', process.pid, -1024],
    ]) {
      const invalid = { protocol: 1, id: name, pid, estimatedMb, grantedAt: new Date().toISOString(), machineToken: machineToken(env) };
      writeFileSync(path.join(leasesDir(env), `${name}.json`), JSON.stringify(invalid));
    }
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

// PR #139 review, P1: `AGENT_GUARDED=1` was enough to claim nesting, which
// skipped the lease, the ceiling and the headroom check.
describe('nested-run marker', () => {
  test('only an id naming a held lease in this process group counts as nested', () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    const lease = acquireLease({ env, label: 'parent', estimatedMb: 512 });
    try {
      assert.equal(retargetLease(lease, { pid: child.pid, processGroupId: child.pid }), true);
      assert.equal(leaseExists(lease.id, env, { processGroupId: child.pid }), true);
      assert.equal(leaseExists(lease.id, env, { processGroupId: child.pid + 1 }), false, 'a copied live id is not transferable to another process group');
      assert.equal(leaseExists('1', env, { processGroupId: child.pid }), false);
      assert.equal(leaseExists(undefined, env, { processGroupId: child.pid }), false);
      assert.equal(leaseExists('', env, { processGroupId: child.pid }), false);
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The child may have exited independently.
      }
      releaseLease(lease);
    }
  });

  test('the marker stops counting once the parent run ends', () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    const lease = acquireLease({ env, label: 'parent', estimatedMb: 512 });
    try {
      assert.equal(retargetLease(lease, { pid: child.pid, processGroupId: child.pid }), true);
      releaseLease(lease);
      assert.equal(leaseExists(lease.id, env, { processGroupId: child.pid }), false);
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The child may have exited independently.
      }
      releaseLease(lease);
    }
  });
});

// PR #139 review, P2: decide-then-acquire let two runs be admitted against one
// snapshot — the concurrent-agent case the machine budget exists to coordinate.
describe('admission mutex', () => {
  test('overlapping critical sections do not interleave', async () => {
    const order = [];
    let inside = 0;
    await Promise.all(
      Array.from({ length: 5 }, (unused, index) =>
        withAdmissionLock(env, async () => {
          inside += 1;
          assert.equal(inside, 1, 'two holders were inside the lock at once');
          order.push(index);
          await new Promise((resolve) => {
            setTimeout(resolve, 5);
          });
          inside -= 1;
        }),
      ),
    );
    assert.equal(order.length, 5);
  });

  test('read-decide-write under the lock cannot double-admit', async () => {
    // Each contender admits only if the budget still has room, then writes its
    // lease inside the same critical section.
    const BUDGET_MB = 2048;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        withAdmissionLock(env, () => {
          const used = readLeases(env).reduce((total, lease) => total + lease.estimatedMb, 0);
          if (used + 1024 > BUDGET_MB) return 'refused';
          acquireLease({ env, label: 'contender', estimatedMb: 1024 });
          return 'granted';
        }),
      ),
    );
    assert.equal(results.filter((result) => result === 'granted').length, 2);
    assert.equal(readLeases(env).length, 2);
  });

  test('a crashed holder does not wedge admission forever', async () => {
    // Simulate the crash: a lock directory whose owner is a dead pid.
    const dir = path.join(env.AGENT_GUARD_STATE_DIR, 'admission.lock');
    ensureStateDirs(env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: DEAD_PID, at: new Date().toISOString() }));
    const ran = await withAdmissionLock(env, () => 'entered', { timeoutMs: 2000 });
    assert.equal(ran, 'entered');
  });

  test('malformed metadata cannot evict a live lock owner', async () => {
    const dir = path.join(env.AGENT_GUARD_STATE_DIR, 'admission.lock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, at: 'not-a-date' }));
    let entered = false;
    await assert.rejects(
      withAdmissionLock(
        env,
        () => {
          entered = true;
        },
        { timeoutMs: 75 },
      ),
      /refusing to proceed without machine-wide serialization/u,
    );
    assert.equal(entered, false, 'a contender must not run outside the lock');
  });

  test('the lock is released even when the critical section throws', async () => {
    await assert.rejects(withAdmissionLock(env, () => {
      throw new Error('boom');
    }));
    assert.equal(await withAdmissionLock(env, () => 'entered'), 'entered');
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

  test('process inspection uses a portable absolute system binary', () => {
    assert.match(psExecutable(), /^\/(?:usr\/)?bin\/ps$/u);
  });
});
