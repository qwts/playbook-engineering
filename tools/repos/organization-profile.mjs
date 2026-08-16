#!/usr/bin/env node

// Project governance/agents.json into the checked-in organization profile.
//
//   check   (default)  fail if the published file drifts from the roster
//   --write            regenerate governance/organization-profile.json
//
// Usage:
//   node tools/repos/organization-profile.mjs [check] [--write]
//     [--root <dir>] [--agents <file>] [--profile <file>]

import path from 'node:path';
import process from 'node:process';
import {
  loadOrganizationProfile,
  profileFromAgentsPath,
  profilesMatch,
  renderOrganizationProfile,
  writeOrganizationProfile,
} from './lib/organization-profile.mjs';

function parseArgs(argv) {
  const args = { root: process.cwd(), agents: null, profile: null, write: false };
  for (let i = 2; i < argv.length; i += 1) {
    switch (argv[i]) {
      case 'check':
        break;
      case '--write':
        args.write = true;
        break;
      case '--root':
        args.root = path.resolve(argv[++i]);
        break;
      case '--agents':
        args.agents = argv[++i];
        break;
      case '--profile':
        args.profile = argv[++i];
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  args.agents = path.resolve(args.root, args.agents ?? path.join('governance', 'agents.json'));
  args.profile = path.resolve(args.root, args.profile ?? path.join('governance', 'organization-profile.json'));
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  let expected;
  try {
    expected = profileFromAgentsPath(args.agents);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const profileRel = path.relative(args.root, args.profile);
  if (args.write) {
    writeOrganizationProfile(args.profile, expected);
    console.log(`Wrote ${profileRel} from ${path.relative(args.root, args.agents)}.`);
    return;
  }

  let actual;
  try {
    actual = loadOrganizationProfile(args.profile);
  } catch (error) {
    console.error(error.message);
    console.error(`Run: node tools/repos/organization-profile.mjs --write`);
    process.exit(1);
  }
  if (!profilesMatch(actual, expected)) {
    console.error(`${profileRel} is out of date with the agent roster. Run: node tools/repos/organization-profile.mjs --write`);
    process.exit(1);
  }
  process.stdout.write(renderOrganizationProfile(actual));
}

main();
