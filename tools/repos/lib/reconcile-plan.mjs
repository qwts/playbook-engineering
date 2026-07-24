// Pure planning logic for the governance reconciler (ENG-0038). No network,
// no filesystem — everything here is unit-testable from a drift result alone.
//
// A drift result (tools/repos/drift.mjs checkRepo) becomes a plan of three
// lanes, split by GitHub's permission model, not by taste:
//   settings — repo settings the human's token can converge via API
//   seeds    — missing baseline files a bot can propose via PR
//   human    — bootstrap steps no App on a user account can perform, plus
//              files that are deliberately per-repo (README, LICENSE)

// check name -> { source (template in this repo), target (path in the repo) }
export const SEEDS = {
  'AGENTS.md': { source: 'governance/baseline/AGENTS.md', target: 'AGENTS.md' },
  'CONTRIBUTING.md': { source: 'governance/baseline/CONTRIBUTING.md', target: 'CONTRIBUTING.md' },
  '.github/CODEOWNERS': { source: 'governance/baseline/CODEOWNERS', target: '.github/CODEOWNERS' },
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

// The standard default-branch ruleset for a repo that has none: the shape the
// governed repos share, minus required status checks (those are per-repo).
// Repository-admin bypass matches the existing rulesets — the solo human must
// stay able to merge their own PRs.
export function defaultRuleset() {
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
          allowed_merge_methods: ['merge'],
        },
      },
    ],
  };
}
