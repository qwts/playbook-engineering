// Pure planning logic for the governance reconciler (ENG-0038). No network,
// no filesystem — everything here is unit-testable from a drift result alone.
//
// A drift result (tools/repos/drift.mjs checkRepo) becomes a plan of three
// lanes, split by GitHub's permission model, not by taste:
//   settings — repo settings the human's token can converge via API
//   seeds    — missing baseline files a bot can propose via PR
//   human    — bootstrap steps no App on a user account can perform, plus
//              files that are deliberately per-repo (README, LICENSE)

import { GOVERNED_HARNESS_FILES } from './baseline-files.mjs';

// check name -> { source (template in this repo), target (path in the repo) }
export const SEEDS = {
  'AGENTS.md': { source: 'governance/baseline/AGENTS.md', target: 'AGENTS.md' },
  'CONTRIBUTING.md': { source: 'governance/baseline/CONTRIBUTING.md', target: 'CONTRIBUTING.md' },
  '.github/CODEOWNERS': { source: 'governance/baseline/CODEOWNERS', target: '.github/CODEOWNERS' },
  // The root .codex and .claude layers are the shared source of truth for
  // governed repos — seeded as-is, so every repo runs the same agent harness
  // configuration this one is developed under.
  ...Object.fromEntries(GOVERNED_HARNESS_FILES.map((path) => [path, { source: path, target: path }])),
  // The canonical shared form itself, not a copy — one source of truth.
  'feature issue template': {
    source: '.github/ISSUE_TEMPLATE/feature.yml',
    target: '.github/ISSUE_TEMPLATE/feature.yml',
  },
};

const SETTINGS = {
  'review required to merge': 'ruleset-review-count',
  'private vulnerability reporting': 'enable-pvr',
};

// Non-file checks with no automated lane, each carrying the fix rather than
// just the failure. Code scanning is not a seed: the workflow is `workflow_call`
// only, so dropping the file in does nothing until the repo's own ci.yml invokes
// it — and ci.yml is deliberately per-repo (coverage floors, Rust gates, version
// consistency), so a reconciler cannot safely edit it.
const HUMAN_SETUP = {
  'code scanning (CodeQL, own workflow, current)':
    'either the repo never scans with its own workflow, or it stopped: copy .github/workflows/codeql.yml from this repo and add a `codeql` job to the repo\'s ci.yml that invokes it (`uses: ./.github/workflows/codeql.yml`), declaring actions/contents/packages read + security-events write at the call site; if that job already exists, its last analysis predates the current default-branch head, so check the workflow is enabled and still runs on pushes to the default branch',
};

// Deliberately per-repo: generating them would fake conformance.
const HUMAN_FILES = {
  'README.md': 'write a real README — what it is, how to run it, where deeper docs live',
  LICENSE: 'choose a license — deliberately per-repo (repo-baseline-files SOP); absence is the only violation',
};

export function plan(result) {
  const out = { name: result.name, status: result.status, settings: [], seeds: [], human: [] };
  if (result.error) {
    out.human.push(`create the repo under the account and record it in governance/repos.json (${result.error})`);
    return out;
  }
  for (const check of result.failed) {
    if (SETTINGS[check]) out.settings.push({ check, action: SETTINGS[check] });
    else if (SEEDS[check]) out.seeds.push({ check, ...SEEDS[check] });
    else if (HUMAN_FILES[check]) out.human.push(`${check}: ${HUMAN_FILES[check]}`);
    else if (HUMAN_SETUP[check]) out.human.push(`${check}: ${HUMAN_SETUP[check]}`);
    else if (check.startsWith('app: ')) {
      out.human.push(`install ${check.slice(5)} on the repo — installation-repo management is user-to-server only`);
    } else out.human.push(`${check}: no reconcile lane — converge manually`);
  }
  return out;
}

// The transformation applied to an existing ruleset: bump the pull_request
// rule's review count to at least 1, changing nothing else. Returns the PUT
// payload, or null when the ruleset has no pull_request rule to bump.
export function bumpReviewCount(ruleset) {
  const rules = ruleset.rules ?? [];
  if (!rules.some((r) => r.type === 'pull_request')) return null;
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: ruleset.conditions,
    bypass_actors: ruleset.bypass_actors ?? [],
    rules: rules.map((r) =>
      r.type === 'pull_request'
        ? {
            ...r,
            parameters: {
              ...r.parameters,
              required_approving_review_count: Math.max(1, r.parameters?.required_approving_review_count ?? 0),
            },
          }
        : r,
    ),
  };
}

export function mergeQueueRule(mergeMethod = 'MERGE') {
  return {
    type: 'merge_queue',
    parameters: {
      check_response_timeout_minutes: 60,
      grouping_strategy: 'ALLGREEN',
      max_entries_to_build: 1,
      max_entries_to_merge: 1,
      merge_method: mergeMethod,
      min_entries_to_merge: 1,
      min_entries_to_merge_wait_minutes: 0,
    },
  };
}

export function canUseMergeQueue({ ownerType, visibility, ownerPlan }) {
  return ownerType === 'Organization' && (visibility === 'public' || ownerPlan === 'enterprise');
}

// The standard default-branch ruleset for a repo that has none: the shape the
// governed repos share, minus required status checks (those are per-repo).
// Native merge queue is organization-only; user-owned repos receive the strict
// updater fallback documented in the CI execution policy. Enabled repository
// merge methods pass through unchanged.
// Repository-admin bypass matches the existing rulesets — the solo human must
// stay able to merge their own PRs.
export function defaultRuleset({ mergeQueueAvailable = false, allowedMergeMethods = ['merge'] } = {}) {
  const queueMergeMethod = allowedMergeMethods[0]?.toUpperCase();
  return {
    name: 'Default',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          required_reviewers: [],
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: allowedMergeMethods,
        },
      },
      ...(mergeQueueAvailable ? [mergeQueueRule(queueMergeMethod)] : []),
    ],
  };
}
