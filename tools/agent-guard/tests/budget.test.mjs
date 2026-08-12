// The budget arithmetic and the platform probes that feed it. Every case here
// is a machine state that must not require owning that machine to test — which
// is the point of keeping the formula pure.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LANE_CAP_MB, SWAP_REFUSE_RATIO, clampCeiling, decideAdmission, deriveBudget, deriveBudgetForMemory, laneReservationMb, outstandingMb, recentLanePeakMb, unmaterializedMb } from '../lib/budget.mjs';
import { parseMeminfo, parsePressureLevel, parseSwapusage, parseVmStat, readMemoryStatus } from '../lib/system-memory.mjs';

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

  test('pressure level parses only its own sysctl output', () => {
    assert.equal(parsePressureLevel('kern.memorystatus_vm_pressure_level: 1\n'), 1);
    assert.equal(parsePressureLevel('kern.memorystatus_vm_pressure_level: 4'), 4);
    assert.equal(parsePressureLevel(SWAPUSAGE), null);
    assert.equal(parsePressureLevel(''), null);
  });

  test('a refused swap probe keeps the vm_stat evidence instead of degrading (#180)', () => {
    // Agent sandboxes can EPERM `sysctl vm.swapusage` while vm_stat stays
    // readable; os.freemem() badly overstates pressure on macOS, so falling
    // all the way back was itself a false-refusal source.
    const status = readMemoryStatus({
      platform: 'darwin',
      totalMb: 24576,
      exec: (command, args) => {
        if (command === 'vm_stat') return VM_STAT;
        if (args[0] === 'kern.memorystatus_vm_pressure_level') return 'kern.memorystatus_vm_pressure_level: 1\n';
        throw new Error('sysctl: EPERM');
      },
    });
    assert.equal(status.degraded, false);
    assert.equal(status.source, 'vm_stat');
    assert.equal(status.swapKnown, false);
    assert.equal(status.pressureLevel, 1);
    assert.ok(status.availableMb > 0);
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
    assert.equal(budget.maxRunMb, 2048);
    assert.equal(budget.availabilityFloorMb, 1024);
  });

  test('the per-lane cap binds on machines the budget alone would not restrain', () => {
    // The incident lane ballooned to ~100 GB; no sanctioned local lane needs
    // more than LANE_CAP_MB, and a 24 GB machine reserving 9.2 GB for a
    // measured ~2 GB lane is how healthy machines got refused (#180).
    assert.equal(deriveBudget(16384).maxRunMb, LANE_CAP_MB);
    assert.equal(deriveBudget(24576).maxRunMb, LANE_CAP_MB);
    assert.equal(deriveBudget(65536).maxRunMb, LANE_CAP_MB);
    // Below the cap the machine-derived half-budget still scales down.
    assert.equal(deriveBudget(4096).maxRunMb, 1280);
  });

  test('a tiny machine still gets a usable, non-negative budget', () => {
    const budget = deriveBudget(2048);
    assert.ok(budget.machineBudgetMb >= 512);
    assert.ok(budget.maxRunMb >= 512);
  });

  test('the caller derives limits from the cgroup-adjusted memory total', () => {
    assert.equal(deriveBudgetForMemory({ totalMb: 4096 }).maxRunMb, 1280);
  });
});

describe('ceiling clamping', () => {
  const budget = deriveBudget(8192);

  test("the incident's own `--rss-mb 8192` is clamped to something that can trip", () => {
    const { ceilingMb, clamped } = clampCeiling(8192, budget);
    assert.equal(ceilingMb, 2048);
    assert.equal(clamped, true);
    assert.ok(ceilingMb < 8192, 'a ceiling at or above total RAM is a no-op guard');
  });

  test('tightening is always honoured', () => {
    const { ceilingMb, clamped } = clampCeiling(512, budget);
    assert.equal(ceilingMb, 512);
    assert.equal(clamped, false);
  });

  test('the lane cap binds even on a machine that could afford more', () => {
    // Affording it is not the question: the cap is the enforced contract that
    // no single lane plans past what run-guarded will kill it at.
    const big = clampCeiling(8192, deriveBudget(32768));
    assert.equal(big.ceilingMb, LANE_CAP_MB);
    assert.equal(big.clamped, true);
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

describe('pressure-aware admission (#180)', () => {
  const budget = deriveBudget(24576);

  test('a healthy 24 GB Mac admits a capped lane it used to refuse', () => {
    // The recorded refusal: 12,163 MB available, green pressure, no leases —
    // refused only because the lane was booked at the 9,216 MB machine cap.
    // Reserved at the lane cap instead, the same machine admits it.
    const memory = { totalMb: 24576, availableMb: 12163, swapTotalMb: 3072, swapUsedMb: 552, pressureLevel: 1 };
    const decision = decideAdmission({ budget, memory, leases: [], requestMb: budget.maxRunMb });
    assert.equal(decision.granted, true);
    assert.equal(budget.maxRunMb, LANE_CAP_MB);
  });

  test('kernel warning pressure refuses a heavy run whatever the page counts say', () => {
    const memory = { totalMb: 24576, availableMb: 12163, swapTotalMb: 3072, swapUsedMb: 552, pressureLevel: 2 };
    const heavy = decideAdmission({ budget, memory, leases: [], requestMb: budget.maxRunMb });
    assert.equal(heavy.granted, false);
    assert.equal(heavy.reason, 'memory-pressure');
    // The light carve-out survives, as with the swap gate.
    assert.equal(decideAdmission({ budget, memory, leases: [], requestMb: budget.lightRunMb }).granted, true);
  });

  test('normal pressure retires static swap history as refusal evidence', () => {
    // macOS keeps swap allocated after pressure subsides; committed-but-idle
    // swap on a green machine is history, not scarcity.
    const memory = { totalMb: 24576, availableMb: 12163, swapTotalMb: 4096, swapUsedMb: 4000, pressureLevel: 1 };
    assert.equal(decideAdmission({ budget, memory, leases: [], requestMb: budget.maxRunMb }).granted, true);
  });

  test('without pressure evidence the static swap gate still fails closed', () => {
    const memory = { totalMb: 24576, availableMb: 12163, swapTotalMb: 4096, swapUsedMb: 4000 };
    assert.equal(decideAdmission({ budget, memory, leases: [], requestMb: budget.maxRunMb }).reason, 'swap-pressure');
  });
});

describe('lane reservation (#180)', () => {
  test('a trustworthy peak reserves peak plus margin, capped at the ceiling', () => {
    assert.equal(laneReservationMb(2048, 800), 1056);
    assert.equal(laneReservationMb(2048, 1984), 2048);
    assert.equal(laneReservationMb(2048, 100), 512);
  });

  test('no history reserves the ceiling', () => {
    assert.equal(laneReservationMb(2048, null), 2048);
    assert.equal(laneReservationMb(2048, Number.NaN), 2048);
    assert.equal(laneReservationMb(2048, -5), 2048);
  });

  test('history can lower the reservation but never raise the ceiling', () => {
    assert.ok(laneReservationMb(1024, 5000) <= 1024);
  });

  test('recent peak reads only completed runs of the same lane', () => {
    const history = [
      JSON.stringify({ label: 'test', terminationReason: 'completed', peakRssMb: 900 }),
      JSON.stringify({ label: 'test', terminationReason: 'rss-limit', peakRssMb: 2048 }),
      JSON.stringify({ label: 'other', terminationReason: 'completed', peakRssMb: 1500 }),
      'not json',
      JSON.stringify({ label: 'test', terminationReason: 'completed', peakRssMb: 1100 }),
    ].join('\n');
    assert.equal(recentLanePeakMb(history, 'test'), 1100);
    assert.equal(recentLanePeakMb(history, 'missing'), null);
    assert.equal(recentLanePeakMb('', 'test'), null);
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
