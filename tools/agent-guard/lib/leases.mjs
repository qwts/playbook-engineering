// The machine-scoped lease store.
//
// This is the file that fixes the core bug. The guard this replaces locked
// `<worktree>/.guard/active.json`, so every worktree, every repo and every
// agent tool got its own lock and each one correctly concluded it was the only
// run on the box. N agents, N locks, one machine, no coordination at all.
// Leases live in ONE directory per machine (lib/protocol.mjs), so a Codex
// session in image-trail and a Claude Code session in overlook are visible to
// each other.
//
// One file per lease, not one shared file: writers never contend, and a
// half-written lease can only ever corrupt itself. Readers tolerate junk.
//
// VALIDITY IS LIVENESS, AND ONLY LIVENESS. A lease is good while its pid is
// alive. It is not keyed on hostname — qwts/overlook#842 is the org's paid
// lesson there: `.local` ↔ `.lan` drift made crashed same-machine locks
// permanently unreclaimable, so the crash-recovery path became the outage. A
// force-quit agent here costs the machine nothing beyond the next reap.

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CORE_LEASE_FIELDS, PROTOCOL_VERSION, ensureStateDirs, leasesDir, machineToken } from './protocol.mjs';

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user — alive.
    return error.code === 'EPERM';
  }
}

function parseLease(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  // Core fields only: a lease written by a newer copy of this tool must still
  // count against the budget, or a mixed-version fleet silently oversubscribes.
  for (const field of CORE_LEASE_FIELDS) {
    if (value[field] === undefined) return null;
  }
  if (!Number.isFinite(value.pid) || !Number.isFinite(value.estimatedMb)) return null;
  return value;
}

/**
 * Every live lease on this machine, reaping the dead ones on the way past.
 *
 * Reaping is a side effect of reading by design: there is no daemon here and
 * there must not be one, so the next run to look is what cleans up after a
 * force-quit agent. `unlink` failures are ignored — another process reaping
 * the same lease concurrently is the expected case, not an error.
 */
export function readLeases(env = process.env, { reap = true } = {}) {
  const dir = leasesDir(env);
  const token = machineToken(env);
  let entries;
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const live = [];
  for (const name of entries) {
    const file = path.join(dir, name);
    let lease;
    try {
      lease = parseLease(readFileSync(file, 'utf8'));
    } catch {
      lease = null;
    }
    // Unparseable, foreign (a restored or copied state directory — see
    // machineToken), or dead: none of these may hold budget.
    const stale = lease === null || (lease.machineToken !== undefined && lease.machineToken !== token) || !isProcessAlive(lease.pid);
    if (stale) {
      if (reap) {
        try {
          rmSync(file, { force: true });
        } catch {
          // Concurrent reap; harmless.
        }
      }
      continue;
    }
    live.push({ ...lease, file });
  }
  return live;
}

function writeLeaseFile(file, lease) {
  // Write-then-rename: a reader never sees a partial lease, which would
  // otherwise be reaped as junk and free budget that is genuinely in use.
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(lease, null, 2)}\n`);
  renameSync(temp, file);
}

export function acquireLease({ env = process.env, label, estimatedMb, repo, worktree, harness, command, pid = process.pid }) {
  ensureStateDirs(env);
  const lease = {
    protocol: PROTOCOL_VERSION,
    id: randomUUID(),
    pid,
    machineToken: machineToken(env),
    label,
    repo,
    worktree,
    harness,
    command,
    estimatedMb,
    observedMb: 0,
    grantedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  const file = path.join(leasesDir(env), `${lease.id}.json`);
  writeLeaseFile(file, lease);
  return { ...lease, file };
}

/**
 * Report the run's real tree RSS into its own lease.
 *
 * This is what keeps the budget honest as a run warms up: the arithmetic in
 * lib/budget.mjs subtracts observed usage from the reservation, because the
 * observed part has already been counted by the kernel in `availableMb`.
 * Without it, a long-running suite would double-count itself and lock the
 * machine down harder the longer it ran.
 */
export function heartbeatLease(lease, observedMb) {
  try {
    writeLeaseFile(lease.file, { ...lease, file: undefined, observedMb, heartbeatAt: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

export function releaseLease(lease) {
  try {
    rmSync(lease.file, { force: true });
    return true;
  } catch {
    return false;
  }
}
