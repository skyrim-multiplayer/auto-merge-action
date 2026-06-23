import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { retry } from "@octokit/plugin-retry";
import * as exec from '@actions/exec';
import * as fs from "fs";
import * as pathModule from "path";
import * as streamBuffer from "stream-buffers";
import pLimit from 'p-limit';

interface Repository {
  owner: string,
  repo: string;
  labels: string[];
  token?: string;
}

type PullRequest = {
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
};

interface RefInfo {
  ref: string;
  lastCommitSha: string;
  lastCommitMessage: string;
  lastCommitAuthor: string;
  lastCommitAuthorDate: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prTitle: string;
}

interface BuildMetadata {
  runUrl?: string | null;
  abbrevRef?: string;
  baseCommitSha?: string;
  prs: PullRequest[];
  refs_info: Array<RefInfo>;
}

function sortPullRequests(pullRequests: PullRequest[]): PullRequest[] {
  return pullRequests.sort((a, b) => a.number - b.number);
}

async function handleMergeConflict(prNumber: number, stdout: string, stderr: string, path: string): Promise<never> {
  // Log detailed conflict information
  console.error(`\n${'='.repeat(80)}`);
  console.error(`MERGE CONFLICT DETECTED - PR #${prNumber}`);
  console.error(`${'='.repeat(80)}\n`);

  // Get list of conflicted files
  const conflictedFilesStdout = new streamBuffer.WritableStreamBuffer();
  const conflictStatusRes = await exec.exec('git status --porcelain', [], {
    cwd: path,
    ignoreReturnCode: true,
    outStream: conflictedFilesStdout
  });

  let conflictedFilesInfo = '';
  const conflictedFiles: string[] = [];

  if (conflictStatusRes === 0) {
    const statusOutput = conflictedFilesStdout.getContentsAsString('utf8') || '';
    conflictedFiles.push(...statusOutput
      .split('\n')
      .filter((line: string) => line.startsWith('UU ') || line.startsWith('AA ') || line.startsWith('DD '))
      .map((line: string) => line.substring(3).trim())
      .filter((file: string) => file.length > 0));

    if (conflictedFiles.length > 0) {
      console.error(`[!] Conflicted Files (${conflictedFiles.length}):`);
      conflictedFiles.forEach(file => console.error(`   - ${file}`));
      console.error('');
      conflictedFilesInfo = ` Conflicted files: ${conflictedFiles.join(', ')}.`;
    }
  }

  // Show conflict details for each conflicted file
  if (conflictedFiles.length > 0) {
    console.error(`[!] Conflict Details:\n`);
    for (const file of conflictedFiles) {
      try {
        const diffStdout = new streamBuffer.WritableStreamBuffer();
        const diffRes = await exec.exec('git', ['diff', file], {
          cwd: path,
          ignoreReturnCode: true,
          outStream: diffStdout
        });

        if (diffRes === 0) {
          const diffOutput = diffStdout.getContentsAsString('utf8') || '';
          if (diffOutput.trim()) {
            console.error(`${'-'.repeat(80)}`);
            console.error(`File: ${file}`);
            console.error(`${'-'.repeat(80)}`);
            console.error(diffOutput);
            console.error('');
          }
        }
      } catch (error) {
        console.error(`[!] Could not read conflict details for ${file}: ${error}\n`);
      }
    }
  }

  // Show git merge output
  console.error(`[!] Git Merge Output:`);
  console.error(`${'-'.repeat(80)}`);
  console.error(stdout);
  if (stderr.trim()) {
    console.error(`\n[!]  Stderr:`);
    console.error(stderr);
  }
  console.error(`${'-'.repeat(80)}\n`);

  // Reset the workspace to a clean state before throwing the error
  console.error(`[!] Resetting workspace to a clean state...`);
  await exec.exec('git reset --hard HEAD', [], { cwd: path });
  await exec.exec('git clean -fd', [], { cwd: path });

  console.error(`\n${'='.repeat(80)}`);
  console.error(`END OF CONFLICT REPORT`);
  console.error(`${'='.repeat(80)}\n`);

  // Throw the error to fail the action
  const errorMessage = `Merge of PR #${prNumber} resulted in conflicts.${conflictedFilesInfo}`;
  throw new Error(errorMessage);
}

async function execStdout(command: string, args: string[], { cwd }: { cwd: string }): Promise<string> {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const options = {
    cwd,
    listeners: {
      stdout: (data: Buffer) => {
        stdoutChunks.push(new Uint8Array(data));
      },
      stderr: (data: Buffer) => {
        stderrChunks.push(new Uint8Array(data));
      }
    }
  };

  await exec.exec(command, args, options);

  const stdout = Buffer.concat(stdoutChunks).toString();
  const stderr = Buffer.concat(stderrChunks).toString();

  if (stderr) {
    console.error(stderr);
  }
  return stdout.trim();
}

async function execWithRetry(command: string, args: string[], path: string, numRetries: number): Promise<void> {
  let ok = false;
  const errors = new Array<string>();
  const cmdDisplay = `${command}${args.length > 0 ? ' ' + args.join(' ') : ''}`;

  const baseDelayMs = 1000;
  const maxDelayMs = 30000;

  for (let i = 0; i < numRetries && !ok; ++i) {
    try {
      await exec.exec(command, args, { cwd: path });
      ok = true;
    } catch (e) {
      const errorMsg = `${e}`.split('\n')[0];
      errors.push(`Attempt ${i + 1}: ${errorMsg}`);
      
      // Apply exponential backoff with jitter if not the last attempt
      if (i < numRetries - 1) {
        const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, i));
        const jitter = Math.random() * 1000; // 0-1000ms jitter
        const totalDelay = exponentialDelay + jitter;
        
        console.log(`Waiting ${Math.round(totalDelay)}ms before retry ${i + 2}/${numRetries}...`);
        await new Promise(resolve => setTimeout(resolve, totalDelay));
      }
    }
  }
  
  if (!ok) {
    console.error(`Command '${cmdDisplay}' failed after ${numRetries} retries:`);
    errors.forEach(err => console.error(`  ${err}`));
    throw new Error(`Stopping action after ${errors.length} errors`);
  }
}

async function run() {
  try {
    const MyOctokit = Octokit.plugin(retry);

    const octokitsByAuthToken = new Map<string | undefined, InstanceType<typeof MyOctokit>>();

    let buildMetadata: BuildMetadata | null = null;

    const generateBuildMetadata = core.getInput('generate-build-metadata');
    const repositories: Repository[] = JSON.parse(core.getInput('repositories'));
    let path: string = core.getInput('path');
    let retries = parseInt(core.getInput('retries'));
    let fetchRetries = parseInt(core.getInput('fetch-retries'));
    let concurrencyLimit = parseInt(core.getInput('concurrency-limit'));

    const minRetries = 1;
    const maxRetries = 8192;
    const defaultRetries = 5;
    const defaultConcurrencyLimit = 10;

    if (!isFinite(retries) || retries < minRetries || retries > maxRetries) {
      console.warn(`Invalid retries value: ${core.getInput('retries')}. Value must be between ${minRetries} and ${maxRetries}. Using default of ${defaultRetries}.`);
      retries = defaultRetries;
    }

    if (!isFinite(fetchRetries) || fetchRetries < minRetries || fetchRetries > maxRetries) {
      console.warn(`Invalid fetch-retries value: ${core.getInput('fetch-retries')}. Value must be between ${minRetries} and ${maxRetries}. Using default of ${defaultRetries}.`);
      fetchRetries = defaultRetries;
    }

    if (!isFinite(concurrencyLimit) || concurrencyLimit < 1) {
      console.warn(`Invalid concurrency-limit value: ${core.getInput('concurrency-limit')}. Using default of ${defaultConcurrencyLimit}.`);
      concurrencyLimit = defaultConcurrencyLimit;
    }

    const limit = pLimit(concurrencyLimit);

    if (!path.endsWith('/')) {
      path += '/';
    }

    const skipGitConfig = core.getInput('skip-git-config') === 'true';

    if (!skipGitConfig) {
      await exec.exec('git config user.name "github-actions[bot]"', [], { cwd: path });
      await exec.exec('git config user.email "github-actions[bot]@users.noreply.github.com"', [], { cwd: path });
    }

    // Capture the original origin URL so we can restore it afterwards. This action
    // repoints origin at a token-authenticated URL to fetch PRs; without restoring
    // it the token is left baked into .git/config and subsequent pushes break.
    let originalOriginUrl: string | null = null;
    try {
      originalOriginUrl = await execStdout('git', ['remote', 'get-url', 'origin'], { cwd: path });
      console.log('[!] Saved original origin URL to restore after processing');
    } catch {
      originalOriginUrl = null;
      console.log('[!] No existing origin remote found; nothing to restore afterwards');
    }

    try {
    for (const repository of repositories) {
      const { repo, labels, token, owner } = repository;
      console.log(`Repository: ${repo}, Labels: ${labels.join(', ')}`);

      const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
      console.log(`[!] Setting remote origin URL to: https://x-access-token:***@github.com/${owner}/${repo}.git`);
      await exec.exec('git remote set-url origin', [remoteUrl], { cwd: path });

      console.log('[!] Fetching from new origin');
      await execWithRetry('git', ['fetch', 'origin'], path, fetchRetries);

      const abbrevRef = await execStdout('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path });
      const baseCommitSha = await execStdout('git', ['rev-parse', 'HEAD'], { cwd: path });
      console.log({ abbrevRef, baseCommitSha });

      const octokit = octokitsByAuthToken.get(token) ?? new MyOctokit({ auth: token, request: { retries } });
      octokitsByAuthToken.set(token, octokit);

      console.log(`Obtained an Octokit instance with token ${token ? '***' : 'undefined'}`);
      console.log(`Num Octokit instances cached: ${octokitsByAuthToken.size}`);

      let foundItems: Array<{ number: number }> = [];
      if (labels.length > 0) {
        const query = `repo:${owner}/${repo} is:pr is:open ${labels.map(label => `label:"${label}"`).join(' ')}`;
        console.log("Searching for PRs with query:", query);
        const searchResult = await octokit.search.issuesAndPullRequests({
          q: query,
        });
        foundItems = searchResult.data.items;
      } else {
        console.log('No labels supplied, not fetching any PRs');
      }

      console.log(`Found ${foundItems.length} PRs with required labels`);

      const pullRequests = await Promise.all(foundItems.map(issue =>
        limit(() => octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: issue.number
        }))
      ));

      const pullRequestsData = sortPullRequests(pullRequests.map(pr => pr.data));

      console.log(`Found ${pullRequestsData.length} open PRs with required labels`);

      for (const pr of pullRequestsData) {
        const prNumber = pr.number;
        const prBranch = pr.head.ref;
        const prAuthor = pr.user.login;
        const prSha = pr.head.sha;

        console.log(`[!] Processing PR #${prNumber} from ${prAuthor} with branch ${prBranch}`);

        console.log(`[!] Fetching PR #${prNumber} from remote`);
        await execWithRetry('git', ['fetch', 'origin', `pull/${prNumber}/head:${prBranch}`], path, fetchRetries);

        // Merge the PR branch
        console.log(`[!] Merging branch ${prBranch} (${prSha})`);
        const gitMergeStdout = new streamBuffer.WritableStreamBuffer();
        const gitMergeStderr = new streamBuffer.WritableStreamBuffer();
        const gitMergeRes = await exec.exec(`git merge ${prBranch}`, [], {
          cwd: path,
          ignoreReturnCode: true,
          outStream: gitMergeStdout,
          errStream: gitMergeStderr
        });

        if (gitMergeRes !== 0) {
          const stdout = gitMergeStdout.getContentsAsString('utf8') || '';
          const stderr = gitMergeStderr.getContentsAsString('utf8') || '';
          await handleMergeConflict(prNumber, stdout, stderr, path);
        }
      }

      // Generate build metadata
      if (generateBuildMetadata === 'true') {
        if (buildMetadata === null) {
          buildMetadata = {
            runUrl: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
            abbrevRef,
            baseCommitSha,
            refs_info: [],
            prs: [],
          };
        }
        console.log("Generating build metadata");

        for (const pr of pullRequestsData) {
          buildMetadata.prs.push(pr);
        }

        const promises = pullRequestsData.map((pr) => limit(async () => {
          const commit = await octokit.rest.git.getCommit({
            owner,
            repo,
            commit_sha: pr.head.sha
          });
          return {
            ref: pr.head.ref,
            info: {
              ref: pr.head.ref,
              lastCommitSha: pr.head.sha,
              lastCommitMessage: commit.data.message,
              lastCommitAuthor: commit.data.author.name,
              lastCommitAuthorDate: commit.data.author.date,
              repoOwner: owner,
              repoName: repo,
              prNumber: pr.number,
              prTitle: pr.title
            }
          };
        }));

        const results = await Promise.all(promises);
        results.forEach(result => {
          console.log(`Fetched commit sha: ${result.info.lastCommitSha}`);
          buildMetadata?.refs_info.push(result.info);
        });
      }
    }
    } finally {
      // Restore the original origin URL so we don't leave a token-authenticated
      // remote (or a remote pointed at the last processed repo) behind.
      if (originalOriginUrl) {
        console.log('[!] Restoring original origin URL');
        await exec.exec('git remote set-url origin', [originalOriginUrl], { cwd: path });
      }
    }

    if (buildMetadata === null) {
      console.log("No build metadata to write");
    } else {
      console.log("Build metadata:", buildMetadata);
      const p = pathModule.normalize(`${path}/build-metadata.json`);
      console.log("Writing build metadata to " + p);
      fs.writeFileSync(p, JSON.stringify(buildMetadata, null, 2));
    }
  } catch (error) {
    console.error(error);
    core.setFailed(`Action failed with error: ${error}`);
  }
}

run();
