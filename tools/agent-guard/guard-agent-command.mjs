#!/usr/bin/env node

// Pre-execution command hook for every agent harness in the fleet.
//
// The wrapper (run-guarded.mjs) is the primary control; this hook exists to
// close the ways around it. It covers Claude Code, Cursor AND Codex, because a
// guard only one harness honours does not solve a problem that Codex sessions
// caused half of.
//
// It denies four things:
//   1. Heavy local suites, for agents, without an owner grant — the lanes that
//      actually bricked the machine (`npm run ci`, e2e, storybook, perf, cov).
//   2. Direct test-binary invocations that skip the wrapper entirely.
//   3. Tampering with the guard's own controls: the human escape hatch, the
//      assume-human override, and redirecting the state directory (which would
//      hand the session a private lease namespace and undo machine scoping).
//   4. Self-granting: `arbiter.mjs grant` is the owner's opt-in.
//
// Scoping: only commands that execute inside a guarded checkout are policed;
// cross-repo work from the same session is left alone. Blocked text inside
// quotes or heredocs is a mention (a commit message, a grep pattern), not an
// invocation — except nested shell payloads (`bash -c "…"`), which are
// executable and are unwrapped and scanned.
//
// Fail-open by design: a malformed payload allows the command rather than
// bricking every shell call.
//
// Protocols: --protocol=claude | cursor | codex

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { HEAVY_LANES, readGrant } from './lib/policy.mjs';

// Two different blocks need two different next steps, and a refusal whose
// advice does not fit is one an agent argues with instead of following.
const GUIDANCE =
  'Push the branch and let GitHub CI verify — CI is the authoritative lane and is exempt from this guard. ' +
  'See docs/reference/agent-memory-guard.md.';

// A direct binary is not necessarily a heavy run — in a tooling repo `node
// --test` is the light, normal path. What is wrong with it is that it skips
// the wrapper, so the fix is the repo's own guarded entrypoint, not CI.
const USE_ENTRYPOINT =
  "Use the repository's npm test entrypoints instead (`npm test`, `npm run test:*`); they wrap " +
  'tools/agent-guard/run-guarded.mjs, which derives a ceiling from this machine and checks the machine-wide ' +
  'memory budget first. See docs/reference/agent-memory-guard.md.';

// Markers that identify a checkout governed by this policy. The second is the
// pre-rollout location, so a repo mid-migration is still policed.
const GUARD_MARKERS = ['tools/agent-guard/run-guarded.mjs', 'scripts/run-guarded.mjs'];

const BLOCKED = [
  {
    // Electron-hosted node:test (image-trail's original incident path).
    pattern: /\belectron\b[^\n;&|]*\s--test(?![\w-])/u,
    what: 'direct `electron --test` invocation',
  },
  {
    pattern: /\bnode\b[^\n;&|]*\s--test(?![\w-])/u,
    what: 'direct `node --test` invocation',
  },
  {
    pattern: /\bnode\b[^\n;&|]*\.test-dist(-dom)?\b/u,
    what: 'direct execution of compiled tests in .test-dist(-dom)',
  },
  {
    pattern: /\bplaywright\s+test\b/u,
    what: 'direct Playwright invocation',
  },
  {
    pattern: /\btest-storybook\b/u,
    what: 'direct Storybook test-runner invocation',
  },
  {
    pattern: /(^|[\s;(&|])(npx\s+)?vitest(?:\s|$)/u,
    what: 'direct Vitest invocation',
  },
  {
    pattern: /(^|[\s;(&|])(npx\s+)?c8\s/u,
    what: 'direct c8 coverage invocation',
  },
  {
    // Inner/unguarded npm scripts (test:dom:run, *:inner).
    pattern: /\bnpm\s+run\s+[\w:.-]*:(run|inner)(?![\w:-])/u,
    what: 'unguarded inner npm script',
  },
  {
    // Headed/interactive runs open GUI windows on the shared desktop.
    pattern: /\bnpm\s+run\s+test:e2e:(ui|headed)(?![\w:-])/u,
    what: 'headed/interactive e2e run',
    reason:
      "Blocked headed/interactive e2e run: GUI windows on the shared desktop steal the owner's focus, " +
      'and each one boots a full Electron app. These scripts are human-only.',
  },
];

// Controls an agent must not touch. Checked before the run-guarded allowlist so
// `AGENT_GUARD_FORCE=1 node tools/agent-guard/run-guarded.mjs …` cannot slip
// through as a sanctioned run.
const TAMPERING = [
  {
    pattern: /\bAGENT_GUARD_FORCE=/u,
    reason:
      'Blocked AGENT_GUARD_FORCE: overriding admission control is a human-only escape hatch. A refused run means the ' +
      `machine does not have the memory right now — report the refusal instead of forcing past it. ${GUIDANCE}`,
  },
  {
    pattern: /\bAGENT_GUARD_ASSUME_HUMAN=/u,
    reason:
      'Blocked AGENT_GUARD_ASSUME_HUMAN: this override exists so a human in an editor terminal is not mistaken for an ' +
      `agent. An agent setting it is claiming to be the owner. ${GUIDANCE}`,
  },
  {
    pattern: /\bAGENT_GUARD_STATE_DIR=/u,
    reason:
      'Blocked AGENT_GUARD_STATE_DIR: redirecting the lease directory gives this session a private budget that no other ' +
      'repo or agent can see — which is exactly the per-worktree bug this guard replaced. It is for tests only.',
  },
  {
    pattern: /\barbiter\.mjs\s+grant\b/u,
    reason:
      'Blocked `arbiter.mjs grant`: the heavy-lane opt-in belongs to the owner. Ask them to run it; an agent granting ' +
      'itself permission is not permission.',
  },
];

function tryRealpath(target) {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

function isWithin(child, parent) {
  const c = tryRealpath(child);
  const p = tryRealpath(parent);
  return c === p || c.startsWith(p + sep);
}

// The directory a command will actually execute in: the tool cwd, adjusted for
// a leading `cd <path> &&` prefix (how agents run commands against another
// checkout from the same session).
export function resolveExecutionDir(cwd, command) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  const match = typeof command === 'string' ? /^\s*cd\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)/u.exec(command) : null;
  if (!match) return cwd;
  let target = match[1] ?? match[2] ?? match[3];
  if (target.startsWith('~')) {
    const home = process.env.HOME;
    if (!home) return cwd;
    target = home + target.slice(1);
  }
  return isAbsolute(target) ? target : resolve(cwd, target);
}

const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/u;
const SHELL_C_TAIL = /(?:^|[\s;&|(`{])(?:env\s+(?:\w+=\S*\s+)*)?(?:ba|da|z)?sh\s+(?:-\S+\s+)*-\S*c\s+$/u;

// Quotes are processed left to right: shell-wrapper payloads are unwrapped so
// the patterns can see them, ordinary quoted text is blanked. Order matters — a
// commit message that merely mentions `bash -c "npm run test:e2e"` is blanked
// before its inner text is ever inspected.
export function stripInertText(command) {
  let scanned = '';
  let rest = command.replace(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?(\n\2(?=\n|$)|$)/gu, ' ');
  for (let i = 0; i < 200; i += 1) {
    const match = QUOTED.exec(rest);
    if (!match) break;
    const quoted = match[0];
    scanned += rest.slice(0, match.index);
    rest = rest.slice(match.index + quoted.length);
    if (SHELL_C_TAIL.test(scanned)) {
      const inner = quoted.startsWith("'") ? quoted.slice(1, -1) : quoted.slice(1, -1).replace(/\\(["\\$`])/gu, '$1');
      rest = `${inner}${rest}`;
    } else {
      scanned += quoted.startsWith("'") ? "''" : '""';
    }
  }
  return scanned + rest;
}

// Codex's shell tool submits argv arrays; the patterns match command text.
export function normalizeCommand(command) {
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return command.join(' ');
  return command;
}

/**
 * Heavy-lane detection for a raw command line.
 *
 * Narrower than lib/policy.mjs's label matching on purpose: a hook sees every
 * shell command an agent runs, so matching the bare word "perf" anywhere would
 * deny `grep perf src/`. Only npm script invocations and the test binaries
 * themselves count here.
 */
export function heavyLaneFor(command) {
  const script = /(^|[\s;(&|])npm\s+(?:run\s+)?([\w:.-]+)/gu;
  for (let match = script.exec(command); match !== null; match = script.exec(command)) {
    const lane = HEAVY_LANES.find((entry) => entry.pattern.test(match[2]));
    if (lane) return lane;
  }
  if (/\bplaywright\s+test\b|\btest-storybook\b/u.test(command)) {
    return HEAVY_LANES.find((entry) => entry.id === 'e2e');
  }
  return null;
}

export function evaluateCommand(command, { env = process.env, now = Date.now() } = {}) {
  if (typeof command !== 'string' || command.length === 0) return { allow: true };
  const effective = stripInertText(command);

  for (const { pattern, reason } of TAMPERING) {
    if (pattern.test(effective)) return { allow: false, reason };
  }

  const lane = heavyLaneFor(effective);
  if (lane && !readGrant(lane.id, env, now)) {
    return {
      allow: false,
      reason:
        `Blocked the "${lane.id}" lane: ${lane.why}, and on a small machine several of these in parallel across repos and ` +
        `agents is what exhausts memory. Agents do not run it locally by default. ${GUIDANCE} ` +
        `If a local run is genuinely required, ask the owner to run: node tools/agent-guard/arbiter.mjs grant ${lane.id} --minutes 30`,
    };
  }

  // Explicit guard invocations are the sanctioned path even when the wrapped
  // command matches a blocked pattern (tampering is checked above).
  if (command.includes('run-guarded.mjs')) return { allow: true };

  for (const { pattern, what, reason } of BLOCKED) {
    if (pattern.test(effective)) {
      return {
        allow: false,
        reason: reason ?? `Blocked ${what}: it bypasses the machine-scoped memory guard. ${USE_ENTRYPOINT}`,
      };
    }
  }
  return { allow: true };
}

// A directory is inside a guarded checkout when a marker exists there or in any
// ancestor — commands routinely run from subdirectories.
function inGuardedCheckout(dir) {
  let current = tryRealpath(dir);
  for (;;) {
    if (GUARD_MARKERS.some((marker) => existsSync(resolve(current, marker)))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function evaluateHookInput({ command, cwd }, projectDir, options = {}) {
  const executionDir = resolveExecutionDir(cwd, command);
  if (executionDir && projectDir) {
    const inScope = isWithin(executionDir, projectDir) || inGuardedCheckout(executionDir);
    if (!inScope) return { allow: true };
  }
  return evaluateCommand(command, options);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function respond(protocol, verdict) {
  if (protocol === 'cursor') {
    const body = verdict.allow
      ? { permission: 'allow' }
      : {
          permission: 'deny',
          agentMessage: verdict.reason,
          userMessage: 'Blocked by the machine memory guard (see docs/reference/agent-memory-guard.md).',
        };
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return;
  }
  if (!verdict.allow) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      })}\n`,
    );
  }
}

async function main() {
  const protocol = process.argv.includes('--protocol=cursor') ? 'cursor' : process.argv.includes('--protocol=codex') ? 'codex' : 'claude';
  // This script lives in the checkout it protects, so its own location is the
  // authoritative project dir (CLAUDE_PROJECT_DIR matches for Claude Code;
  // Cursor and Codex set no equivalent).
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  let verdict = { allow: true };
  try {
    const input = JSON.parse(await readStdin());
    const command = protocol === 'cursor' ? input.command : normalizeCommand(input.tool_input?.command);
    verdict = evaluateHookInput({ command, cwd: input.cwd }, projectDir);
  } catch {
    // Fail open (see header).
  }
  respond(protocol, verdict);
}

const invokedDirectly = process.argv[1] && tryRealpath(resolve(process.argv[1])) === tryRealpath(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
