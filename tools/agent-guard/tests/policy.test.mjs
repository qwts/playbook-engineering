// Who may run what: the CI exemption, the agent-vs-human boundary, the
// heavy-lane table, non-delegable human boundary, and the command hook that
// enforces all of it across three harnesses.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { evaluateCommand, evaluateHookInput, heavyLaneFor, nodeRunScriptNames, normalizeCommand, npmScriptNames, otherPackageScriptNames, resolveExecutionDir, resolveExecutionDirs, splitSegments, stripInertText } from '../guard-agent-command.mjs';
import { classifyLane, evaluateLanePolicy, harnessName, isAgentSession, isCi, listGrants, readGrant, revokeGrant, writeGrant } from '../lib/policy.mjs';
import { ensureStateDirs, stateDir } from '../lib/protocol.mjs';

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

describe('CI markers', () => {
  test('the hosted lanes this org actually uses are detected', () => {
    assert.equal(isCi({ GITHUB_ACTIONS: 'true' }), true);
    assert.equal(isCi({ CI: 'true' }), true);
    assert.equal(isCi({ CI: '1' }), true);
  });

  test('a local machine is not CI', () => {
    assert.equal(isCi({}), false);
    assert.equal(isCi({ CI: 'false' }), false);
  });

  test('hosted markers, runner paths, and job credentials never authorize a heavy lane', () => {
    for (const runnerRoot of ['/home/runner/work', '/Users/runner/work']) {
      const hosted = {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        GITHUB_WORKSPACE: `${runnerRoot}/repo/repo`,
        RUNNER_TEMP: `${runnerRoot}/_temp`,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://vstoken.actions.githubusercontent.com/oidc',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'replayable-job-credential',
      };
      assert.equal(isCi(hosted), true);
      assert.equal(evaluateLanePolicy({ label: 'test:e2e', env: hosted }).allowed, false);
    }
  });

  test('production state cannot be redirected through process environment paths', () => {
    assert.doesNotMatch(stateDir(process.env), /agent-guard-policy-/u);
    assert.equal(stateDir({ ...process.env, AGENT_GUARD_STATE_DIR: env.AGENT_GUARD_STATE_DIR }), env.AGENT_GUARD_STATE_DIR);
  });
});

describe('agent-vs-human detection', () => {
  test('each harness in the fleet is recognised', () => {
    assert.equal(isAgentSession({ CLAUDECODE: '1' }), true);
    assert.equal(isAgentSession({ CODEX_THREAD_ID: 'abc' }), true);
    assert.equal(isAgentSession({ CURSOR_TRACE_ID: 'abc' }), true);
    assert.equal(isAgentSession({ AI_AGENT: 'something-new' }), true);
    assert.equal(isAgentSession({ AGENT_GUARD_ASSUME_HUMAN: '1', AI_AGENT: 'codex' }), true);
    assert.equal(harnessName({ CLAUDECODE: '1' }), 'claude');
    assert.equal(harnessName({ CODEX_THREAD_ID: 'abc' }), 'codex');
    assert.equal(harnessName({ CURSOR_TRACE_ID: 'abc' }), 'cursor');
  });

  test('an unmarked local caller fails closed', () => {
    assert.equal(isAgentSession({ TERM: 'xterm-256color', SHELL: '/bin/zsh' }), true);
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
    assert.match(verdict.message, /owner can open a window from their own \(non-agent\) terminal/u);
  });

  test('an unmarked local caller cannot claim human authentication', () => {
    assert.equal(evaluateLanePolicy({ label: 'test:e2e', env }).allowed, false);
    assert.equal(evaluateLanePolicy({ label: 'ci', env }).allowed, false);
  });

  test('an agent may run ordinary lanes freely', () => {
    assert.equal(evaluateLanePolicy({ label: 'test:dom', env: { ...env, CLAUDECODE: '1' } }).allowed, true);
  });

  test('a same-user grant file never admits an agent', () => {
    writeGrant({ laneId: 'e2e', minutes: 30, env });
    const agent = { ...env, CLAUDECODE: '1' };
    assert.equal(evaluateLanePolicy({ label: 'test:e2e', env: agent }).allowed, false);
    assert.equal(evaluateLanePolicy({ label: 'test:stories:ci', env: agent }).allowed, false);
  });

  test('a live grant in an unmarked session is the owner path (#180)', () => {
    // Grants cannot be minted from agent sessions (the hook denies arbiter
    // grant) and markers cannot be scrubbed (the hook denies identity
    // removal), so unmarked + grant is owner evidence. Enforcement — lease,
    // ceiling, timeout, admission — still applies to the granted run.
    writeGrant({ laneId: 'e2e', minutes: 30, env });
    const verdict = evaluateLanePolicy({ label: 'test:e2e', env });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.actor, 'owner-grant');
    // Lane-scoped: the e2e grant says nothing about ci.
    assert.equal(evaluateLanePolicy({ label: 'ci', env }).allowed, false);
  });

  test('an expired grant is not an owner path', () => {
    const now = Date.parse('2026-08-02T12:00:00Z');
    writeGrant({ laneId: 'e2e', minutes: 5, env, now });
    assert.equal(evaluateLanePolicy({ label: 'test:e2e', env, now: now + 4 * 60_000 }).allowed, true);
    assert.equal(evaluateLanePolicy({ label: 'test:e2e', env, now: now + 10 * 60_000 }).allowed, false);
  });

  test('the refusal tells the owner how to open a granted window', () => {
    const verdict = evaluateLanePolicy({ label: 'test:e2e', env: { ...env, CLAUDECODE: '1' } });
    assert.match(verdict.message, /arbiter\.mjs grant e2e/u);
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
    assert.equal(revokeGrant('e2e', env), true);
    assert.equal(listGrants(env).length, 0);
    assert.equal(revokeGrant('e2e', env), false, 'a missing grant is not reported as revoked');
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

  test('subshell grouping cannot hide a heavy lane or direct binary', () => {
    for (const command of ['(npm run ci)', '(npm run test:e2e)', '(npx vitest)', '((npm run ci))', '(npx vitest) >/tmp/out', '{ npx vitest; }']) {
      assert.equal(evaluateCommand(command, opts()).allow, false, `expected the hook to deny: ${command}`);
    }
  });

  test('direct binaries that skip the wrapper are denied', () => {
    for (const command of [
      'ELECTRON_RUN_AS_NODE=1 electron --test .test-dist/**/*.test.js',
      'node --test .test-dist-dom/index.js',
      'npx playwright test',
      'test-storybook --ci',
      './node_modules/.bin/vitest run src/example.test.ts',
      'node_modules/.bin/c8 node script.js',
      'node node_modules/vitest/vitest.mjs run',
      'node "node_modules/vitest/vitest.mjs" run',
      '"/usr/bin/npm" run ci',
      '"/usr/bin/env" npm run ci',
      "'./node_modules/.bin/vitest' run",
      "'/usr/bin/bash' -c 'npm run ci'",
      'npm exec -- vitest run src/example.test.ts',
      'npm x -- c8 node script.js',
      'npm --silent exec -- vitest',
      'npm --workspace app exec -- vitest',
      'pnpm exec vitest',
      'pnpm dlx vitest',
      'yarn exec vitest',
      'yarn dlx vitest',
      'bunx vitest',
      'bun x vitest',
      'npx --package vitest vitest',
      'nice vitest',
      'nice -n 5 vitest',
      'nohup vitest',
      'exec vitest',
      'timeout 60s npx vitest',
      'watch npx vitest',
      "watch -n 1 'npx vitest'",
      'watch "npm run ci"',
      'watch --exec npx vitest',
      'printf x | xargs npx vitest',
      'xargs -a inputs npx vitest',
      'xargs --arg-file=inputs npx vitest',
      'xargs -I{} npx vitest {}',
      "printf x | xargs 'npx' vitest",
      "printf 'ci\\n' | xargs npm run",
      "printf 'vitest\\n' | xargs npx",
      'find . -maxdepth 0 -exec npm run ci \\;',
      'find . -maxdepth 0 -exec npx vitest {} +',
      'command find . -maxdepth 0 -exec npx vitest \\;',
      'env find . -maxdepth 0 -exec npm run ci \\;',
      "find . -maxdepth 0 -exec sh -c 'npm run ci' \\;",
      'lane=ci; npm run "$lane"',
      'npm run "$(printf ci)"',
      'runner=npm; $runner run ci',
      'name=vitest; npx $name',
      'verb=run; npm "$verb" test:inner',
      'npm r${x:-u}n ci',
      'if true; then npm run ci; fi',
      'f(){ npm run test:e2e; }; f',
      'case x in x) npx vitest;; esac',
      'coproc npx vitest',
      'runner () { npx vitest; }; runner',
      "bash <<< 'npm run ci'",
      "printf 'npm run ci\\n' | sh",
      'cat <<EOF | bash\nnpm run ci\nEOF',
      'find . -maxdepth 0 -exec bash -c npx\\ vitest \\;',
      "find . '-exec' npm run ci \\;",
      'find . -exec "npm" run ci \\;',
      "payload='npm run ci'; bash -c \"$payload\"",
      'npx npm run ci',
      'bunx npm run ci',
      'pnpm exec npm run ci',
      'printf x | xargs --replace npm run ci',
      'node --require node:path node_modules/vitest/vitest.mjs run',
      'node -r node:path node_modules/vitest/vitest.mjs run',
      'node --import node:path node_modules/vitest/vitest.mjs run',
      'node --require=node:path node_modules/vitest/vitest.mjs run',
      "eval -- 'npx vitest'",
      'cat <(npx vitest)',
      'diff <(npm run ci) /dev/null',
      'tee >(npx vitest)',
      'setsid npx vitest',
      'stdbuf -oL npx vitest',
      'time npx vitest',
      'env FOO=1 npx c8 vitest run',
      'command ./node_modules/.bin/vitest run src/example.test.ts',
      'npm run test:dom:run',
      'npm run-script test:inner',
      'npm rum test:inner',
      'npm run -w pkg test:inner',
    ]) {
      assert.equal(evaluateCommand(command, opts()).allow, false, `expected the hook to deny: ${command}`);
    }
  });

  test('direct binaries select the matching grant lane', () => {
    assert.equal(heavyLaneFor('npx playwright test')?.id, 'e2e');
    assert.equal(heavyLaneFor('test-storybook --ci')?.id, 'stories');
  });

  test('tampering with the guard is denied, including before a sanctioned wrapper call', () => {
    const force = evaluateCommand('AGENT_GUARD_FORCE=1 node tools/agent-guard/run-guarded.mjs -- npm run test:e2e', opts());
    assert.equal(force.allow, false);
    assert.match(force.reason, /human-only escape hatch/u);

    assert.equal(evaluateCommand('AGENT_GUARD_ASSUME_HUMAN=1 npm run test:e2e', opts()).allow, false);
    assert.equal(evaluateCommand('AGENT_GUARD_STATE_DIR=/tmp/mine npm run test:dom', opts()).allow, false);
    assert.equal(evaluateCommand('CI=true npm test', opts()).allow, false);
    assert.equal(evaluateCommand('env -i PATH=/usr/bin:/bin HOME=/tmp node tools/agent-guard/run-guarded.mjs --label test:e2e -- npm run test:e2e', opts()).allow, false);
    assert.equal(evaluateCommand('env - PATH=/usr/bin:/bin HOME=/tmp node tools/agent-guard/run-guarded.mjs --label test:e2e -- npm run test:e2e', opts()).allow, false);
    assert.equal(evaluateCommand('env -u CODEX_THREAD_ID node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
    assert.equal(evaluateCommand('env -uCODEX_THREAD_ID node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
    assert.equal(evaluateCommand('key=AI_AGENT; env -u "$key" node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
    assert.equal(evaluateCommand('unset -- AI_AGENT; node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
    assert.equal(evaluateCommand('unset -v AI_AGENT; node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
    assert.equal(evaluateCommand('name=CI; export "$name=true"; node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
    assert.equal(evaluateCommand('printf -v CI 1; export CI; node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
    assert.equal(evaluateCommand('unset CLAUDECODE; node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
    assert.equal(evaluateCommand('AI_AGENT= node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
    assert.equal(evaluateCommand('CLAUDECODE=0 CLAUDE_CODE_ENTRYPOINT= node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
    assert.equal(evaluateCommand('CODEX_THREAD_ID= node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
  });

  test('an agent cannot grant itself the opt-in', () => {
    const verdict = evaluateCommand('node tools/agent-guard/arbiter.mjs grant e2e --minutes 60', opts());
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /cannot authenticate human approval/u);
  });

  test('a forged grant does not unblock the lane at the hook', () => {
    assert.equal(evaluateCommand('npm run test:e2e', opts()).allow, false);
    writeGrant({ laneId: 'e2e', minutes: 30, env });
    assert.equal(evaluateCommand('npm run test:e2e', opts()).allow, false);
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
      'npm ci',
    ]) {
      assert.equal(evaluateCommand(command, opts()).allow, true, `expected the hook to allow: ${command}`);
    }
  });

  test('the sanctioned wrapper path stays open', () => {
    assert.equal(evaluateCommand('node tools/agent-guard/run-guarded.mjs --label test:dom -- npm run test:dom:inner', opts()).allow, true);
  });

  // PR #139 review, P1: the wrapper allowlist vouched for the whole command
  // line, so anything sharing it rode along.
  test('a wrapper invocation does not vouch for its neighbours', () => {
    for (const command of [
      'echo run-guarded.mjs; node --test .test-dist/index.test.js',
      'node tools/agent-guard/run-guarded.mjs --label x -- npm run lint && node --test foo.js',
      'node tools/agent-guard/run-guarded.mjs --label x -- npm run lint | npx playwright test',
    ]) {
      assert.equal(evaluateCommand(command, opts()).allow, false, `expected the hook to deny: ${command}`);
    }
  });

  test('merely naming the wrapper does not sanction a segment', () => {
    assert.equal(evaluateCommand('echo "see run-guarded.mjs" && node --test x.js', opts()).allow, false);
    assert.equal(evaluateCommand('node fake-run-guarded.mjs -- npx vitest', opts()).allow, false);
    assert.equal(evaluateCommand('env FOO=1 node fake-run-guarded.mjs -- npx vitest', opts()).allow, false);
    assert.equal(evaluateCommand('time node fake-run-guarded.mjs -- npx vitest', opts()).allow, false);
    assert.equal(evaluateCommand('command node fake-run-guarded.mjs -- npx vitest', opts()).allow, false);
  });

  // PR #139 review, P1: npm's own aliases and option forms walked past the
  // heavy-lane matcher.
  test('heavy lanes are caught under every npm spelling', () => {
    for (const command of [
      'npm run-script test:e2e',
      'npm rum test:e2e',
      'npm urn ci',
      'npm run --silent test:e2e',
      'npm --silent run test:stories:ci',
      'npm --workspace pkg run test:e2e',
      'npm run -w pkg ci',
      'npm run --workspace pkg test:e2e',
      'node --run ci',
      'node --run=test:e2e',
    ]) {
      assert.equal(evaluateCommand(command, opts()).allow, false, `expected the hook to deny: ${command}`);
    }
  });

  test('heavy lanes are caught under other package managers', () => {
    for (const command of [
      'pnpm run test:e2e',
      'pnpm --filter app run ci',
      'yarn run test:stories:ci',
      'yarn test:cov',
      'bun run test:perf',
      'yarn workspace app test:e2e',
      'yarn workspace app run test:e2e',
      'bun -F app test:e2e',
      'bun --filter=app test:e2e',
      'yarn workspaces foreach -Apt run ci',
      'yarn workspaces foreach -A npm run ci',
      "yarn workspaces foreach -A 'npm' run ci",
      'yarn workspaces foreach -A npx vitest',
      'corepack yarn run test:e2e',
      'corepack yarn run "test:e2e"',
      "corepack 'yarn' run test:e2e",
      'corepack pnpm run ci',
      'corepack pnpm exec vitest',
      'pnpm run "ci"',
      'yarn run "test:e2e"',
      'bun run "coverage"',
    ]) {
      assert.equal(evaluateCommand(command, opts()).allow, false, `expected the hook to deny: ${command}`);
    }
  });

  test('quoting executable words does not bypass the guard', () => {
    for (const command of [
      'npm run "ci"',
      "npm run 'test:e2e'",
      'npx "vitest" run src/example.test.ts',
      'npx "playwright" test',
      'node "--test" tests/example.test.mjs',
      'bash -lc "npm run \\"ci\\""',
      'node --run "ci"',
      'npm run c""i',
      'npm run "c"i',
      'n\\pm run c\\i',
      "npm run $'ci'",
      "npm run $'\\x63\\x69'",
      "n$'px' vitest",
      "ba\\sh -c 'npm run ci'",
    ]) {
      assert.equal(evaluateCommand(command, opts()).allow, false, `expected the hook to deny: ${command}`);
    }
  });

  // PR #139 review, P1: AGENT_GUARDED=1 made the wrapper pass through with no
  // lease, ceiling or headroom check.
  test('claiming to be inside a guarded run is tampering', () => {
    const verdict = evaluateCommand('AGENT_GUARDED=1 node tools/agent-guard/run-guarded.mjs --label test:dom -- npm run test:dom:inner', opts());
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /guarded run that does not exist/u);
  });

  test('a mention inside quotes is not an invocation', () => {
    const commit = 'git commit -m "fix: stop npm run test:e2e from bricking the machine"';
    assert.equal(evaluateCommand(commit, opts()).allow, true);
    assert.equal(evaluateCommand("gh pr create --body 'blocked npm run ci locally'", opts()).allow, true);
    assert.equal(evaluateCommand('git commit -m "ci"', opts()).allow, true);
    assert.equal(evaluateCommand('gh pr create --body "vitest"', opts()).allow, true);
  });

  test('direct-binary names in non-executable positions remain ordinary text', () => {
    assert.equal(evaluateCommand('rg vitest', opts()).allow, true);
    assert.equal(evaluateCommand('npm run lint -- --grep vitest', opts()).allow, true);
  });

  test('a nested shell payload IS an invocation and is unwrapped', () => {
    assert.equal(evaluateCommand('bash -lc "npm run test:e2e"', opts()).allow, false);
    assert.equal(evaluateCommand('/bin/bash -lc "npm run test:e2e"', opts()).allow, false);
    assert.equal(evaluateCommand('bash -o pipefail -c "npm run test:e2e"', opts()).allow, false);
    assert.equal(evaluateCommand('bash -euxo pipefail -c "npm run test:e2e"', opts()).allow, false);
    assert.equal(evaluateCommand('bash -c "npx vitest"', opts()).allow, false);
    assert.equal(evaluateCommand('sh -c "vitest run"', opts()).allow, false);
    assert.equal(evaluateCommand('bash -c npx\\ vitest', opts()).allow, false);
    assert.equal(evaluateCommand("command sh -c 'npm run ci'", opts()).allow, false);
    assert.equal(evaluateCommand("nice sh -c 'npm run ci'", opts()).allow, false);
    assert.equal(evaluateCommand("env -i sh -c 'npm run ci'", opts()).allow, false);
    assert.equal(evaluateCommand("time bash -c 'npx vitest'", opts()).allow, false);
    assert.equal(evaluateCommand("nohup bash -c 'npx vitest'", opts()).allow, false);
    assert.equal(evaluateCommand("bash -cl 'npx vitest'", opts()).allow, false);
  });

  test('quoted runtime executables and command-launching prefixes are classified', () => {
    for (const command of [
      '"python3" -c \'import os; os.system("npm run ci")\'',
      '"perl" -e \'system q(npm run ci)\'',
      '"ruby" -e \'system %q(npm run ci)\'',
      '"php" -r \'system("npm run ci");\'',
      '"awk" \'BEGIN { system("npm run ci") }\'',
      '"find" . -maxdepth 0 -exec npm run ci \\;',
      '"script" -q /dev/null -c \'npm run ci\'',
      'ionice npm run ci',
      'parallel npm run ci -- x',
    ]) assert.equal(evaluateCommand(command, opts()).allow, false, `expected the hook to deny: ${command}`);
  });

  test('eval and package-manager command strings are scanned as commands', () => {
    assert.equal(evaluateCommand("eval 'npm run ci'", opts()).allow, false);
    assert.equal(evaluateCommand("eval 'node --test'", opts()).allow, false);
    assert.equal(evaluateCommand('npm exec -c "npx vitest"', opts()).allow, false);
    assert.equal(evaluateCommand("npm exec --call 'vitest'", opts()).allow, false);
    assert.equal(evaluateCommand('npm exec --call=npx\\ vitest', opts()).allow, false);
    assert.equal(evaluateCommand("npm exec --call='npx vitest'", opts()).allow, false);
    assert.equal(evaluateCommand("npm exec -c='npx vitest'", opts()).allow, false);
    assert.equal(evaluateCommand("env -S 'npx vitest'", opts()).allow, false);
    assert.equal(evaluateCommand("env --split-string='npx vitest'", opts()).allow, false);
    assert.equal(evaluateCommand('env -S npx\\ vitest', opts()).allow, false);
  });

  test('a heredoc body is inert', () => {
    assert.equal(evaluateCommand('cat <<EOF\nnpm run test:e2e\nEOF', opts()).allow, true);
    assert.equal(evaluateCommand('bash <<EOF\nnpm run test:e2e\nEOF', opts()).allow, false);
    assert.equal(evaluateCommand("/bin/sh <<'EOF'\nnpx vitest\nEOF", opts()).allow, false);
    assert.equal(evaluateCommand("command bash <<'EOF'\nnpx vitest\nEOF", opts()).allow, false);
    assert.equal(evaluateCommand("env bash <<'EOF'\nnpm run ci\nEOF", opts()).allow, false);
    assert.equal(evaluateCommand("cat > /tmp/doc <<'EOF'\nnpm run \"$lane\"\nEOF", opts()).allow, true);
    assert.equal(evaluateCommand("cat > /tmp/doc <<'0'\nnpm run \"$lane\"\n0", opts()).allow, true);
    assert.equal(evaluateCommand("cat > /tmp/doc <<'END-OF-FILE'\nnpm run \"$lane\"\nEND-OF-FILE", opts()).allow, true);
    assert.equal(evaluateCommand('cat > /tmp/doc <<.\nnpm run "$lane"\n.', opts()).allow, true);
    assert.equal(evaluateCommand('cat <<\\EOF\nharmless\nEOF\nnpm run ci', opts()).allow, false);
    assert.equal(evaluateCommand('cat <<E"O"F\nharmless\nEOF\nnpm run ci', opts()).allow, false);
    assert.equal(evaluateCommand('cat <<-EOF\nharmless\n\tEOF\nnpm run ci', opts()).allow, false);
    assert.equal(evaluateCommand("cat <<$'E\\x4fF'\nharmless\nEOF\nnpm run ci", opts()).allow, false);
    assert.equal(evaluateCommand("python3 <<'PY'\nimport os\nos.system('npm run ci')\nPY", opts()).allow, false);
    assert.equal(evaluateCommand("node <<< \"require('node:child_process').execSync('npm run ci')\"", opts()).allow, false);
    assert.equal(evaluateCommand('printf x | node', opts()).allow, false);
    assert.equal(evaluateCommand('cat <<FIRST <<SECOND\nnpm run ci\nFIRST\nnpx vitest\nSECOND', opts()).allow, true);
  });

  test('runtime option parsing cannot mistake option operands for scripts', () => {
    assert.equal(evaluateCommand("python -qc 'import os; os.system(\"npm run ci\")'", opts()).allow, false);
    assert.equal(evaluateCommand("python -Bc 'import os; os.system(\"npm run ci\")'", opts()).allow, false);
    assert.equal(evaluateCommand('printf x | python -W ignore', opts()).allow, false);
    assert.equal(evaluateCommand('printf x | python -X dev', opts()).allow, false);
  });

  test('runtime script files and tar command actions stay behind approval', () => {
    assert.equal(evaluateCommand("printf 'npm run ci\\n' > /tmp/lane.sh && bash /tmp/lane.sh", opts()).allow, false);
    assert.equal(evaluateCommand("printf 'child_process.execSync(\"npm run ci\")' > /tmp/lane.js && node /tmp/lane.js", opts()).allow, false);
    assert.equal(evaluateCommand('python tools/task.py', opts()).allow, false);
    assert.equal(evaluateCommand("tar -cf /tmp/a.tar --checkpoint=1 --checkpoint-action=exec='npm run ci' README.md", opts()).allow, false);
  });

  test('a script generated and dispatched in one line is denied before it exists (#189)', () => {
    assert.equal(evaluateCommand("printf 'npx vitest\\n' > lane && chmod +x lane && ./lane", opts()).allow, false);
    assert.equal(evaluateCommand("printf 'npx vitest\\n' > lane\nchmod +x lane\n./lane", opts()).allow, false);
    assert.equal(evaluateCommand('./lane "$(printf x > lane)"', opts()).allow, false);
    // A quoted whitespace pathname blanks to a bare quote pair before the
    // scan; in a compound line that is still a dispatch nothing inspected.
    assert.equal(evaluateCommand("printf 'npx vitest\\n' > 'la ne' && chmod +x 'la ne' && './la ne'", opts()).allow, false);
    assert.equal(evaluateCommand("'./la ne'", opts()).allow, true);
    // A first-segment dispatch of a nonexistent path has no creator, and a
    // relative path in argument position is data: both stay allowed.
    assert.equal(evaluateCommand('./does-not-exist-here', opts()).allow, true);
    assert.equal(evaluateCommand("printf 'x\\n' > lane && wc -l lane", opts()).allow, true);
  });

  test('checked-in Node helpers pass by reviewed provenance; edits and additions do not (#191)', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'agent-guard-provenance-'));
    roots.push(repo);
    const git = (...args) =>
      execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'ignore' });
    git('init', '--quiet');
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, 'scripts', 'check-traceability.mjs'), 'process.exit(0);\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'helper');
    const local = { ...opts(), cwd: repo };
    // Without fetched origin refs there is no reviewed base: HEAD moves
    // with any local commit, so provenance fails closed.
    assert.equal(evaluateCommand('node scripts/check-traceability.mjs', local).allow, false);
    // A fetched remote default branch is the trust anchor.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    // The cartograph/quorum shapes: documented checked-in helpers run.
    assert.equal(evaluateCommand('node scripts/check-traceability.mjs', local).allow, true);
    assert.equal(evaluateCommand('node scripts/check-traceability.mjs --json', local).allow, true);
    // Provenance vouches only for a substitution-free first segment: an
    // earlier segment can cd away from the hook's cwd or rewrite the file,
    // and a substitution executes before the runtime does.
    assert.equal(evaluateCommand('cd tmp && node scripts/check-traceability.mjs', local).allow, false);
    assert.equal(
      evaluateCommand("printf 'x' > scripts/check-traceability.mjs && node scripts/check-traceability.mjs", local).allow,
      false
    );
    assert.equal(evaluateCommand('node scripts/check-traceability.mjs $(date)', local).allow, false);
    // A double-quoted substitution is promoted to a *trailing* segment by
    // stripInertText although it executes first — segment count, not
    // order, is what fails closed here.
    assert.equal(
      evaluateCommand('node scripts/check-traceability.mjs "$(printf x > scripts/check-traceability.mjs)"', local).allow,
      false
    );
    // An edited helper no longer matches the reviewed blob: denied.
    writeFileSync(path.join(repo, 'scripts', 'check-traceability.mjs'), "require('child_process').execSync('npx vitest');\n");
    assert.equal(evaluateCommand('node scripts/check-traceability.mjs', local).allow, false);
    // A new script is not reviewed, staged or not — git add is agent-editable.
    writeFileSync(path.join(repo, 'scripts', 'fresh.mjs'), 'process.exit(0);\n');
    assert.equal(evaluateCommand('node scripts/fresh.mjs', local).allow, false);
    git('add', '-A');
    assert.equal(evaluateCommand('node scripts/fresh.mjs', local).allow, false);
    // Outside any checkout there is no provenance: denied as before.
    assert.equal(evaluateCommand('node /tmp/lane.js', local).allow, false);
    // Non-node runtimes keep the existing policy even when checked in.
    writeFileSync(path.join(repo, 'scripts', 'task.py'), 'raise SystemExit\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'python helper');
    assert.equal(evaluateCommand('python scripts/task.py', local).allow, false);
    // Local commits move HEAD, not the reviewed base: the freshly committed
    // script and the committed edit both stay denied.
    assert.equal(evaluateCommand('node scripts/fresh.mjs', local).allow, false);
    assert.equal(evaluateCommand('node scripts/check-traceability.mjs', local).allow, false);
  });

  test('Node environment preloads and direct shell scripts stay behind approval', () => {
    assert.equal(evaluateCommand('NODE_OPTIONS=--require=/tmp/preload.cjs npm run lint', opts()).allow, false);
    assert.equal(evaluateCommand("env 'NODE_OPTIONS=--import=data:text/javascript,export default 1' npm run lint", opts()).allow, false);
    assert.equal(evaluateCommand('. /tmp/lane', opts()).allow, false);
    const lane = path.join(env.AGENT_GUARD_STATE_DIR, 'lane');
    writeFileSync(lane, '#!/bin/sh\nnpx vitest\n');
    assert.equal(evaluateCommand(lane, { ...opts(), cwd: env.AGENT_GUARD_STATE_DIR }).allow, false);
    assert.equal(evaluateCommand('BASH_ENV=/tmp/preload.sh bash -c true', opts()).allow, false);
    assert.equal(evaluateCommand('PATH=/tmp:$PATH npm run lint', opts()).allow, false);
    // Wrapper option operands must not end the scan while a quoted
    // assignment still follows (sudo run form: … [-u user] [VAR=value] …).
    assert.equal(evaluateCommand("sudo -u root 'NODE_OPTIONS=--require=/tmp/preload.cjs' npm run lint", opts()).allow, false);
    assert.equal(evaluateCommand("env -u FOO 'PATH=/tmp' npm run lint", opts()).allow, false);
    assert.equal(evaluateCommand("timeout -s TERM 5 env 'BASH_ENV=/tmp/preload.sh' bash -c true", opts()).allow, false);
  });

  test('authoritative lease state is inaccessible to agent commands', () => {
    assert.equal(evaluateCommand('rm -rf ~/.cache/agent-guard/leases', opts()).allow, false);
    assert.equal(evaluateCommand(': > ~/Library/Caches/agent-guard/leases/live.json', opts()).allow, false);
    assert.equal(evaluateCommand('rm -rf ~/.cache/agent{-,}-guard/leases', opts()).allow, false);
    assert.equal(evaluateCommand('rm -rf ~/.cache/agent*-guard/leases', opts()).allow, false);
    assert.equal(evaluateCommand('rm -rf ~/.cache/agent-guard', opts()).allow, false);
    assert.equal(evaluateCommand('rm -rf ~/.cache/agent-guard/./leases', opts()).allow, false);
    assert.equal(evaluateCommand('rm -rf ~/.cache/agent-guard/foo/../leases', opts()).allow, false);
    assert.equal(evaluateCommand('rm -rf ~/.cache/agen[t]-guard/leases', opts()).allow, false);
    assert.equal(evaluateCommand('rm -rf ~/.cache/agent-guard/lease?', opts()).allow, false);
    assert.equal(evaluateCommand('rm -rf ~/.cache/agent-guard/[l]eases', opts()).allow, false);
    assert.equal(evaluateCommand('rm -rf ~/.cache/agent-guard/lea{ses,se}', opts()).allow, false);
    assert.equal(evaluateCommand('d=~/.cache/agent-guard; rm -rf "$d/leases"', opts()).allow, false);
    assert.equal(evaluateCommand('cat agent-health-guard/leases/live.json', opts()).allow, true);
    assert.equal(evaluateCommand('mkdir -p /tmp/agent-app-guard/leases', opts()).allow, true);
    // A bare `agent-guard` token or a repo source path is a mention, not the
    // machine-wide state store (#190).
    assert.equal(evaluateCommand('rg agent-guard docs', opts()).allow, true);
    assert.equal(evaluateCommand('echo agent-guard', opts()).allow, true);
    assert.equal(evaluateCommand('ls tools/agent-guard', opts()).allow, true);
    assert.equal(evaluateCommand('git log --oneline -- tools/agent-guard', opts()).allow, true);
    assert.equal(evaluateCommand('ls $PWD/tools/agent-guard', opts()).allow, true);
    assert.equal(evaluateCommand('rg leaseFile $PWD/tools/agent-guard', opts()).allow, true);
    // The whole-store deletions stay behind protection, glob-mangled or not.
    assert.equal(evaluateCommand('rm -rf ~/.c[a]che/agent-guard', opts()).allow, false);
    assert.equal(evaluateCommand('rm -rf $XDG_CACHE_HOME/agent-guard', opts()).allow, false);
    assert.equal(evaluateCommand('rm -rf ~/Library/Caches/agent-guard', opts()).allow, false);
  });

  test("Codex's argv arrays are normalized before matching", () => {
    assert.equal(normalizeCommand(['bash', '-lc', 'npm run test:e2e']), 'bash -lc "npm run test:e2e"');
    assert.equal(evaluateCommand(normalizeCommand(['bash', '-lc', 'npm run test:e2e']), opts()).allow, false);
    assert.equal(evaluateCommand(normalizeCommand(['git', 'commit', '-m', 'mention npm run ci']), opts()).allow, true);
  });

  test('command substitutions inside double quotes remain executable', () => {
    assert.equal(evaluateCommand('echo "$(npm run ci)"', opts()).allow, false);
    assert.equal(evaluateCommand('echo "$(npx vitest)"', opts()).allow, false);
    assert.equal(evaluateCommand('echo "`npm run ci`"', opts()).allow, false);
    assert.equal(evaluateCommand("echo '$(npm run ci)'", opts()).allow, true);
    assert.equal(evaluateCommand('echo "\\$(npm run ci)"', opts()).allow, true);
    assert.equal(evaluateCommand('echo "$(printf \'(\'; npx vitest)"', opts()).allow, false);
  });

  test('unquoted command substitutions remain executable', () => {
    assert.equal(evaluateCommand('echo $(npm run ci)', opts()).allow, false);
    assert.equal(evaluateCommand('foo=$(npx vitest)', opts()).allow, false);
    assert.equal(evaluateCommand('echo `npm run ci`', opts()).allow, false);
    assert.equal(evaluateCommand('echo \\`npm run ci\\`', opts()).allow, true);
  });

  test('quoted env operands cannot tamper with admission', () => {
    assert.equal(evaluateCommand('env "CI=true" node tools/agent-guard/run-guarded.mjs -- npm test', opts()).allow, false);
    assert.equal(evaluateCommand("env 'AGENT_GUARD_STATE_DIR=/tmp/private' npm test", opts()).allow, false);
    assert.equal(evaluateCommand("env C$'I=true' node tools/agent-guard/run-guarded.mjs -- npm test", opts()).allow, false);
  });

  test('identity removal is blocked even before a later shell command', () => {
    assert.equal(evaluateCommand('unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT AI_AGENT').allow, false);
    assert.equal(evaluateCommand('unset $(compgen -v CODEX_)').allow, false);
  });

  test('quote normalization has no attacker-controlled iteration cap', () => {
    const padding = Array.from({ length: 250 }, () => '""').join(' ');
    assert.equal(evaluateCommand(`echo ${padding}; npm run "ci"`, opts()).allow, false);
    assert.equal(evaluateCommand(`echo ${padding}; npx "playwright" test`, opts()).allow, false);
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
    assert.equal(resolveExecutionDir('/a', 'cd /b\nnpm test'), '/b');
    assert.equal(resolveExecutionDir('/outside', 'cd /tmp && cd /project && npm run ci'), '/project');
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'cd /tmp && cd /project && npm run ci' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'cd /tmp && (cd /project && npm run ci)' }, '/project').allow, false);
    assert.deepEqual(resolveExecutionDirs('/project', '(cd /tmp) && npx vitest'), ['/project', '/tmp']);
    assert.equal(evaluateHookInput({ cwd: '/project', command: '(cd /tmp) && npx vitest' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'true && cd /project && npm run ci' }, '/project').allow, false);
    assert.deepEqual(resolveExecutionDirs('/outside', '(cd /tmp); cd project && npm run ci'), ['/outside', '/tmp', '/outside/project']);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: '(cd /tmp); cd project && npm run ci' }, '/outside/project').allow, false);
    assert.deepEqual(resolveExecutionDirs('/outside', 'env -C /project npx vitest'), ['/outside', '/project']);
    assert.deepEqual(resolveExecutionDirs('/outside', 'env --chdir=/project npm run ci'), ['/outside', '/project']);
    assert.deepEqual(resolveExecutionDirs('/outside', 'env --chdir "/project with spaces" npm run ci'), ['/outside', '/project with spaces']);
    assert.deepEqual(resolveExecutionDirs('/outside', 'env -u TOKEN -C /project npm run ci'), ['/outside', '/project']);
    assert.deepEqual(resolveExecutionDirs('/outside', "env -S '-u TOKEN -C /project npm run ci'"), ['/outside', '/project']);
    assert.deepEqual(resolveExecutionDirs('/outside', 'env -C /project -C /elsewhere npm run ci'), ['/outside', '/elsewhere']);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'env -C /project npx vitest' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'env --chdir=/project npm run ci' }, '/project').allow, false);
    assert.deepEqual(resolveExecutionDirs('/outside', 'env -C /tmp true; cd project && npm run ci'), ['/outside', '/tmp', '/outside/project']);
    assert.deepEqual(resolveExecutionDirs('/outside', 'echo "(cd /tmp)"; cd project && npm run ci'), ['/outside', '/outside/project']);
    assert.deepEqual(resolveExecutionDirs('/outside', 'echo "$(cd /tmp)"; cd project && npm run ci'), ['/outside', '/tmp', '/outside/project']);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: "bash -c 'cd /project && npx vitest'" }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: "bash -c $'cd /project && npm run ci'" }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'command env -C /project npx vitest' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'time env --chdir=/project npm run ci' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'npm --prefix /project run ci' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'npm -C /project run test:e2e' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'pnpm --dir /project run ci' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'pnpm -C /project run ci' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'yarn --cwd /project run test:e2e' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'bun --cwd=/project run coverage' }, '/project').allow, false);
    assert.deepEqual(resolveExecutionDirs('/outside', 'cd -P /project && npx vitest'), ['/outside', '/project']);
    assert.deepEqual(resolveExecutionDirs('/outside', 'cd -L -e /project && npx vitest'), ['/outside', '/project']);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'cat <<EOF\ncd /project\nEOF\nnpm run ci' }, '/project').allow, true);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'target=/project; cd "$target" && npm run ci' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'pushd /project && npm run ci' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'command cd /project && npm run ci' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'builtin cd /project && npm run ci' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'ln -s /project /tmp/guard-link; cd /tmp/guard-link && npm run ci' }, '/project').allow, false);
    assert.equal(evaluateHookInput({ cwd: '/outside', command: 'tar -xf /tmp/link.tar -C /tmp; cd /tmp/link && npm run ci' }, '/project').allow, false);
  });

  test('quoted text is blanked while shell payloads are promoted', () => {
    assert.match(stripInertText('echo "npm run ci"'), /""/u);
    assert.match(stripInertText('sh -c "npm run ci"'), /npm run ci/u);
    assert.equal(evaluateCommand('node -e "require(\'node:child_process\').execSync(\'npm run ci\')"').allow, false);
    assert.equal(evaluateCommand('node --eval="process.exit(0)"').allow, false);
    assert.equal(evaluateCommand('node -pe "require(\'node:child_process\').execSync(\'npx vitest\')"').allow, false);
    assert.equal(evaluateCommand("node -e\"require('node:child_process').execSync('npm run ci')\"").allow, false);
    assert.equal(evaluateCommand('script -q /dev/null -c "npm run ci"').allow, false);
    assert.equal(evaluateCommand("script -q /dev/null --command='npx vitest'").allow, false);
    assert.equal(evaluateCommand("python3 -c \"import os; os.system('npm run ci')\"").allow, false);
    assert.equal(evaluateCommand("perl -e 'system q(npm run ci)'").allow, false);
    assert.equal(evaluateCommand("ruby -e 'system %q(npm run ci)'").allow, false);
    assert.equal(evaluateCommand("php -r 'system(\"npm run ci\");'").allow, false);
    assert.equal(evaluateCommand("awk 'BEGIN { system(\"npm run ci\") }'").allow, false);
    assert.equal(evaluateCommand("node --import='data:text/javascript,export default 1' script.js").allow, false);
    assert.equal(evaluateCommand("php -B 'system(\"npm run ci\");' < /dev/null").allow, false);
    assert.equal(evaluateCommand("php -E 'system(\"npm run ci\");' < /dev/null").allow, false);
    assert.equal(evaluateCommand('perl -MFile::Spec script.pl').allow, false);
    assert.equal(evaluateCommand('ruby -rbenchmark script.rb').allow, false);
    assert.equal(evaluateCommand('yarn workspace foo npm run ci').allow, false);
    assert.equal(evaluateCommand('taskset -c 0 npm run ci').allow, false);
  });

  test('segments are split on every shell separator', () => {
    assert.deepEqual(splitSegments('a && b || c; d | e & f'), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(splitSegments('a 2>&1 && b &>out & c'), ['a 2>&1', 'b &>out', 'c']);
    assert.deepEqual(splitSegments('((npm run ci))'), ['npm run ci']);
  });

  test('npm script names survive aliases and interleaved options', () => {
    assert.deepEqual(npmScriptNames('npm run test:e2e'), ['test:e2e']);
    assert.deepEqual(npmScriptNames('npm run-script test:e2e'), ['test:e2e']);
    assert.deepEqual(npmScriptNames('npm --silent run test:e2e'), ['test:e2e']);
    assert.deepEqual(npmScriptNames('npm --workspace pkg run test:e2e'), ['test:e2e']);
    assert.deepEqual(npmScriptNames('npm run -w pkg ci'), ['ci']);
    assert.deepEqual(npmScriptNames('npm run --workspace pkg test:e2e'), ['test:e2e']);
    assert.deepEqual(npmScriptNames('npm run lint -- --fix'), ['lint']);
    assert.deepEqual(npmScriptNames('npm test'), ['test']);
    assert.deepEqual(npmScriptNames('npm ci'), []);
    // Each segment is scanned, so a second invocation cannot hide behind the first.
    assert.deepEqual(npmScriptNames('npm run lint && npm run test:e2e'), ['lint', 'test:e2e']);
    assert.deepEqual(npmScriptNames('git status'), []);
  });

  test('node --run script names share npm script classification', () => {
    assert.deepEqual(nodeRunScriptNames('node --run ci'), ['ci']);
    assert.deepEqual(nodeRunScriptNames('node --run=test:e2e'), ['test:e2e']);
    assert.notEqual(heavyLaneFor('node --run ci'), null);
    assert.notEqual(heavyLaneFor('node --run=test:e2e'), null);
    assert.equal(evaluateCommand('node --run test:inner').allow, false);
  });

  test('other package-manager script names share npm classification', () => {
    assert.deepEqual(otherPackageScriptNames('pnpm --filter app run test:e2e'), ['test:e2e']);
    assert.deepEqual(otherPackageScriptNames('yarn test:stories:ci'), ['test:stories:ci']);
    assert.deepEqual(otherPackageScriptNames('bun run ci'), ['ci']);
    assert.deepEqual(otherPackageScriptNames('yarn workspace app test:e2e'), ['test:e2e']);
    assert.deepEqual(otherPackageScriptNames('bun -F app test:e2e'), ['test:e2e']);
    assert.notEqual(heavyLaneFor('pnpm run test:e2e'), null);
  });

  test('heavy-lane matching on a raw command line does not fire on prose', () => {
    // The lane patterns are word-based; a hook sees every command, so matching
    // "perf" anywhere would deny `grep perf src/`.
    assert.equal(heavyLaneFor('grep -rn perf src/'), null);
    assert.equal(heavyLaneFor('cat docs/e2e-notes.md'), null);
    assert.equal(heavyLaneFor('rg pnpm run ci'), null);
    assert.equal(heavyLaneFor('grep yarn test:e2e README.md'), null);
    assert.equal(heavyLaneFor('git commit -m pnpm -m run -m ci'), null);
    assert.equal(heavyLaneFor('rg node --run ci'), null);
    assert.notEqual(heavyLaneFor('npm run test:e2e'), null);
    assert.notEqual(heavyLaneFor('npm run ci'), null);
  });
});
