import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function changesetInputs(root) {
  const directory = path.join(root, '.changeset');
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => entry.name);
}

export function hasPrereleaseState(root) {
  return existsSync(path.join(root, '.changeset', 'pre.json'));
}

export function semanticReleaseCount({ root, statusFile, runStatus = defaultRunStatus }) {
  if (changesetInputs(root).length === 0 && !hasPrereleaseState(root)) return 0;
  runStatus(statusFile, root);
  const status = JSON.parse(readFileSync(statusFile, 'utf8'));
  if (!Array.isArray(status.releases)) throw new Error('Changesets status has no releases array');
  return status.releases.length;
}

function defaultRunStatus(statusFile, root) {
  execFileSync('npx', ['--no-install', 'changeset', 'status', '--output', statusFile], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function main() {
  const [statusFile] = process.argv.slice(2);
  if (!statusFile) throw new Error('Usage: semantic-release-count.mjs <status-file>');
  process.stdout.write(`${semanticReleaseCount({ root: process.cwd(), statusFile })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
