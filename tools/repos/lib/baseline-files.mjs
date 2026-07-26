// Files that governance expects in every active or onboarding repository.
// Keep this inventory independent of API and planning code so drift detection
// and reconciliation cannot silently disagree.

export const GOVERNED_CODEX_FILES = [
  '.codex/config.toml',
  '.codex/environments/environment.toml',
  '.codex/rules/environment.rules',
  '.codex/scripts/cleanup.sh',
  '.codex/scripts/ensure-identity.sh',
  '.codex/scripts/gh.zsh',
  '.codex/scripts/git-with-nvm.zsh',
  '.codex/scripts/nvm.zsh',
  '.codex/scripts/setup.sh',
];

// The Claude Code layer is one file, and deliberately so: it carries the
// harness hooks the git-level automation cannot reach (ENG-0016), nothing else.
export const GOVERNED_CLAUDE_FILES = ['.claude/settings.json'];

// What the fleet sync keeps current downstream: both harness layers, so a
// change here reaches every governed repo instead of only the next repo to be
// onboarded. The manifest field that scopes it stays `codexSync` — renaming it
// would orphan the manifests, and the sync branch and title are what an open
// downstream PR is matched on.
export const GOVERNED_HARNESS_FILES = [...GOVERNED_CODEX_FILES, ...GOVERNED_CLAUDE_FILES];

export const BASELINE_FILES = [
  'README.md',
  'LICENSE',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.github/CODEOWNERS',
  ...GOVERNED_HARNESS_FILES,
];
