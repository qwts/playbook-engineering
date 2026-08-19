// The lease store: cross-repo visibility, and reaping that cannot wedge.
//
// Every test points AGENT_GUARD_STATE_DIR at a scratch directory, which is the
// only sanctioned use of that variable — the command hook blocks agents from
// setting it, because a private lease namespace is the per-worktree bug wearing
// a different hat.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  acquireLease,
  commandBehaviorIdentity,
  heartbeatLease,
  isProcessAlive,
  isProcessGroupAlive,
  leaseExists,
  psExecutable,
  readLeases,
  releaseLease,
  repositoryIdentity,
  repositoryWorktreeRoot,
  retargetLease,
  readLanePeakMb,
  recordLanePeak,
  withAdmissionLock,
} from '../lib/leases.mjs';
import { ensureStateDirs, leasesDir, machineToken } from '../lib/protocol.mjs';
import { guardDiagnosticPaths } from '../run-guarded.mjs';

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

describe('lane peak store (#180)', () => {
  test('linked worktrees share only matching command behavior (#223, #236)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-guard-repos-'));
    roots.push(root);
    const first = path.join(root, 'first', 'app');
    const second = path.join(root, 'second', 'app');
    const sibling = path.join(root, 'linked-worktree');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });

    const git = ['/usr/bin/git', '/bin/git'].find((candidate) => {
      try {
        execFileSync(candidate, ['--version'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(git, 'a system Git binary is required to resolve common-checkout identity');
    for (const checkout of [first, second]) {
      execFileSync(git, ['-C', checkout, 'init', '--quiet'], { stdio: 'ignore' });
      writeFileSync(path.join(checkout, 'package.json'), `${JSON.stringify({ scripts: { test: 'node light.mjs' } }, null, 2)}\n`);
      writeFileSync(path.join(checkout, 'light.mjs'), 'setTimeout(() => {}, 1);\n');
      execFileSync(git, ['-C', checkout, 'add', 'package.json', 'light.mjs'], { stdio: 'ignore' });
      execFileSync(git, ['-C', checkout, '-c', 'user.name=Agent Guard Test', '-c', 'user.email=guard@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { stdio: 'ignore' });
    }
    execFileSync(git, ['-C', first, 'worktree', 'add', '--quiet', '--detach', sibling], { stdio: 'ignore' });

    const firstIdentity = repositoryIdentity(first);
    assert.equal(repositoryIdentity(sibling), firstIdentity, 'sibling worktrees must share measured peaks');
    assert.notEqual(repositoryIdentity(second), firstIdentity, 'same-basename independent repositories must not share peaks');
    assert.equal(
      repositoryIdentity(sibling, { env: { ...process.env, GIT_DIR: path.join(second, '.git'), GIT_WORK_TREE: second } }),
      firstIdentity,
      'caller-controlled Git identity variables must not redirect peak history',
    );

    const peakEnv = scratchEnv();
    const command = ['npm', 'test'];
    const environmentFor = (cwd, overrides = {}) => ({
      ...peakEnv,
      PWD: cwd,
      INIT_CWD: cwd,
      AGENT_GUARDED: '<guard-lease>',
      NODE_ENV: 'test',
      ...overrides,
    });
    const firstBehavior = commandBehaviorIdentity(first, command, {
      env: peakEnv,
      behaviorEnv: environmentFor(first),
    });
    const siblingBehavior = commandBehaviorIdentity(sibling, command, {
      env: peakEnv,
      behaviorEnv: environmentFor(sibling),
    });
    assert.match(firstBehavior, /^[0-9a-f]{64}$/u);
    assert.equal(siblingBehavior, firstBehavior, 'same revision and effective environment may share across worktrees');

    const firstNested = path.join(first, 'packages', 'app');
    const siblingNested = path.join(sibling, 'packages', 'app');
    const firstOtherCwd = path.join(first, 'packages', 'other');
    mkdirSync(firstNested, { recursive: true });
    mkdirSync(siblingNested, { recursive: true });
    mkdirSync(firstOtherCwd, { recursive: true });
    const firstNestedBehavior = commandBehaviorIdentity(firstNested, command, {
      env: peakEnv,
      behaviorEnv: environmentFor(firstNested),
    });
    const siblingNestedBehavior = commandBehaviorIdentity(siblingNested, command, {
      env: peakEnv,
      behaviorEnv: environmentFor(siblingNested),
    });
    const firstOtherCwdBehavior = commandBehaviorIdentity(firstOtherCwd, command, {
      env: peakEnv,
      behaviorEnv: environmentFor(firstOtherCwd),
    });
    assert.match(firstNestedBehavior, /^[0-9a-f]{64}$/u);
    assert.equal(
      siblingNestedBehavior,
      firstNestedBehavior,
      'linked worktrees may share behavior only at the same repository-relative cwd',
    );
    assert.notEqual(firstNestedBehavior, firstBehavior, 'the repository-relative cwd is command behavior');
    assert.notEqual(firstOtherCwdBehavior, firstNestedBehavior, 'different repository-relative cwd values cannot share history');
    assert.notEqual(
      commandBehaviorIdentity(firstNested, command, { env: peakEnv, behaviorEnv: environmentFor(first) }),
      firstBehavior,
      'the actual relative cwd remains bound even when the structural environment is unchanged',
    );

    // Every cwd in one Git worktree writes diagnostics at the worktree root,
    // so one nested run cannot poison the other cwd identities. Only those
    // two root paths are exempt; the same suffix below a nested cwd is not.
    assert.equal(repositoryWorktreeRoot(firstNested, { env: peakEnv }), repositoryWorktreeRoot(first, { env: peakEnv }));
    assert.equal(repositoryWorktreeRoot(siblingNested, { env: peakEnv }), repositoryWorktreeRoot(sibling, { env: peakEnv }));
    const nestedDiagnosticPaths = guardDiagnosticPaths(firstNested, { env: peakEnv });
    const rootDiagnostics = path.join(repositoryWorktreeRoot(first, { env: peakEnv }), '.guard');
    assert.equal(nestedDiagnosticPaths.guardDir, rootDiagnostics);
    assert.equal(nestedDiagnosticPaths.lastRunPath, path.join(rootDiagnostics, 'last-run.json'));
    assert.equal(nestedDiagnosticPaths.lastRunDisplayPath, path.join('..', '..', '.guard', 'last-run.json'));
    mkdirSync(rootDiagnostics);
    writeFileSync(path.join(rootDiagnostics, 'last-run.json'), '{}\n');
    writeFileSync(path.join(rootDiagnostics, 'history.jsonl'), '{}\n');
    assert.equal(
      commandBehaviorIdentity(firstNested, command, { env: peakEnv, behaviorEnv: environmentFor(firstNested) }),
      firstNestedBehavior,
      'root-owned diagnostics do not make a nested-cwd run cold',
    );
    assert.equal(
      commandBehaviorIdentity(first, command, { env: peakEnv, behaviorEnv: environmentFor(first) }),
      firstBehavior,
      'the same root-owned diagnostics remain inert for a root run',
    );
    writeFileSync(path.join(rootDiagnostics, 'caller-owned.json'), '{}\n');
    assert.equal(
      commandBehaviorIdentity(firstNested, command, { env: peakEnv, behaviorEnv: environmentFor(firstNested) }),
      null,
      'the root diagnostic exemption does not cover other files in .guard',
    );
    rmSync(path.join(rootDiagnostics, 'caller-owned.json'));
    const nestedDiagnostics = path.join(firstNested, '.guard');
    mkdirSync(nestedDiagnostics);
    writeFileSync(path.join(nestedDiagnostics, 'last-run.json'), '{}\n');
    assert.equal(
      commandBehaviorIdentity(firstNested, command, { env: peakEnv, behaviorEnv: environmentFor(firstNested) }),
      null,
      'diagnostic suffixes beneath a nested cwd are not broadly exempted',
    );
    rmSync(nestedDiagnostics, { recursive: true, force: true });
    rmSync(rootDiagnostics, { recursive: true, force: true });

    const nonRepository = path.join(root, 'not-a-repository');
    mkdirSync(nonRepository);
    assert.equal(
      commandBehaviorIdentity(nonRepository, command, { env: peakEnv, behaviorEnv: environmentFor(nonRepository) }),
      null,
      'a failed repository top-level probe must be a cold start',
    );
    assert.equal(repositoryWorktreeRoot(nonRepository, { env: peakEnv }), null);
    assert.equal(
      commandBehaviorIdentity(path.join(root, 'missing-cwd'), command, {
        env: peakEnv,
        behaviorEnv: environmentFor(path.join(root, 'missing-cwd')),
      }),
      null,
      'an unresolvable cwd path must be a cold start',
    );
    assert.notEqual(
      commandBehaviorIdentity(first, command, {
        env: peakEnv,
        behaviorEnv: environmentFor(first, { BEHAVIOR_ROOT: first }),
      }),
      commandBehaviorIdentity(sibling, command, {
        env: peakEnv,
        behaviorEnv: environmentFor(sibling, { BEHAVIOR_ROOT: sibling }),
      }),
      'caller-defined path-valued environment remains exact across worktrees',
    );

    await recordLanePeak({
      env: peakEnv,
      repo: firstIdentity,
      label: 'test',
      command,
      behaviorIdentity: firstBehavior,
      peakRssMb: 900,
    });
    assert.equal(
      readLanePeakMb({
        env: peakEnv,
        repo: repositoryIdentity(sibling),
        label: 'test',
        command,
        behaviorIdentity: siblingBehavior,
      }),
      900,
    );
    assert.equal(
      readLanePeakMb({
        env: peakEnv,
        repo: repositoryIdentity(second),
        label: 'test',
        command,
        behaviorIdentity: commandBehaviorIdentity(second, command, {
          env: peakEnv,
          behaviorEnv: environmentFor(second),
        }),
      }),
      null,
    );

    // The argv did not change, but the npm script did. Both unstaged and
    // staged edits are untrusted; after commit, the new revision gets a fresh
    // identity rather than borrowing the old light peak.
    writeFileSync(path.join(sibling, 'package.json'), `${JSON.stringify({ scripts: { test: 'node heavy.mjs' } }, null, 2)}\n`);
    assert.equal(
      commandBehaviorIdentity(sibling, command, { env: peakEnv, behaviorEnv: environmentFor(sibling) }),
      null,
      'dirty script content must fail closed',
    );
    execFileSync(git, ['-C', sibling, 'add', 'package.json'], { stdio: 'ignore' });
    assert.equal(
      commandBehaviorIdentity(sibling, command, { env: peakEnv, behaviorEnv: environmentFor(sibling) }),
      null,
      'staged script content must fail closed',
    );
    execFileSync(git, ['-C', sibling, '-c', 'user.name=Agent Guard Test', '-c', 'user.email=guard@example.invalid', 'commit', '--quiet', '-m', 'heavier test script'], { stdio: 'ignore' });
    const revisedBehavior = commandBehaviorIdentity(sibling, command, {
      env: peakEnv,
      behaviorEnv: environmentFor(sibling),
    });
    assert.notEqual(revisedBehavior, firstBehavior, 'a changed revision must invalidate same-argv history');
    assert.equal(
      readLanePeakMb({
        env: peakEnv,
        repo: firstIdentity,
        label: 'test',
        command,
        behaviorIdentity: revisedBehavior,
      }),
      null,
    );

    for (const overrides of [
      { NODE_ENV: 'production' },
      { NODE_OPTIONS: '--conditions=memory-heavy' },
      { FEATURE_FLAG: 'memory-heavy' },
    ]) {
      const changedEnvironment = commandBehaviorIdentity(first, command, {
        env: peakEnv,
        behaviorEnv: environmentFor(first, overrides),
      });
      assert.notEqual(changedEnvironment, firstBehavior);
      assert.equal(
        readLanePeakMb({
          env: peakEnv,
          repo: firstIdentity,
          label: 'test',
          command,
          behaviorIdentity: changedEnvironment,
        }),
        null,
      );
    }

    const untracked = path.join(first, 'untracked-runner.mjs');
    writeFileSync(untracked, 'process.exit(0);\n');
    assert.equal(
      commandBehaviorIdentity(first, command, { env: peakEnv, behaviorEnv: environmentFor(first) }),
      null,
      'untracked executable content must fail closed',
    );
    rmSync(untracked, { force: true });

    // The wrapper's own two untracked diagnostics must not make a successful
    // clean run permanently cold, but no broader .guard exemption exists.
    const diagnostics = path.join(first, '.guard');
    mkdirSync(diagnostics);
    writeFileSync(path.join(diagnostics, 'last-run.json'), '{}\n');
    writeFileSync(path.join(diagnostics, 'history.jsonl'), '{}\n');
    assert.equal(
      commandBehaviorIdentity(first, command, { env: peakEnv, behaviorEnv: environmentFor(first) }),
      firstBehavior,
      'guard-owned untracked diagnostics do not invalidate otherwise clean evidence',
    );
    writeFileSync(path.join(diagnostics, 'caller-owned.json'), '{}\n');
    assert.equal(
      commandBehaviorIdentity(first, command, { env: peakEnv, behaviorEnv: environmentFor(first) }),
      null,
      'other untracked guard files still fail closed',
    );
    rmSync(path.join(diagnostics, 'caller-owned.json'));

    const originalPackage = `${JSON.stringify({ scripts: { test: 'node light.mjs' } }, null, 2)}\n`;
    const hiddenPackage = `${JSON.stringify({ scripts: { test: 'node hidden-heavy.mjs' } }, null, 2)}\n`;
    for (const [hide, reveal, label] of [
      ['--assume-unchanged', '--no-assume-unchanged', 'assume-unchanged'],
      ['--skip-worktree', '--no-skip-worktree', 'skip-worktree'],
    ]) {
      execFileSync(git, ['-C', first, 'update-index', hide, 'package.json'], { stdio: 'ignore' });
      writeFileSync(path.join(first, 'package.json'), hiddenPackage);
      assert.equal(
        commandBehaviorIdentity(first, command, { env: peakEnv, behaviorEnv: environmentFor(first) }),
        null,
        `${label} index state cannot hide changed command behavior`,
      );
      execFileSync(git, ['-C', first, 'update-index', reveal, 'package.json'], { stdio: 'ignore' });
      writeFileSync(path.join(first, 'package.json'), originalPackage);
    }
    assert.equal(
      commandBehaviorIdentity(first, command, { env: peakEnv, behaviorEnv: environmentFor(first) }),
      firstBehavior,
    );

    const external = path.join(root, 'external-runner');
    writeFileSync(external, '#!/bin/sh\nexit 0\n');
    chmodSync(external, 0o755);
    const externalBefore = commandBehaviorIdentity(first, [external], {
      env: peakEnv,
      behaviorEnv: environmentFor(first),
    });
    writeFileSync(external, '#!/bin/sh\necho changed\nexit 0\n');
    const externalAfter = commandBehaviorIdentity(first, [external], {
      env: peakEnv,
      behaviorEnv: environmentFor(first),
    });
    assert.notEqual(externalAfter, externalBefore, 'changed executable contents must invalidate history');
  });

  test('peaks round-trip through the protected store and keep the max of a rolling window', async () => {
    const env = { AGENT_GUARD_STATE_DIR: mkdtempSync(path.join(tmpdir(), 'agent-guard-peaks-')) };
    const command = ['npm', 'test'];
    const behaviorIdentity = 'behavior-a';
    assert.equal(readLanePeakMb({ env, repo: 'overlook', label: 'test', command, behaviorIdentity }), null);
    await recordLanePeak({ env, repo: 'overlook', label: 'test', command, behaviorIdentity, peakRssMb: 900 });
    await recordLanePeak({ env, repo: 'overlook', label: 'test', command, behaviorIdentity, peakRssMb: 1100 });
    await recordLanePeak({ env, repo: 'overlook', label: 'test', command, behaviorIdentity, peakRssMb: 700 });
    assert.equal(readLanePeakMb({ env, repo: 'overlook', label: 'test', command, behaviorIdentity }), 1100);
    // Other lanes and repos do not bleed together.
    assert.equal(readLanePeakMb({ env, repo: 'overlook', label: 'other', command, behaviorIdentity }), null);
    assert.equal(readLanePeakMb({ env, repo: 'cartograph', label: 'test', command, behaviorIdentity }), null);
    assert.equal(readLanePeakMb({ env, repo: 'overlook', label: 'test', command: ['npm', 'run', 'other'], behaviorIdentity }), null);
    assert.equal(readLanePeakMb({ env, repo: 'overlook', label: 'test', command, behaviorIdentity: 'behavior-b' }), null);
    await recordLanePeak({ env, repo: '/repos/a::b', label: 'test', command, behaviorIdentity, peakRssMb: 400 });
    await recordLanePeak({ env, repo: '/repos/a', label: 'b::test', command, behaviorIdentity, peakRssMb: 800 });
    assert.equal(readLanePeakMb({ env, repo: '/repos/a::b', label: 'test', command, behaviorIdentity }), 400);
    assert.equal(readLanePeakMb({ env, repo: '/repos/a', label: 'b::test', command, behaviorIdentity }), 800);
    assert.equal(
      readLanePeakMb({ env, repo: 'overlook', label: 'test', command }),
      null,
      'history without a verified behavior identity fails closed',
    );
    // Junk values are never recorded or returned.
    await recordLanePeak({ env, repo: 'overlook', label: 'junk', command, behaviorIdentity, peakRssMb: Number.NaN });
    await recordLanePeak({ env, repo: 'overlook', label: 'junk', command, behaviorIdentity, peakRssMb: -5 });
    assert.equal(readLanePeakMb({ env, repo: 'overlook', label: 'junk', command, behaviorIdentity }), null);
    rmSync(env.AGENT_GUARD_STATE_DIR, { recursive: true, force: true });
  });

  test('concurrent writers retain the larger measured sample', async () => {
    const laneCount = 4;
    const samples = [320, 640, 960, 1440];
    const writerCount = laneCount * samples.length;
    const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const gate = new Int32Array(gateBuffer);
    const moduleUrl = new URL('../lib/leases.mjs', import.meta.url).href;
    const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(`
      import { parentPort, workerData } from 'node:worker_threads';
      const { recordLanePeak } = await import(workerData.moduleUrl);
      const gate = new Int32Array(workerData.gateBuffer);
      Atomics.add(gate, 0, 1);
      Atomics.notify(gate, 0);
      Atomics.wait(gate, 1, 0);
      const recorded = await recordLanePeak(workerData.peak);
      parentPort.postMessage(recorded);
    `)}`);
    const workers = [];
    const completions = [];

    for (let lane = 0; lane < laneCount; lane += 1) {
      for (const peakRssMb of samples) {
        const worker = new Worker(workerUrl, {
          workerData: {
            moduleUrl,
            gateBuffer,
            peak: {
              env: { AGENT_GUARD_STATE_DIR: env.AGENT_GUARD_STATE_DIR },
              repo: 'shared-checkout',
              label: `concurrent-${lane}`,
              command: ['npm', 'test'],
              behaviorIdentity: 'concurrent-behavior',
              peakRssMb,
            },
          },
        });
        workers.push(worker);
        completions.push(new Promise((resolve, reject) => {
          let recorded = false;
          worker.once('message', (value) => {
            recorded = value;
          });
          worker.once('error', reject);
          worker.once('exit', (code) => {
            if (code !== 0) reject(new Error(`lane-peak writer exited ${code}`));
            else if (!recorded) reject(new Error('lane-peak writer did not record its sample'));
            else resolve();
          });
        }));
      }
    }

    try {
      const readyDeadline = Date.now() + 10_000;
      while (Atomics.load(gate, 0) < writerCount && Date.now() < readyDeadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
      assert.equal(Atomics.load(gate, 0), writerCount, 'every writer must reach the shared start gate');
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1, writerCount);
      await Promise.all(completions);
    } finally {
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1, writerCount);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
    for (let lane = 0; lane < laneCount; lane += 1) {
      assert.equal(
        readLanePeakMb({
          env,
          repo: 'shared-checkout',
          label: `concurrent-${lane}`,
          command: ['npm', 'test'],
          behaviorIdentity: 'concurrent-behavior',
        }),
        Math.max(...samples),
        `lane ${lane} lost its larger concurrent sample`,
      );
    }
  });
});
