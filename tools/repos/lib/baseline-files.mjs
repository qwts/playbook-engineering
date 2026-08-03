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

export const GOVERNED_CODEX_HOOK_FILES = ['.codex/hooks.json'];

// The Claude Code layer is one file, and deliberately so: it carries the
// harness hooks the git-level automation cannot reach (ENG-0016), nothing else.
export const GOVERNED_CLAUDE_FILES = ['.claude/settings.json'];

export const GOVERNED_CURSOR_FILES = ['.cursor/hooks.json'];

// The machine memory guard (ENG-0138). Shipped as governed files rather than
// left to each repo to copy, because two hand-maintained copies is what the
// record is fixing: overlook and image-trail each carried their own drifted
// fork of the old guard. Every copy here is byte-identical and sha-verified by
// the sync, so the repos coordinate through one per-machine lease directory
// with one agreed protocol — a copy that drifted would silently mis-budget.
export const GOVERNED_AGENT_GUARD_FILES = [
  'tools/agent-guard/arbiter.mjs',
  'tools/agent-guard/guard-agent-command.mjs',
  'tools/agent-guard/run-guarded.mjs',
  'tools/agent-guard/lib/budget.mjs',
  'tools/agent-guard/lib/leases.mjs',
  'tools/agent-guard/lib/policy.mjs',
  'tools/agent-guard/lib/protocol.mjs',
  'tools/agent-guard/lib/system-memory.mjs',
  // Ships with the tool so a repo cannot end up with the guard but no proof it
  // is still wired in — the failure mode ENG-0138 inherits from the sync that
  // once replaced .claude/settings.json wholesale and dropped the guard hook.
  'tools/agent-guard/tests/conformance.test.mjs',
];

// The model routing registry (ENG-0151). Synced rather than left in this repo
// because the issue-lifecycle SOP requires every governed repo's agents to read
// it before filing an issue, and an SOP that points at a path only one repo has
// is an instruction its consumers cannot follow. Same argument as the agent
// guard above: one record, byte-identical everywhere, refreshed in one place.
//
// refresh-task.mjs is deliberately absent — refreshing happens only here.
export const GOVERNED_MODEL_ROUTING_FILES = [
  'governance/agent-models.json',
  'tools/models/registry.mjs',
];

// What the fleet sync keeps current downstream: both harness layers, so a
// change here reaches every governed repo instead of only the next repo to be
// onboarded. The manifest field that scopes it stays `codexSync` — renaming it
// would orphan the manifests, and the sync branch and title are what an open
// downstream PR is matched on.
export const GOVERNED_HARNESS_FILES = [
  ...GOVERNED_CODEX_FILES,
  ...GOVERNED_CODEX_HOOK_FILES,
  ...GOVERNED_CLAUDE_FILES,
  ...GOVERNED_CURSOR_FILES,
  ...GOVERNED_AGENT_GUARD_FILES,
  ...GOVERNED_MODEL_ROUTING_FILES,
];

export const BASELINE_FILES = [
  'README.md',
  'LICENSE',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.github/CODEOWNERS',
  ...GOVERNED_HARNESS_FILES,
];
