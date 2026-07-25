// Agent-identity roster — load and validate (ENG-0079).
//
// `governance/agents.json` is the source of truth for which GitHub App
// identities exist. Drift reads it to decide which App installations to
// verify, so registering an agent here is what makes it *checked*; an App that
// exists on GitHub but not in this file is an App nothing watches, and the
// first symptom is a push failing on a repository it was never installed on.
//
// Same shape and constraints as the repo manifest (lib/manifest.mjs): stdlib
// only, validator returns problems rather than printing, unknown fields fail
// rather than being ignored.

import { readFileSync } from 'node:fs';

export const VALID_AGENT_STATUS = ['active', 'retired'];
const AGENT_FIELDS = new Set(['slug', 'harness', 'status', 'note']);

export function loadAgents(agentsPath) {
  let raw;
  try {
    raw = readFileSync(agentsPath, 'utf8');
  } catch {
    throw new Error(`agent roster not found: ${agentsPath}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`agent roster is not valid JSON (${agentsPath}): ${error.message}`);
  }
}

export function validateAgents(roster) {
  const errors = [];
  if (roster === null || typeof roster !== 'object' || Array.isArray(roster)) {
    return ['agent roster must be a JSON object'];
  }
  if (typeof roster.account !== 'string' || roster.account.trim() === '') {
    errors.push('account must be a non-empty string');
  }
  if (!Array.isArray(roster.agents)) {
    errors.push('agents must be an array');
    return errors;
  }

  const seen = new Set();
  roster.agents.forEach((agent, index) => {
    const where = `agents[${index}]`;
    if (agent === null || typeof agent !== 'object' || Array.isArray(agent)) {
      errors.push(`${where} must be an object`);
      return;
    }
    for (const field of Object.keys(agent)) {
      if (!AGENT_FIELDS.has(field)) errors.push(`${where} has unknown field ${JSON.stringify(field)}`);
    }
    // The slug is a path segment (~/.config/<slug>/) and reaches a shell
    // through the credential helper, so it carries the same restriction the
    // helper enforces rather than a looser one here.
    if (typeof agent.slug !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(agent.slug)) {
      errors.push(`${where}.slug must be a GitHub App slug (letters, digits, inner hyphens)`);
    } else if (seen.has(agent.slug)) {
      errors.push(`${where}.slug duplicates ${JSON.stringify(agent.slug)}`);
    } else {
      seen.add(agent.slug);
    }
    if (typeof agent.harness !== 'string' || agent.harness.trim() === '') {
      errors.push(`${where}.harness must be a non-empty string`);
    }
    if (!VALID_AGENT_STATUS.includes(agent.status)) {
      errors.push(`${where}.status must be one of ${VALID_AGENT_STATUS.join(', ')}`);
    }
    if (agent.note !== undefined && typeof agent.note !== 'string') {
      errors.push(`${where}.note must be a string when present`);
    }
  });
  return errors;
}

// The slugs drift verifies. Retired identities keep their row — the same
// offboarding discipline the repo manifest uses — but nothing checks their
// installations any more.
export function activeAgentSlugs(roster) {
  return roster.agents.filter((agent) => agent.status === 'active').map((agent) => agent.slug);
}
