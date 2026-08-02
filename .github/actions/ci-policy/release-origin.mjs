const FULL_SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MERGE_QUEUE_HEAD = /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-(\d+)(?:-[^/]+)?$/u;

const MERGE_QUEUE_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        mergeQueueEntry {
          position
          mergeQueue {
            entries(first: 100, after: $after) {
              nodes {
                position
                pullRequest {
                  number
                  baseRefName
                  headRefName
                  headRepository { nameWithOwner }
                  author { __typename login }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    }
  }
`;

function assertRepository(repository) {
  if (!REPOSITORY.test(repository || '')) throw new Error('repository is invalid for release-origin lookup');
}

function headers(token, json = false) {
  if (!token) throw new Error('GitHub token is missing for release-origin lookup');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function githubJson({ url, token, fetchImpl, body }) {
  if (!url) throw new Error('GitHub endpoint is missing for release-origin lookup');
  const response = await fetchImpl(url, {
    headers: headers(token, Boolean(body)),
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`release-origin lookup failed with HTTP ${response.status}`);
  const result = await response.json();
  if (result?.errors?.length) throw new Error('release-origin GraphQL lookup returned errors');
  return result;
}

export async function listPullRequestsForCommit({ repository, sha, apiUrl, token, fetchImpl = fetch }) {
  assertRepository(repository);
  if (!FULL_SHA.test(sha || '')) throw new Error('commit SHA is invalid for release-origin lookup');
  if (!apiUrl) throw new Error('GitHub REST endpoint is missing for release-origin lookup');
  const url = new URL(`/repos/${repository}/commits/${sha}/pulls?per_page=100`, apiUrl);
  const pullRequests = await githubJson({ url, token, fetchImpl });
  if (!Array.isArray(pullRequests)) throw new Error('release-origin lookup returned malformed data');
  return pullRequests;
}

export function mergeGroupHeadPullRequest(event) {
  const headRef = event.merge_group?.head_ref;
  const match = MERGE_QUEUE_HEAD.exec(headRef || '');
  if (!match) throw new Error(`merge_group head ref ${headRef || '<empty>'} is malformed`);
  return { baseRef: match[1], number: Number(match[2]) };
}

function normalizeQueuePullRequest(pullRequest) {
  const author = pullRequest.author;
  const login = author?.__typename === 'Bot' && !author.login.endsWith('[bot]')
    ? `${author.login}[bot]`
    : author?.login;
  return {
    base: { ref: pullRequest.baseRefName },
    head: { ref: pullRequest.headRefName, repo: { full_name: pullRequest.headRepository?.nameWithOwner } },
    user: { login },
  };
}

async function mergeQueuePage({ owner, name, number, after, graphqlUrl, token, fetchImpl }) {
  const body = { query: MERGE_QUEUE_QUERY, variables: { owner, name, number, after } };
  const result = await githubJson({ url: graphqlUrl, token, fetchImpl, body });
  const entry = result?.data?.repository?.pullRequest?.mergeQueueEntry;
  const entries = entry?.mergeQueue?.entries;
  if (!Number.isInteger(entry?.position) || !Array.isArray(entries?.nodes)) {
    throw new Error(`merge queue entry for pull request #${number} is unavailable`);
  }
  if (typeof entries.pageInfo?.hasNextPage !== 'boolean') {
    throw new Error('merge queue pagination data is malformed');
  }
  if (entries.pageInfo.hasNextPage && !entries.pageInfo.endCursor) {
    throw new Error('merge queue pagination cursor is missing');
  }
  return { headPosition: entry.position, ...entries };
}

export async function listMergeGroupPullRequests(options) {
  assertRepository(options.repository);
  const [owner, name] = options.repository.split('/');
  const head = mergeGroupHeadPullRequest(options.event);
  let after = null;
  let foundHead = false;
  const pullRequests = [];
  do {
    const page = await mergeQueuePage({ ...options, owner, name, number: head.number, after });
    for (const node of page.nodes) {
      if (node.position > page.headPosition || !node.pullRequest) continue;
      pullRequests.push(normalizeQueuePullRequest(node.pullRequest));
      foundHead ||= node.pullRequest.number === head.number;
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  if (!foundHead) throw new Error(`merge queue evidence omitted head pull request #${head.number}`);
  return pullRequests;
}

export async function resolveReleasePullRequests(options) {
  if (options.eventName === 'pull_request') {
    if (!options.event.pull_request) throw new Error('pull_request event has no pull request payload');
    return [options.event.pull_request];
  }
  if (options.lifecycle.metadataSystem === 'none') return [];
  const pullRequests = options.eventName === 'merge_group'
    ? await listMergeGroupPullRequests(options)
    : await listPullRequestsForCommit(options);
  if (pullRequests.length === 0) {
    throw new Error(`no pull request origin is available for governed ${options.eventName} event`);
  }
  return pullRequests;
}
