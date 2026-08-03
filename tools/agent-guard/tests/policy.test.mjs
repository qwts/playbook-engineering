// Who may run what: the CI exemption, the agent-vs-human boundary, the
// heavy-lane table, out-of-band grants, and the command hook that enforces all
// of it across three harnesses.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { evaluateCommand, heavyLaneFor, normalizeCommand, resolveExecutionDir, stripInertText } from '../guard-agent-command.mjs';
import { classifyLane, evaluateLanePolicy, harnessName, isAgentSession, isCi, listGrants, readGrant, revokeGrant, writeGrant } from '../lib/policy.mjs';
import { ensureStateDirs } from '../lib/protocol.mjs';

const roots = [];
let env;

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-guard-policy-'));
  roots.push(root);
  env = { AGENT_GUARD_STATE_DIR: root };
  ensureStateDirs(env);
});

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('CI exemption', () => {
  test('the hosted lanes this org actually uses are detected', () => {
    assert.equal(isCi({ GITHUB_ACTIONS: 'true' }), true);
    assert.equal(isCi({ CI: 'true' }), true);
    assert.equal(isCi({ CI: '1' }), true);
  });

  test('a local machine is not CI', () => {
    assert.equal(isCi({}), false);
    assert.equal(isCi({ CI: 'false' }), false);
  });
});

describe('agent-vs-human detection', () => {
  test('each harness in the fleet is recognised', () => {
    assert.equal(isAgentSession({ CLAUDECODE: '1' }), true);
    assert.equal(isAgentSession({ CODEX_THREAD_ID: 'abc' }), true);
    assert.equal(isAgentSession({ CURSOR_TRACE_ID: 'abc' }), true);
    assert.equal(isAgentSession({ AI_AGENT: 'something-new' }), true);
    assert.equal(harnessName({ CLAUDECODE: '1' }), 'claude');
    assert.equal(harnessName({ CODEX_THREAD_ID: 'abc' }), 'codex');
    assert.equal(harnessName({ CURSOR_TRACE_ID: 'abc' }), 'cursor');
  });

  test('a plain terminal is human', () => {
    assert.equal(isAgentSession({ TERM: 'xterm-256color', SHELL: '/bin/zsh' }), false);
    assert.equal(harnessName({}), 'human');
  });

  test('detection fails CLOSED: an unrecognised agent is still an agent', () => {
    // The inverse of agent-bot-identity's identity resolver, deliberately.
    // Misattributing a human's commit to a bot is the harm there; handing an
    // unrecognised agent a heavy suite is the harm here.
    assert.equal(isAgentSession({ AI_AGENT: 'a-harness-that-did-not-exist-yet' }), true);
  });
});

describe('heavy lanes', () => {
  test('every lane from the incident is classified', () => {
    for (const label of ['test:e2e', 'test:stories:ci', 'test:perf', 'test:cov', 'ci']) {
      assert.notEqual(classifyLane(label), null, `${label} must be recognised as heavy`);
    }
  });

  test('ordinary lanes are not swept up', () => {
    for (const label of ['test:dom', 'lint', 'typecheck', 'build', 'docs:gov']) {
      assert.equal(classifyLane(label), null, `${label} must not be treated as heavy`);
    }
  });

  test('each lane explains why it is heavy, so a refusal is actionable', () => {
    assert.match(classifyLane('test:e2e').why, /Electron/u);
  });
});

describe('lane policy', () => {
  test('an agent is refused the heavy lanes and told to push instead', () => {
    const verdict = evaluateLanePolicy({ label: 'test:e2e', env: { ...env, CLAUDECODE: '1' } });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.message, /Push the branch and let GitHub CI verify/u);
    assert.match(verdict.message, /arbiter\.mjs grant e2e/u);
  });

  test('the owner is never refused by policy', () => {
    assert.equal(evaluateLanePolicy({ label: 'test:e2e', env }).allowed, true);
    assert.equal(evaluateLanePolicy({ label: 'ci', env }).allowed, true);
  });

  test('an agent may run ordinary lanes freely', () => {
    assert.equal(evaluateLanePolicy({ label: 'test:dom', env: { ...env, CLAUDECODE: '1' } }).allowed, true);
  });

  test('an owner grant admits the agent for that lane only', () => {
    writeGrant({ laneId: 'e2e', minutes: 30, env });
    const agent = { ...env, CLAUDECODE: '1' };
    assert.equal(evaluateLanePolicy({ label: 'test:e2e', env: agent }).allowed, true);
    assert.equal(evaluateLanePolicy({ label: 'test:stories:ci', env: agent }).allowed, false, 'a grant is per lane, not a blanket pass');
  });
});

describe('grants', () => {
  test('a grant expires on its own rather than persisting until noticed', () => {
    const now = Date.parse('2026-08-02T12:00:00Z');
    writeGrant({ laneId: 'e2e', minutes: 30, env, now });
    assert.notEqual(readGrant('e2e', env, now + 29 * 60_000), null);
    assert.equal(readGrant('e2e', env, now + 31 * 60_000), null);
  });

  test('an expired grant does not re-admit an agent', () => {
    const now = Date.parse('2026-08-02T12:00:00Z');
    writeGrant({ laneId: 'e2e', minutes: 5, env, now });
    const verdict = evaluateLanePolicy({ label: 'test:e2e', env: { ...env, CLAUDECODE: '1' }, now: now + 10 * 60_000 });
    assert.equal(verdict.allowed, false);
  });

  test('grants can be listed and revoked', () => {
    writeGrant({ laneId: 'e2e', minutes: 30, env });
    assert.equal(listGrants(env).length, 1);
    revokeGrant('e2e', env);
    assert.equal(listGrants(env).length, 0);
  });

  test('a missing grant is null, not a crash', () => {
    assert.equal(readGrant('perf', env), null);
  });
});

describe('command hook', () => {
  const opts = () => ({ env, now: Date.now() });

  test('the exact commands from the incident are denied', () => {
    for (const command of ['npm run ci', 'npm run test:e2e', 'npm run test:stories:ci', 'npm run test:cov']) {
      const verdict = evaluateCommand(command, opts());
      assert.equal(verdict.allow, false, `expected the hook to deny: ${command}`);
      assert.match(verdict.reason, /GitHub CI/u);
    }
  });

  test('direct binaries that skip the wrapper are denied', () => {
    for (const command of [
      'ELECTRON_RUN_AS_NODE=1 electron --test .test-dist/**/*.test.js',
      'node --test .test-dist-dom/index.js',
      'npx playwright test',
      'test-storybook --ci',
      'npm run test:dom:run',
    ]) {
      assert.equal(evaluateCommand(command, opts()).allow, false, `expected the hook to deny: ${command}`);
    }
  });

  test('tampering with the guard is denied, including before a sanctioned wrapper call', () => {
    const force = evaluateCommand('AGENT_GUARD_FORCE=1 node tools/agent-guard/run-guarded.mjs -- npm run test:e2e', opts());
    assert.equal(force.allow, false);
    assert.match(force.reason, /human-only escape hatch/u);

    assert.equal(evaluateCommand('AGENT_GUARD_ASSUME_HUMAN=1 npm run test:e2e', opts()).allow, false);
    assert.equal(evaluateCommand('AGENT_GUARD_STATE_DIR=/tmp/mine npm run test:dom', opts()).allow, false);
  });

  test('an agent cannot grant itself the opt-in', () => {
    const verdict = evaluateCommand('node tools/agent-guard/arbiter.mjs grant e2e --minutes 60', opts());
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /is not permission/u);
  });

  test('an owner grant unblocks the lane at the hook too', () => {
    assert.equal(evaluateCommand('npm run test:e2e', opts()).allow, false);
    writeGrant({ laneId: 'e2e', minutes: 30, env });
    assert.equal(evaluateCommand('npm run test:e2e', opts()).allow, true);
  });

  test('ordinary development commands are untouched', () => {
    for (const command of [
      'npm run lint',
      'npm run typecheck',
      'npm run test:dom',
      'git status --short',
      'gh pr view 137',
      'node tools/agent-guard/arbiter.mjs status',
      'grep -rn perf src/',
      'ls e2e/',
    ]) {
      assert.equal(evaluateCommand(command, opts()).allow, true, `expected the hook to allow: ${command}`);
    }
  });

  test('the sanctioned wrapper path stays open', () => {
    assert.equal(evaluateCommand('node tools/agent-guard/run-guarded.mjs --label test:dom -- npm run test:dom:inner', opts()).allow, true);
  });

  test('a mention inside quotes is not an invocation', () => {
    const commit = 'git commit -m "fix: stop npm run test:e2e from bricking the machine"';
    assert.equal(evaluateCommand(commit, opts()).allow, true);
    assert.equal(evaluateCommand("gh pr create --body 'blocked npm run ci locally'", opts()).allow, true);
  });

  test('a nested shell payload IS an invocation and is unwrapped', () => {
    assert.equal(evaluateCommand('bash -lc "npm run test:e2e"', opts()).allow, false);
  });

  test('a heredoc body is inert', () => {
    assert.equal(evaluateCommand('cat <<EOF\nnpm run test:e2e\nEOF', opts()).allow, true);
  });

  test("Codex's argv arrays are normalized before matching", () => {
    assert.equal(normalizeCommand(['bash', '-lc', 'npm run test:e2e']), 'bash -lc npm run test:e2e');
    assert.equal(evaluateCommand(normalizeCommand(['bash', '-lc', 'npm run test:e2e']), opts()).allow, false);
  });

  test('a malformed command is allowed rather than bricking every shell call', () => {
    assert.equal(evaluateCommand(undefined, opts()).allow, true);
    assert.equal(evaluateCommand('', opts()).allow, true);
    assert.equal(evaluateCommand(42, opts()).allow, true);
  });
});

describe('hook helpers', () => {
  test('a leading cd retargets the execution directory', () => {
    assert.equal(resolveExecutionDir('/a', 'cd /b && npm test'), '/b');
    assert.equal(resolveExecutionDir('/a', 'npm test'), '/a');
    assert.equal(resolveExecutionDir('/a', 'cd sub && npm test'), path.resolve('/a', 'sub'));
  });

  test('quoted text is blanked while shell payloads are promoted', () => {
    assert.match(stripInertText('echo "npm run ci"'), /""/u);
    assert.match(stripInertText('sh -c "npm run ci"'), /npm run ci/u);
  });

  test('heavy-lane matching on a raw command line does not fire on prose', () => {
    // The lane patterns are word-based; a hook sees every command, so matching
    // "perf" anywhere would deny `grep perf src/`.
    assert.equal(heavyLaneFor('grep -rn perf src/'), null);
    assert.equal(heavyLaneFor('cat docs/e2e-notes.md'), null);
    assert.notEqual(heavyLaneFor('npm run test:e2e'), null);
    assert.notEqual(heavyLaneFor('npm run ci'), null);
  });
});
