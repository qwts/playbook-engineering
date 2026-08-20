import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  TIMEOUT_EXIT_CODE,
  executeBounded,
} from '../../../.github/actions/bounded-command/bounded-command.mjs';

const fixture = new URL('./fixtures/stubborn-tree.mjs', import.meta.url).pathname;
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/u)[0];
      if (state === 'Z') return false;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

test('successful commands report the consumed attempt', async () => {
  const result = await executeBounded({
    task: 'success fixture',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 1_000,
    stdio: 'ignore',
  });
  assert.equal(result.ok, true);
  assert.equal(result.classification, 'success');
  assert.equal(result.attemptsUsed, 1);
});

test('failed commands consume only the finite configured attempts', async () => {
  const events = [];
  const result = await executeBounded({
    task: 'retry fixture',
    executable: process.execPath,
    args: ['-e', 'process.exit(7)'],
    timeoutMs: 1_000,
    attempts: 2,
    retryDelayMs: 5,
    stdio: 'ignore',
    onAttempt: (event) => events.push(event),
  });
  assert.equal(result.ok, false);
  assert.equal(result.classification, 'exit');
  assert.equal(result.exitCode, 7);
  assert.equal(result.attemptsUsed, 2);
  assert.equal(events.filter(({ phase }) => phase === 'start').length, 2);
});

test('programmatic callers cannot configure zero attempts', async () => {
  await assert.rejects(
    executeBounded({
      task: 'invalid retry fixture',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 1_000,
      attempts: 0,
      stdio: 'ignore',
    }),
    /attempts must be an integer between 1 and 10/u,
  );
});

test('a timed-out command kills its stubborn descendant process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bounded-command-'));
  const pidFile = join(directory, 'descendant.pid');
  const result = await executeBounded({
    task: 'stubborn process tree',
    executable: process.execPath,
    args: [fixture, 'parent', pidFile],
    timeoutMs: 250,
    graceMs: 50,
    stdio: 'ignore',
  });
  assert.equal(result.ok, false);
  assert.equal(result.classification, 'timeout');
  assert.equal(result.exitCode, TIMEOUT_EXIT_CODE);
  await pause(100);
  const descendantPid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.equal(processIsRunning(descendantPid), false, `descendant ${descendantPid} survived timeout`);
});
