// Cryptographic proof for the only environment that may bypass the local
// machine guard. Environment variables, paths, ownership, and parent-process
// metadata are all forgeable by a local root process; a short-lived GitHub OIDC
// token is not. The token is requested at the point of use and verified against
// GitHub's fixed issuer key set before any bypass is granted.

import { createPublicKey, verify as verifySignature } from 'node:crypto';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_OIDC_JWKS = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
export const AGENT_GUARD_OIDC_AUDIENCE = 'urn:qwts:agent-guard:hosted-ci';
export const TRUSTED_REPOSITORY_OWNER = 'qwts';
export const TRUSTED_REPOSITORY_OWNER_ID = '91036491';

const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_AGE_SECONDS = 10 * 60;
const DEFAULT_TIMEOUT_MS = 5000;

function untrusted(reason) {
  return { trusted: false, reason };
}

function decodeJsonPart(encoded) {
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JWT part must be an object');
  }
  return value;
}

function parseJwt(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 32_768) {
    throw new Error('invalid JWT size');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('invalid JWT shape');
  }
  return {
    header: decodeJsonPart(parts[0]),
    claims: decodeJsonPart(parts[1]),
    signed: Buffer.from(`${parts[0]}.${parts[1]}`),
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

function isGitHubActionsOidcEndpoint(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      hostname.endsWith('.actions.githubusercontent.com')
    );
  } catch {
    return false;
  }
}

function audienceMatches(audience) {
  if (typeof audience === 'string') return audience === AGENT_GUARD_OIDC_AUDIENCE;
  return Array.isArray(audience) && audience.length === 1 && audience[0] === AGENT_GUARD_OIDC_AUDIENCE;
}

function sameClaim(claims, claim, env, variable) {
  const expected = env[variable];
  return typeof expected === 'string' && expected !== '' && String(claims[claim] ?? '') === expected;
}

function validateClaims(claims, env, nowSeconds) {
  if (claims.iss !== GITHUB_OIDC_ISSUER || !audienceMatches(claims.aud)) return false;
  if (claims.runner_environment !== 'github-hosted') return false;
  if (claims.repository_owner !== TRUSTED_REPOSITORY_OWNER) return false;
  if (String(claims.repository_owner_id ?? '') !== TRUSTED_REPOSITORY_OWNER_ID) return false;
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.nbf) || !Number.isInteger(claims.exp)) return false;
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS || claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) return false;
  if (claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS) return false;
  if (claims.iat < nowSeconds - MAX_TOKEN_AGE_SECONDS || claims.exp > nowSeconds + MAX_TOKEN_AGE_SECONDS) return false;

  const bindings = [
    ['repository', 'GITHUB_REPOSITORY'],
    ['repository_id', 'GITHUB_REPOSITORY_ID'],
    ['run_id', 'GITHUB_RUN_ID'],
    ['run_attempt', 'GITHUB_RUN_ATTEMPT'],
    ['sha', 'GITHUB_SHA'],
    ['ref', 'GITHUB_REF'],
    ['event_name', 'GITHUB_EVENT_NAME'],
    ['workflow_ref', 'GITHUB_WORKFLOW_REF'],
    ['workflow_sha', 'GITHUB_WORKFLOW_SHA'],
  ];
  return bindings.every(([claim, variable]) => sameClaim(claims, claim, env, variable));
}

async function responseJson(response) {
  if (!response || response.ok !== true || typeof response.json !== 'function') {
    throw new Error('request failed');
  }
  return response.json();
}

/**
 * Verify that this process is executing in a GitHub-hosted Actions job.
 *
 * The request credential is sent only to GitHub-owned Actions hosts. The
 * returned JWT is then independently signature-checked against GitHub's fixed
 * OIDC issuer and bound to this exact workflow run. Any failure is a normal
 * fail-closed result; callers must apply local policy instead of bypassing it.
 */
export async function githubHostedCiTrust({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    return untrusted('not-github-hosted-actions');
  }
  if (
    typeof env.ACTIONS_ID_TOKEN_REQUEST_URL !== 'string' ||
    typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== 'string' ||
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === ''
  ) {
    return untrusted('oidc-permission-missing');
  }
  if (!isGitHubActionsOidcEndpoint(env.ACTIONS_ID_TOKEN_REQUEST_URL)) {
    return untrusted('untrusted-oidc-request-endpoint');
  }
  if (typeof fetchImpl !== 'function') return untrusted('oidc-fetch-unavailable');

  try {
    const requestUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    requestUrl.searchParams.set('audience', AGENT_GUARD_OIDC_AUDIENCE);
    const requestResponse = await fetchImpl(requestUrl, {
      headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const requested = await responseJson(requestResponse);
    const parsed = parseJwt(requested.value);
    if (parsed.header.alg !== 'RS256' || typeof parsed.header.kid !== 'string' || parsed.header.kid === '') {
      return untrusted('invalid-oidc-header');
    }

    const jwksResponse = await fetchImpl(GITHUB_OIDC_JWKS, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const jwks = await responseJson(jwksResponse);
    const key = Array.isArray(jwks.keys)
      ? jwks.keys.find((candidate) => (
        candidate?.kid === parsed.header.kid &&
        candidate?.kty === 'RSA' &&
        (candidate?.use === undefined || candidate.use === 'sig') &&
        (candidate?.alg === undefined || candidate.alg === 'RS256')
      ))
      : null;
    if (!key) return untrusted('oidc-signing-key-not-found');

    const publicKey = createPublicKey({ key, format: 'jwk' });
    if (!verifySignature('RSA-SHA256', parsed.signed, publicKey, parsed.signature)) {
      return untrusted('invalid-oidc-signature');
    }
    if (!validateClaims(parsed.claims, env, Math.floor(now / 1000))) {
      return untrusted('oidc-claim-mismatch');
    }
    return { trusted: true, reason: 'github-oidc-attested', claims: parsed.claims };
  } catch {
    return untrusted('oidc-attestation-failed');
  }
}

export async function isTrustedHostedCi(options = {}) {
  return (await githubHostedCiTrust(options)).trusted;
}
