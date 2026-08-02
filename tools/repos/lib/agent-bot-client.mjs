import { spawnSync } from 'node:child_process';
import process from 'node:process';

export function agentBotBinary(env = process.env) {
  const override = env.AGENT_BOT_BIN;
  if (override === undefined) return 'agent-bot';
  if (typeof override !== 'string' || override.trim() === '') {
    throw new Error('AGENT_BOT_BIN must name an executable');
  }
  return override;
}

export function runMintCommand({ slug, env = process.env, runner = spawnSync } = {}) {
  const binary = agentBotBinary(env);
  const args = ['mint-token', ...(slug ? ['--app', slug] : []), '--json'];
  let result;
  try {
    result = runner(binary, args, {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`agent-bot executable could not be started: ${binary}`);
  }
  if (result?.error) {
    const reason = result.error.code === 'ENOENT' ? 'was not found' : 'could not be started';
    throw new Error(`agent-bot executable ${reason}: ${binary}`);
  }
  if (result?.status !== 0) {
    throw new Error(`agent-bot mint-token failed with exit status ${result?.status ?? 'unknown'}`);
  }
  return result.stdout;
}

export function parseMintGrant(stdout) {
  let grant;
  try {
    grant = JSON.parse(stdout);
  } catch {
    throw new Error('agent-bot mint-token emitted malformed JSON');
  }
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    throw new Error('agent-bot mint-token emitted an invalid grant');
  }
  if (grant.schema_version !== 1) {
    throw new Error('agent-bot mint-token emitted an unsupported grant schema');
  }
  if (typeof grant.token !== 'string' || grant.token.trim() === '') {
    throw new Error('agent-bot mint-token grant omitted the token');
  }
  if (typeof grant.expires_at !== 'string' || !Number.isInteger(grant.installation_id)) {
    throw new Error('agent-bot mint-token emitted an incomplete grant');
  }
  return grant;
}

export function mintAgentToken(options = {}) {
  return parseMintGrant(runMintCommand(options));
}
