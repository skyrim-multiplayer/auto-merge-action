import { Octokit } from '@octokit/rest';
import { retry } from "@octokit/plugin-retry";
import pLimit from 'p-limit';
import { CommitTuple, MergeRequest } from './CommitTuple';

export interface RepositoryConfig {
  owner: string;
  repo: string;
  labels: string[];
  token?: string;
}

export interface GatheredPullRequest {
  number: number;
  title: string;
  user: {
    login: string;
  };
  head: {
    ref: string;
    sha: string;
  };
  labels: Array<{
    name: string;
  }>;
  commitMessage: string;
  commitAuthor: string;
  commitAuthorDate: string;
}

export interface GatheredRepository {
  owner: string;
  repo: string;
  pullRequests: GatheredPullRequest[];
}

export interface GatherResult {
  commitTuple: CommitTuple;
  repositories: GatheredRepository[];
}

export interface GatherOptions {
  repositories: RepositoryConfig[];
  baseSha: string;
  retries: number;
  concurrencyLimit: number;
  primaryRepo?: string;
}

function sortByNumber<T extends { number: number }>(items: T[]): T[] {
  return items.sort((a, b) => a.number - b.number);
}

/**
 * Atomically gathers all PR data from the GitHub API before any git operations.
 *
 * This eliminates race conditions where PR state could change between
 * the data-fetch phase and the merge phase. All API reads happen here,
 * producing a consistent snapshot represented as a CommitTuple plus
 * the full metadata needed for merging and build-metadata generation.
 */
export async function gatherData(options: GatherOptions): Promise<GatherResult> {
  const { repositories, baseSha, retries, concurrencyLimit, primaryRepo } = options;
  const limit = pLimit(concurrencyLimit);

  const MyOctokit = Octokit.plugin(retry);
  const octokitsByToken = new Map<string | undefined, InstanceType<typeof MyOctokit>>();

  function getOctokit(token?: string): InstanceType<typeof MyOctokit> {
    let octokit = octokitsByToken.get(token);
    if (!octokit) {
      octokit = new MyOctokit({ auth: token, request: { retries } });
      octokitsByToken.set(token, octokit);
    }
    return octokit;
  }

  const gatheredRepos: GatheredRepository[] = [];
  const mergeRequests: MergeRequest[] = [];

  for (const repoConfig of repositories) {
    const { owner, repo, labels, token } = repoConfig;
    const octokit = getOctokit(token);

    console.log(`[gather] Repository: ${owner}/${repo}, Labels: ${labels.join(', ')}`);

    // Search for PRs with the required labels
    let foundItems: Array<{ number: number }> = [];
    if (labels.length > 0) {
      const query = `repo:${owner}/${repo} is:pr is:open ${labels.map(label => `label:"${label}"`).join(' ')}`;
      console.log(`[gather] Searching PRs: ${query}`);
      const searchResult = await octokit.search.issuesAndPullRequests({ q: query });
      foundItems = searchResult.data.items;
    } else {
      console.log('[gather] No labels supplied, skipping');
    }

    console.log(`[gather] Found ${foundItems.length} matching PRs`);

    // Fetch full PR details + last commit details in parallel
    const prResults = await Promise.all(
      foundItems.map(issue =>
        limit(async () => {
          const [prResponse, commitResponse] = await Promise.all([
            octokit.rest.pulls.get({
              owner,
              repo,
              pull_number: issue.number,
            }),
            // We fetch commit details via the issue number indirectly:
            // first get the PR to know the head SHA, then fetch the commit.
            // To avoid a sequential dependency, we fetch the PR first,
            // then the commit in a second pass below.
            Promise.resolve(null),
          ]);
          return prResponse.data;
        })
      )
    );

    // Now fetch commit details for each PR (we need the head SHA from above)
    const prsWithCommits = await Promise.all(
      sortByNumber(prResults).map(pr =>
        limit(async () => {
          const commit = await octokit.rest.git.getCommit({
            owner,
            repo,
            commit_sha: pr.head.sha,
          });
          const gathered: GatheredPullRequest = {
            number: pr.number,
            title: pr.title,
            user: { login: pr.user.login },
            head: { ref: pr.head.ref, sha: pr.head.sha },
            labels: pr.labels.map(l => ({ name: l.name ?? '' })),
            commitMessage: commit.data.message,
            commitAuthor: commit.data.author.name,
            commitAuthorDate: commit.data.author.date,
          };
          return gathered;
        })
      )
    );

    console.log(`[gather] Gathered ${prsWithCommits.length} PRs from ${owner}/${repo}`);

    gatheredRepos.push({
      owner,
      repo,
      pullRequests: prsWithCommits,
    });

    // Build MergeRequests for the CommitTuple
    const isPrimary = primaryRepo ? repo === primaryRepo : gatheredRepos.length === 1;
    for (const pr of prsWithCommits) {
      mergeRequests.push({
        repo: isPrimary ? undefined : repo,
        number: pr.number,
        sha: pr.head.sha,
      });
    }
  }

  const commitTuple = new CommitTuple(baseSha, mergeRequests);

  console.log(`[gather] CommitTuple: ${commitTuple.toString()}`);
  console.log(`[gather] Total PRs across all repos: ${mergeRequests.length}`);

  return {
    commitTuple,
    repositories: gatheredRepos,
  };
}
