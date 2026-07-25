// Files that governance expects in every active or onboarding repository.
// Keep this inventory independent of API and planning code so drift detection
// and reconciliation cannot silently disagree.

export const GOVERNED_CODEX_FILES = [
  '.codex/config.toml',
  '.codex/environments/environment.toml',
  '.codex/rules/environment.rules',
  '.codex/scripts/cleanup.sh',
  '.codex/scripts/gh.zsh',
  '.codex/scripts/git-with-nvm.zsh',
  '.codex/scripts/nvm.zsh',
  '.codex/scripts/setup.sh',
];

// The Claude Code layer is one file, and deliberately so: it carries the
// harness hooks the git-level automation cannot reach (ENG-0016), nothing else.
export const GOVERNED_CLAUDE_FILES = ['.claude/settings.json'];

export const BASELINE_FILES = [
  'README.md',
  'LICENSE',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.github/CODEOWNERS',
  ...GOVERNED_CODEX_FILES,
  ...GOVERNED_CLAUDE_FILES,
];
