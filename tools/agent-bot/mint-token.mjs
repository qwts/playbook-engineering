#!/usr/bin/env node
// Mints a short-lived GitHub App installation token for an agent bot
// identity (ENG-0016). Prints the token to stdout for use as GH_TOKEN.
// Zero-dependency by design, like the rest of tools/ (ENG-0004).
//
// App selection (first match wins):
//   --app <slug>             — read ~/.config/<slug>/{app-id,private-key.pem}
//   GH_AGENT_APP=<slug>      — same lookup, set once per launcher environment
//   GH_APP_ID + GH_APP_PRIVATE_KEY_PATH — explicit pair (CI, overrides)
// Env:  GH_APP_INSTALLATION_ID — only needed when the App has >1 installation
// Flag: --json                — print { token, expires_at, installation_id }

import { createSign, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const API = 'https://api.github.com';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// App JWTs are capped at 10 minutes by GitHub; 9 minutes with a 60-second
// backdate absorbs clock drift between this machine and GitHub.
export function buildAppJwt(appId, privateKeyPem, nowSeconds) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(createPrivateKey(privateKeyPem));
  return `${signingInput}.${b64url(signature)}`;
}

export function appConfig({ argv = process.argv, env = process.env, home = homedir() } = {}) {
  const flag = argv.indexOf('--app');
  if (flag !== -1 && !argv[flag + 1]) {
    throw new Error('--app requires a slug, e.g. --app qwts-claude-agent');
  }
  const slug = flag !== -1 ? argv[flag + 1] : env.GH_AGENT_APP;
  if (slug) {
    const dir = join(home, '.config', slug);
    try {
      return {
        appId: readFileSync(join(dir, 'app-id'), 'utf8').trim(),
        privateKeyPem: readFileSync(join(dir, 'private-key.pem'), 'utf8'),
      };
    } catch {
      throw new Error(`no app config for "${slug}" — expected ${dir}/app-id and ${dir}/private-key.pem`);
    }
  }
  if (env.GH_APP_ID && env.GH_APP_PRIVATE_KEY_PATH) {
    return { appId: env.GH_APP_ID, privateKeyPem: readFileSync(env.GH_APP_PRIVATE_KEY_PATH, 'utf8') };
  }
  throw new Error('pass --app <slug>, set GH_AGENT_APP, or set GH_APP_ID and GH_APP_PRIVATE_KEY_PATH — see docs/reference/agent-bot-identity.md');
}

async function gh(method, path, jwt) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'qwts-agent-mint-token',
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${body.message ?? 'unknown error'}`);
  }
  return body;
}

// Programmatic entry point (used by git-credential-bot.mjs): mint a token
// for a slug, or for whatever appConfig() resolves when slug is omitted.
export async function mint({ slug, env = process.env } = {}) {
  const argv = slug ? ['node', 'mint-token.mjs', '--app', slug] : process.argv;
  const { appId, privateKeyPem } = appConfig({ argv, env });
  const jwt = buildAppJwt(appId, privateKeyPem, Math.floor(Date.now() / 1000));

  let installationId = env.GH_APP_INSTALLATION_ID;
  if (!installationId) {
    const installations = await gh('GET', '/app/installations', jwt);
    if (installations.length !== 1) {
      throw new Error(`expected exactly one installation, found ${installations.length}; set GH_APP_INSTALLATION_ID`);
    }
    installationId = installations[0].id;
  }

  const grant = await gh('POST', `/app/installations/${installationId}/access_tokens`, jwt);
  return { token: grant.token, expires_at: grant.expires_at, installation_id: Number(installationId) };
}

async function main() {
  const grant = await mint();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(grant)}\n`);
  } else {
    process.stdout.write(`${grant.token}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`mint-token: ${err.message}`);
    process.exit(1);
  });
}
