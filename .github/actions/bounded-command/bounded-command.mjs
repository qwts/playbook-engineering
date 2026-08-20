#!/usr/bin/env node

import process from 'node:process';
import { appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TIMEOUT_EXIT_CODE = 124;

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function killPosixGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function killPosixPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function posixDescendants(rootPid) {
  const psExecutable = process.platform === 'darwin' ? '/bin/ps' : '/usr/bin/ps';
  const result = spawnSync(psExecutable, ['-axo', 'pid=,ppid='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error) {
    throw new Error(`cannot enumerate the POSIX process tree: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`cannot enumerate the POSIX process tree: ps exited ${result.status}`);
  }
  const children = new Map();
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }
  const descendants = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length) {
    const pid = pending.pop();
    descendants.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants.reverse();
}

function signalPosixTree(rootPid, descendants, signal) {
  let signaled = killPosixGroup(rootPid, signal);
  for (const pid of descendants) {
    signaled = killPosixPid(pid, signal) || signaled;
  }
  return signaled;
}

async function terminateProcessTree(child, graceMs, platform = process.platform) {
  if (!child.pid) return;
  if (platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  let discoveryError;
  let descendants = [];
  try {
    descendants = posixDescendants(child.pid);
  } catch (error) {
    discoveryError = error;
  }
  if (!signalPosixTree(child.pid, descendants, 'SIGTERM') && !discoveryError) return;
  await delay(graceMs);
  try {
    descendants = [...new Set([...descendants, ...posixDescendants(child.pid)])];
  } catch (error) {
    discoveryError ??= error;
  }
  const remaining = descendants;
  signalPosixTree(child.pid, remaining, 'SIGKILL');
  if (discoveryError) throw discoveryError;
}

function runAttempt({ executable, args, cwd, timeoutMs, graceMs, stdio }) {
  return new Promise((resolveAttempt) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let timer;
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== 'win32',
      shell: false,
      stdio,
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveAttempt({ ...result, elapsedMs: Date.now() - startedAt });
    };

    child.once('error', (error) => {
      finish({ ok: false, classification: 'spawn-error', exitCode: 1, error });
    });
    child.once('exit', (code, signal) => {
      if (timedOut) return;
      if (code === 0) {
        finish({ ok: true, classification: 'success', exitCode: 0, signal });
      } else if (signal) {
        finish({ ok: false, classification: 'signal', exitCode: 1, signal });
      } else {
        finish({ ok: false, classification: 'exit', exitCode: code ?? 1, signal });
      }
    });

    timer = setTimeout(async () => {
      timedOut = true;
      try {
        await terminateProcessTree(child, graceMs);
        finish({ ok: false, classification: 'timeout', exitCode: TIMEOUT_EXIT_CODE });
      } catch (error) {
        finish({ ok: false, classification: 'timeout', exitCode: TIMEOUT_EXIT_CODE, error });
      }
    }, timeoutMs);
  });
}

export async function executeBounded({
  task,
  executable,
  args = [],
  cwd = process.cwd(),
  timeoutMs,
  attempts = 1,
  retryDelayMs = 0,
  graceMs = 10_000,
  stdio = 'inherit',
  onAttempt = () => {},
}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new TypeError('attempts must be an integer between 1 and 10');
  }
  const startedAt = Date.now();
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    onAttempt({ phase: 'start', task, attempt, attempts, timeoutMs });
    result = await runAttempt({ executable, args, cwd, timeoutMs, graceMs, stdio });
    onAttempt({ phase: 'finish', task, attempt, attempts, timeoutMs, result });
    if (result.ok) {
      return { ...result, attemptsUsed: attempt, totalElapsedMs: Date.now() - startedAt };
    }
    if (attempt < attempts) await delay(retryDelayMs);
  }
  return { ...result, attemptsUsed: attempts, totalElapsedMs: Date.now() - startedAt };
}

function integerInput(name, value, { minimum, maximum }) {
  if (!/^\d+$/u.test(value ?? '')) throw new Error(`${name} must be an integer`);
  const number = Number(value);
  if (number < minimum || number > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function argumentsInput(value) {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((argument) => typeof argument !== 'string')) {
    throw new Error('arguments-json must be a JSON array of strings');
  }
  return parsed;
}

function workflowEscape(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function annotation(kind, title, message) {
  process.stdout.write(`::${kind} title=${workflowEscape(title)}::${workflowEscape(message)}\n`);
}

function writeOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `classification=${result.classification}\nattempts-used=${result.attemptsUsed}\nelapsed-ms=${result.totalElapsedMs}\n`,
  );
}

async function main() {
  const task = process.env.BOUNDED_TASK?.trim();
  const executable = process.env.BOUNDED_EXECUTABLE?.trim();
  if (!task) throw new Error('task is required');
  if (!executable) throw new Error('executable is required');
  const timeoutSeconds = integerInput('timeout-seconds', process.env.BOUNDED_TIMEOUT_SECONDS, {
    minimum: 1,
    maximum: 86_400,
  });
  const attempts = integerInput('attempts', process.env.BOUNDED_ATTEMPTS ?? '1', {
    minimum: 1,
    maximum: 10,
  });
  const retryDelaySeconds = integerInput(
    'retry-delay-seconds',
    process.env.BOUNDED_RETRY_DELAY_SECONDS ?? '0',
    { minimum: 0, maximum: 3_600 },
  );
  const graceSeconds = integerInput(
    'termination-grace-seconds',
    process.env.BOUNDED_TERMINATION_GRACE_SECONDS ?? '10',
    { minimum: 0, maximum: 60 },
  );
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const requestedCwd = process.env.BOUNDED_WORKING_DIRECTORY ?? '.';
  const cwd = isAbsolute(requestedCwd) ? requestedCwd : resolve(workspace, requestedCwd);
  const args = argumentsInput(process.env.BOUNDED_ARGUMENTS_JSON ?? '[]');

  const result = await executeBounded({
    task,
    executable,
    args,
    cwd,
    timeoutMs: timeoutSeconds * 1_000,
    attempts,
    retryDelayMs: retryDelaySeconds * 1_000,
    graceMs: graceSeconds * 1_000,
    onAttempt(event) {
      if (event.phase === 'start') {
        process.stdout.write(
          `${task}: attempt ${event.attempt}/${event.attempts}; deadline ${timeoutSeconds}s\n`,
        );
      } else if (!event.result.ok && event.attempt < event.attempts) {
        annotation(
          'warning',
          `${task} attempt failed`,
          `classification=${event.result.classification}; elapsed=${event.result.elapsedMs}ms; retrying`,
        );
      }
    },
  });
  writeOutputs(result);
  if (result.ok) return;
  annotation(
    'error',
    `${task} failed`,
    `classification=${result.classification}; attempts=${result.attemptsUsed}; elapsed=${result.totalElapsedMs}ms; ` +
      `per-attempt-deadline=${timeoutSeconds}s; cleanup=${result.error ? 'incomplete' : 'complete'}`,
  );
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    annotation('error', 'Bounded command configuration error', error.stack ?? error.message);
    process.exitCode = 2;
  });
}
