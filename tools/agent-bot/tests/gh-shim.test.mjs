import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { buildGhShim } from '../gh-shim.mjs';

const root = mkdtempSync(join(tmpdir(), 'gh-shim-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function runWhoami({ slug = '', token = '' } = {}) {
  const shimDir = join(root, `shim-${Math.random()}`);
  const realDir = join(root, `real-${Math.random()}`);
  mkdirSync(shimDir);
  mkdirSync(realDir);

  const tokenTool = join(root, `token-${Math.random()}.mjs`);
  writeFileSync(
    tokenTool,
    `if (process.argv.includes('--slug')) process.stdout.write(${JSON.stringify(slug)});`,
  );

  const shim = join(shimDir, 'gh');
  writeFileSync(shim, buildGhShim(tokenTool));
  chmodSync(shim, 0o755);

  const real = join(realDir, 'gh');
  writeFileSync(
    real,
    `#!/bin/sh
if [ "$1 $2" = "api graphql" ]; then echo explicit-token-owner; exit 0; fi
if [ "$1 $2 $3 $4" = "api user --jq .login" ]; then echo human-owner; exit 0; fi
exit 64
`,
  );
  chmodSync(real, 0o755);

  return execFileSync('sh', [shim, 'whoami'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_TOKEN: token,
      PATH: [shimDir, realDir, process.env.PATH].filter(Boolean).join(delimiter),
    },
  }).trim();
}

test('explicit GH_TOKEN identity outranks bot territory', () => {
  assert.equal(
    runWhoami({ slug: 'qwts-codex-agent', token: 'explicit-token' }),
    'explicit-token-owner — explicit GH_TOKEN',
  );
});

test('bot territory reports its local slug without an explicit token', () => {
  assert.equal(runWhoami({ slug: 'qwts-codex-agent' }), 'qwts-codex-agent[bot] — bot territory (ENG-0045)');
});

test('human territory asks stock gh for its login', () => {
  assert.equal(runWhoami(), 'human-owner — human territory, gh is stock');
});
