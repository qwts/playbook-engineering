const FULL_SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MERGE_QUEUE_HEAD = /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-(\d+)(?:-[^/]+)?$/u;

function assertRepository(repository) {
  if (!REPOSITORY.test(repository || '')) throw new Error('repository is invalid for release-origin lookup');
}

async function githubJson({ url, token, fetchImpl }) {
  if (!token) throw new Error('GitHub token is missing for release-origin lookup');
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`release-origin lookup failed with HTTP ${response.status}`);
  return response.json();
}

function assertPullRequest(pullRequest) {
  if (!pullRequest?.base || !pullRequest.head) {
    throw new Error('release-origin lookup returned malformed data');
  }
  return pullRequest;
}

/** The queue head ref is GitHub-owned and names the pull request the queue is validating now. */
export function mergeGroupHeadPullRequest(event) {
  const headRef = event.merge_group?.head_ref;
  const match = MERGE_QUEUE_HEAD.exec(headRef || '');
  if (!match) throw new Error(`merge_group head ref ${headRef || '<empty>'} is malformed`);
  return { baseRef: match[1], number: Number(match[2]) };
}

export async function getPullRequest({ repository, number, apiUrl, token, fetchImpl = fetch }) {
  assertRepository(repository);
  if (!apiUrl) throw new Error('GitHub REST endpoint is missing for release-origin lookup');
  const url = new URL(`/repos/${repository}/pulls/${number}`, apiUrl);
  return assertPullRequest(await githubJson({ url, token, fetchImpl }));
}

export async function listPullRequestsForCommit({ repository, sha, apiUrl, token, fetchImpl = fetch }) {
  assertRepository(repository);
  if (!FULL_SHA.test(sha || '')) throw new Error('commit SHA is invalid for release-origin lookup');
  if (!apiUrl) throw new Error('GitHub REST endpoint is missing for release-origin lookup');
  const url = new URL(`/repos/${repository}/commits/${sha}/pulls?per_page=100`, apiUrl);
  const pullRequests = await githubJson({ url, token, fetchImpl });
  if (!Array.isArray(pullRequests)) throw new Error('release-origin lookup returned malformed data');
  return pullRequests.map(assertPullRequest);
}

/**
 * The pull requests whose release policy governs this run. `pull_request` and `merge_group`
 * resolve to exactly one; manual and post-merge lanes resolve the exact commit's associated
 * pull requests, which may legitimately be none.
 */
export async function resolveReleaseOrigins(options) {
  if (options.eventName === 'pull_request') {
    if (!options.event.pull_request) throw new Error('pull_request event has no pull request payload');
    return [options.event.pull_request];
  }
  if (!options.lifecycle.generatedProjection) return [];
  if (options.eventName === 'merge_group') {
    const head = mergeGroupHeadPullRequest(options.event);
    return [await getPullRequest({ ...options, number: head.number })];
  }
  return listPullRequestsForCommit(options);
}
