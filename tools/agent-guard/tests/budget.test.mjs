// The budget arithmetic and the platform probes that feed it. Every case here
// is a machine state that must not require owning that machine to test — which
// is the point of keeping the formula pure.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SWAP_REFUSE_RATIO, clampCeiling, decideAdmission, deriveBudget, outstandingMb, unmaterializedMb } from '../lib/budget.mjs';
import { parseMeminfo, parseSwapusage, parseVmStat, readMemoryStatus } from '../lib/system-memory.mjs';

// Real output from the 8 GB machine during the incident this tool exists to
// prevent: 62 MB genuinely free, 6.09 GB of 7.17 GB swap committed.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     3812.
Pages active:                                  91270.
Pages inactive:                                86864.
Pages speculative:                              3864.
Pages throttled:                                   0.
Pages wired down:                             131683.
Pages purgeable:                                  18.
Pages occupying compressor:                    41000.
`;

const SWAPUSAGE = 'vm.swapusage: total = 7168.00M  used = 6090.00M  free = 1078.00M  (encrypted)\n';

const MEMINFO = `MemTotal:       16316456 kB
MemFree:          204816 kB
MemAvailable:    2097152 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
`;

describe('platform memory probes', () => {
  test('vm_stat page arithmetic uses the reported page size', () => {
    const { pageSize, availableMb, compressedMb } = parseVmStat(VM_STAT);
    assert.equal(pageSize, 16384);
    // free + speculative + inactive + purgeable, at 16 KB pages.
    assert.equal(availableMb, Math.round(((3812 + 3864 + 86864 + 18) * 16384) / (1024 * 1024)));
    assert.equal(compressedMb, Math.round((41000 * 16384) / (1024 * 1024)));
  });

  test('a 4 KB-page machine is not silently read as a 16 KB one', () => {
    const { pageSize } = parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 100.\n');
    assert.equal(pageSize, 4096);
  });

  test('vm_stat accepts the current macOS compressor label', () => {
    const current = VM_STAT.replace('Pages occupying compressor', 'Pages occupied by compressor');
    assert.equal(parseVmStat(current).compressedMb, Math.round((41000 * 16384) / (1024 * 1024)));
  });

  test('sysctl swapusage parses the M suffix', () => {
    assert.deepEqual(parseSwapusage(SWAPUSAGE), { swapTotalMb: 7168, swapUsedMb: 6090 });
  });

  test('swapusage handles G-suffixed values', () => {
    assert.deepEqual(parseSwapusage('vm.swapusage: total = 2.00G  used = 1.00G  free = 1.00G'), { swapTotalMb: 2048, swapUsedMb: 1024 });
  });

  test('meminfo reads MemAvailable and derives swap used from SwapFree', () => {
    assert.deepEqual(parseMeminfo(MEMINFO), { availableMb: 2048, swapTotalMb: 2048, swapUsedMb: 1024 });
  });

  test('darwin status combines both probes', () => {
    const status = readMemoryStatus({
      platform: 'darwin',
      totalMb: 8192,
      exec: (command) => (command === 'vm_stat' ? VM_STAT : SWAPUSAGE),
    });
    assert.equal(status.degraded, false);
    assert.equal(status.swapUsedMb, 6090);
    assert.equal(status.source, 'vm_stat+sysctl');
  });

  test('linux status is clamped to a cgroup v2 limit and live usage', () => {
    const files = new Map([
      ['/proc/meminfo', MEMINFO],
      ['/proc/self/cgroup', '0::/\n'],
      ['/sys/fs/cgroup/memory.max', String(4096 * 1024 * 1024)],
      ['/sys/fs/cgroup/memory.current', String(871 * 1024 * 1024)],
    ]);
    const status = readMemoryStatus({
      platform: 'linux',
      totalMb: 6073,
      readFile: (path) => {
        if (!files.has(path)) throw new Error(`missing fixture: ${path}`);
        return files.get(path);
      },
    });
    assert.equal(status.totalMb, 4096);
    assert.equal(status.availableMb, 2048);
    assert.equal(status.source, '/proc/meminfo+cgroup');
    assert.equal(status.degraded, false);
  });

  test('linux status recognizes a nested cgroup v1 memory controller', () => {
    const files = new Map([
      ['/proc/meminfo', MEMINFO],
      ['/proc/self/cgroup', '5:memory:/job\n'],
      ['/sys/fs/cgroup/memory/job/memory.limit_in_bytes', String(1536 * 1024 * 1024)],
      ['/sys/fs/cgroup/memory/job/memory.usage_in_bytes', String(512 * 1024 * 1024)],
    ]);
    const status = readMemoryStatus({
      platform: 'linux',
      totalMb: 6073,
      readFile: (path) => {
        if (!files.has(path)) throw new Error(`missing fixture: ${path}`);
        return files.get(path);
      },
    });
    assert.equal(status.totalMb, 1536);
    assert.equal(status.availableMb, 1024);
    assert.equal(status.source, '/proc/meminfo+cgroup');
  });

  test('a failing probe degrades loudly rather than reporting a healthy machine', () => {
    const status = readMemoryStatus({
      platform: 'darwin',
      totalMb: 8192,
      exec: () => {
        throw new Error('vm_stat: not found');
      },
    });
    assert.equal(status.degraded, true);
    // Unknown swap must never read as "plenty of swap headroom".
    assert.equal(status.swapTotalMb, 0);
  });
});

describe('budget derivation', () => {
  test('an 8 GB machine reserves the desktop and caps a run below the old default', () => {
    const budget = deriveBudget(8192);
    assert.equal(budget.reserveMb, 2048);
    assert.equal(budget.machineBudgetMb, 6144);
    assert.equal(budget.maxRunMb, 3072);
    assert.equal(budget.availabilityFloorMb, 1024);
  });

  test('the formula scales rather than switching on machine size', () => {
    assert.equal(deriveBudget(16384).maxRunMb, 6144);
    assert.equal(deriveBudget(65536).maxRunMb, 24576);
  });

  test('a tiny machine still gets a usable, non-negative budget', () => {
    const budget = deriveBudget(2048);
    assert.ok(budget.machineBudgetMb >= 512);
    assert.ok(budget.maxRunMb >= 512);
  });
});

describe('ceiling clamping', () => {
  const budget = deriveBudget(8192);

  test("the incident's own `--rss-mb 8192` is clamped to something that can trip", () => {
    const { ceilingMb, clamped } = clampCeiling(8192, budget);
    assert.equal(ceilingMb, 3072);
    assert.equal(clamped, true);
    assert.ok(ceilingMb < 8192, 'a ceiling at or above total RAM is a no-op guard');
  });

  test('tightening is always honoured', () => {
    const { ceilingMb, clamped } = clampCeiling(512, budget);
    assert.equal(ceilingMb, 512);
    assert.equal(clamped, false);
  });

  test('the same request is not clamped on a machine that can afford it', () => {
    assert.equal(clampCeiling(8192, deriveBudget(32768)).clamped, false);
  });

  test('an absent or nonsense request falls back to the machine cap', () => {
    assert.equal(clampCeiling(null, budget).ceilingMb, budget.maxRunMb);
    assert.equal(clampCeiling(Number.NaN, budget).ceilingMb, budget.maxRunMb);
    assert.equal(clampCeiling(-1, budget).ceilingMb, budget.maxRunMb);
  });
});

describe('admission', () => {
  const budget = deriveBudget(8192);
  const healthy = { totalMb: 8192, availableMb: 5000, swapTotalMb: 7168, swapUsedMb: 200 };

  test('an idle, healthy machine grants a full-cap run', () => {
    const decision = decideAdmission({ budget, memory: healthy, leases: [], requestMb: 3072 });
    assert.equal(decision.granted, true);
  });

  test('the incident state is refused, and names swap as the reason', () => {
    const decision = decideAdmission({
      budget,
      memory: { totalMb: 8192, availableMb: 1477, swapTotalMb: 7168, swapUsedMb: 6090 },
      leases: [],
      requestMb: 3072,
    });
    assert.equal(decision.granted, false);
    assert.equal(decision.reason, 'swap-pressure');
    assert.match(decision.message, /swap is 85% committed/u);
  });

  test('swap refusal fires exactly at the documented ratio', () => {
    const atThreshold = decideAdmission({
      budget,
      memory: { totalMb: 8192, availableMb: 5000, swapTotalMb: 1000, swapUsedMb: 1000 * SWAP_REFUSE_RATIO },
      leases: [],
      requestMb: budget.maxRunMb,
    });
    assert.equal(atThreshold.reason, 'swap-pressure');
  });

  test('a thrashing machine still admits lint and unit lanes', () => {
    // A guard that refuses every command on a busy machine gets switched off,
    // and a switched-off guard protects nothing. The swap gate is aimed at the
    // Electron-sized runs that actually freeze the box.
    const thrashing = { totalMb: 8192, availableMb: 1762, swapTotalMb: 7168, swapUsedMb: 6459 };
    assert.equal(decideAdmission({ budget, memory: thrashing, leases: [], requestMb: budget.lightRunMb }).granted, true);
    assert.equal(decideAdmission({ budget, memory: thrashing, leases: [], requestMb: budget.lightRunMb + 1 }).reason, 'swap-pressure');
  });

  test('the light-run carve-out never escapes the headroom floor', () => {
    // Exempt from the swap gate is not exempt from reality.
    const decision = decideAdmission({
      budget,
      memory: { totalMb: 8192, availableMb: 900, swapTotalMb: 7168, swapUsedMb: 6459 },
      leases: [],
      requestMb: budget.lightRunMb,
    });
    assert.equal(decision.granted, false);
    assert.equal(decision.reason, 'insufficient-headroom');
  });

  test('a machine with no swap configured is judged on headroom alone', () => {
    const decision = decideAdmission({ budget, memory: { ...healthy, swapTotalMb: 0, swapUsedMb: 0 }, leases: [], requestMb: 3072 });
    assert.equal(decision.granted, true);
  });

  test('headroom refusal counts other repos leases, not just this one', () => {
    const decision = decideAdmission({
      budget,
      memory: { ...healthy, availableMb: 3500 },
      leases: [{ estimatedMb: 3000, observedMb: 0 }],
      requestMb: 1024,
    });
    assert.equal(decision.granted, false);
    assert.equal(decision.reason, 'insufficient-headroom');
  });

  test('a warmed-up run stops being counted twice as it materializes', () => {
    // Same lease, but its 3000 MB reservation is now resident — and therefore
    // already subtracted from availableMb by the kernel. Double-counting it
    // would refuse a run the machine can genuinely afford.
    const memory = { ...healthy, availableMb: 3500 };
    const cold = decideAdmission({ budget, memory, leases: [{ estimatedMb: 3000, observedMb: 0 }], requestMb: 1024 });
    const warm = decideAdmission({ budget, memory, leases: [{ estimatedMb: 3000, observedMb: 3000 }], requestMb: 1024 });
    assert.equal(cold.granted, false);
    assert.equal(warm.granted, true);
  });

  test('the machine budget refuses oversubscription even when memory looks free', () => {
    // Plenty of measured headroom, but the outstanding leases have already
    // promised the machine away — this is the per-worktree bug's fix.
    const decision = decideAdmission({
      budget,
      memory: { ...healthy, availableMb: 7500 },
      leases: [
        { estimatedMb: 3000, observedMb: 3000 },
        { estimatedMb: 3000, observedMb: 3000 },
      ],
      requestMb: 1024,
    });
    assert.equal(decision.granted, false);
    assert.equal(decision.reason, 'machine-budget');
    assert.match(decision.message, /shared by every repo, worktree and agent/u);
  });

  test('four concurrent agents cannot each be granted a full-cap run', () => {
    // The literal incident shape: four sessions, each asking for something
    // individually reasonable, collectively fatal. Each admitted run is modelled
    // as fully materializing before the next asks, so availableMb falls the way
    // the kernel would actually report it.
    const leases = [];
    const refusals = [];
    for (let i = 0; i < 4; i += 1) {
      const memory = { ...healthy, availableMb: 5000 - outstandingMb(leases) };
      const decision = decideAdmission({ budget, memory, leases, requestMb: budget.maxRunMb });
      if (decision.granted) leases.push({ estimatedMb: budget.maxRunMb, observedMb: budget.maxRunMb });
      else refusals.push(decision.reason);
    }
    // Real availability binds before the machine budget does — 5000 MB does not
    // hold two 3072 MB runs, whatever the budget would otherwise allow. That
    // pre-flight check is precisely what the guard this replaces never made.
    assert.equal(leases.length, 1);
    assert.deepEqual(refusals, ['insufficient-headroom', 'insufficient-headroom', 'insufficient-headroom']);
  });

  test('the machine budget, not availability, is what stops small runs multiplying', () => {
    // Generous availability so the headroom check never fires: the cap that
    // binds here is the shared budget, which is the cross-repo scope.
    const leases = [];
    let admitted = 0;
    for (let i = 0; i < 12; i += 1) {
      const decision = decideAdmission({ budget, memory: { ...healthy, availableMb: 100_000 }, leases, requestMb: 1024 });
      if (!decision.granted) {
        assert.equal(decision.reason, 'machine-budget');
        break;
      }
      admitted += 1;
      leases.push({ estimatedMb: 1024, observedMb: 1024 });
    }
    assert.equal(admitted, 6, '6144 MB of budget holds six 1024 MB runs and no more');
  });

  test('the arithmetic is reported so a refusal can be argued with', () => {
    const decision = decideAdmission({ budget, memory: healthy, leases: [{ estimatedMb: 1000, observedMb: 400 }], requestMb: 512 });
    assert.equal(decision.outstandingMb, 1000);
    assert.equal(decision.unmaterializedMb, 600);
    assert.equal(decision.projectedFreeMb, 5000 - 600 - 512);
  });
});

describe('lease accounting helpers', () => {
  test('outstanding sums reservations; unmaterialized sums what is still promised', () => {
    const leases = [
      { estimatedMb: 1000, observedMb: 250 },
      { estimatedMb: 2000, observedMb: 2500 },
    ];
    assert.equal(outstandingMb(leases), 3000);
    // A run that overshot its own estimate contributes zero, never a negative.
    assert.equal(unmaterializedMb(leases), 750);
  });

  test('malformed observed usage cannot manufacture admission headroom', () => {
    for (const observedMb of ['1024', Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.equal(unmaterializedMb([{ estimatedMb: 2048, observedMb }]), 2048);
    }
  });
});
