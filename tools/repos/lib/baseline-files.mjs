// Files that governance expects in every active or onboarding repository.
// Keep this inventory independent of API and planning code so drift detection
// and reconciliation cannot silently disagree.

export const GOVERNED_CODEX_FILES = [
  '.codex/config.toml',
  '.codex/environments/environment.toml',
  '.codex/rules/environment.rules',
];

export const GOVERNED_CODEX_HOOK_FILES = ['.codex/hooks.json'];

// The Claude Code layer is one file, and deliberately so: it carries the
// harness hooks the git-level automation cannot reach (ENG-0016), nothing else.
export const GOVERNED_CLAUDE_FILES = ['.claude/settings.json'];

export const GOVERNED_CURSOR_FILES = ['.cursor/hooks.json'];

// Copilot (CLI and coding agent) loads repository hooks from .github/hooks/;
// Windsurf (Devin desktop) loads Cascade hooks from .windsurf/hooks.json.
// Both exist so the guard reaches every harness that can run shell commands
// in a governed checkout, not only the three original ones (#290).
export const GOVERNED_COPILOT_FILES = ['.github/hooks/agent-guard.json'];

export const GOVERNED_WINDSURF_FILES = ['.windsurf/hooks.json'];

// JSON composition is intentionally narrower than the governed harness: only
// hook adapters may retain repository-generated entries. Canonical registries
// and other governed JSON must remain byte-identical across the fleet.
export const GOVERNED_HOOK_ADAPTER_FILES = [
  ...GOVERNED_CODEX_HOOK_FILES,
  ...GOVERNED_CLAUDE_FILES,
  ...GOVERNED_CURSOR_FILES,
  ...GOVERNED_COPILOT_FILES,
  ...GOVERNED_WINDSURF_FILES,
];

// What the fleet sync keeps current downstream: both harness layers, so a
// change here reaches every governed repo instead of only the next repo to be
// onboarded. The manifest field that scopes it stays `codexSync` — renaming it
// would orphan the manifests, and the sync branch and title are what an open
// downstream PR is matched on.
// Managed bytes must be exempt from consumer formatters. The source repository
// validates their language contracts with lint:synced; formatting them after
// synchronization would only create a byte-drift loop. Keep the governed block
// in .prettierignore aligned with this exact inventory.
export const GOVERNED_FORMAT_EXEMPT_FILES = [
  ...GOVERNED_CODEX_FILES,
  ...GOVERNED_HOOK_ADAPTER_FILES,
];

export const GOVERNED_HARNESS_FILES = [
  ...GOVERNED_FORMAT_EXEMPT_FILES,
  // Partially managed: synchronization replaces only its marked governance
  // block and preserves every repository-owned line outside it.
  '.prettierignore',
];

export const BASELINE_FILES = [
  'README.md',
  'LICENSE',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.github/CODEOWNERS',
  ...GOVERNED_HARNESS_FILES,
];

// Paths the sync previously managed and has stopped managing (#287). The sync
// only ever added and updated files downstream, so a path leaving the governed
// inventory stranded a stale copy in every governed repo — the retired
// .codex/scripts/setup.sh kept rewriting shell profiles for weeks after #286
// deleted it here. This list is the durable record that lets retraction
// distinguish "we stopped managing this" from "the repo created this itself":
// the sync deletes a downstream file only when its path is recorded here.
//
// A path stays on this list forever once managed files stop shipping it; if it
// ever returns to management it moves back to the governed inventory above and
// off this list (the two must stay disjoint — retiredCodexPaths fails closed
// on overlap).
export const RETIRED_HARNESS_FILES = [
  // #286: .codex/ became purely Codex-specific; the harness scripts installed
  // tooling, rewrote shell profiles, and prepended /opt/homebrew/bin to PATH.
  '.codex/scripts/cleanup.sh',
  '.codex/scripts/ensure-identity.sh',
  '.codex/scripts/gh.zsh',
  '.codex/scripts/git-with-nvm.zsh',
  '.codex/scripts/nvm.zsh',
  '.codex/scripts/setup.sh',
  // Managed briefly between "require OIDC for hosted CI bypass" and "remove
  // replayable CI exemption"; any sync in that window shipped it downstream.
  'tools/agent-guard/lib/hosted-ci.mjs',
  // #331: the machine memory guard shipped while its decision (ENG-0138) was
  // still Proposed. Only accepted decisions ship — the implementation stays in
  // this repo, and the sync retracts every consumer copy it distributed.
  'tools/agent-guard/arbiter.mjs',
  'tools/agent-guard/guard-agent-command.mjs',
  'tools/agent-guard/run-guarded.mjs',
  'tools/agent-guard/lib/budget.mjs',
  'tools/agent-guard/lib/leases.mjs',
  'tools/agent-guard/lib/policy.mjs',
  'tools/agent-guard/lib/protocol.mjs',
  'tools/agent-guard/lib/system-memory.mjs',
  'tools/agent-guard/tests/conformance.test.mjs',
  // #284: the model routing registry moved to agent-bot-identity.
  'governance/agent-models.json',
  'tools/models/registry.mjs',
];
