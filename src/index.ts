import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { retry } from "@octokit/plugin-retry";
import * as exec from '@actions/exec';
import * as fs from "fs";
import * as pathModule from "path";
import * as streamBuffer from "stream-buffers";
import pLimit from 'p-limit';
import { CommitTuple, MergeRequest } from './CommitTuple';
import { gatherData, RepositoryConfig } from './gatherData';

interface Repository {
  owner: string,
  repo: string;
  labels?: string[];
  token?: string;
}

interface BuildMetadata {
  commitTuple: string;
}

function sortPullRequests<T extends { number: number }>(pullRequests: T[]): T[] {
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

    const generateBuildMetadata = core.getInput('generate-build-metadata');
    const repositories: Repository[] = JSON.parse(core.getInput('repositories'));
    let path: string = core.getInput('path');
    let retries = parseInt(core.getInput('retries'));
    let fetchRetries = parseInt(core.getInput('fetch-retries'));
    let concurrencyLimit = parseInt(core.getInput('concurrency-limit'));
    const mode = core.getInput('mode') || 'gather';
    const commitTupleInput = core.getInput('commit-tuple') || '';
    const baseRepo = core.getInput('base-repo') || '';

    if (mode !== 'gather' && mode !== 'exact' && mode !== 'gather_only') {
      throw new Error(`Invalid mode: "${mode}". Must be "gather", "exact", or "gather_only".`);
    }

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

    // Clear any extraheader credentials set by actions/checkout.
    // actions/checkout persists an AUTHORIZATION header via http.<url>.extraheader
    // that applies to all github.com requests. This overrides the per-repo
    // token we embed in the remote URL, causing "Repository not found" errors
    // when switching to repos the GITHUB_TOKEN doesn't have access to.
    await exec.exec(
      'git', ['config', '--local', '--unset-all', 'http.https://github.com/.extraheader'],
      { cwd: path, ignoreReturnCode: true }
    );

    // ── Step 1: Obtain the CommitTuple ──────────────────────────────────────
    let commitTuple: CommitTuple;

    if (mode === 'exact') {
      if (!commitTupleInput) {
        throw new Error('commit-tuple input is required in exact mode');
      }
      commitTuple = CommitTuple.fromString(commitTupleInput);
      console.log(`[exact] Parsed commit tuple: ${commitTuple.toString()}`);
      console.log(`[exact] Base SHA: ${commitTuple.baseSha}, PRs: ${commitTuple.prs.length}`);
    } else {
      // gather / gather_only mode: need baseSha from the first repo before calling gatherData
      const firstRepo = repositories[0];
      const firstRemoteUrl = `https://x-access-token:${firstRepo.token}@github.com/${firstRepo.owner}/${firstRepo.repo}.git`;
      console.log(`[gather] Setting remote to first repo to read base SHA`);
      await exec.exec('git remote set-url origin', [firstRemoteUrl], { cwd: path });
      await execWithRetry('git', ['fetch', 'origin'], path, fetchRetries);
      const baseSha = await execStdout('git', ['rev-parse', 'HEAD'], { cwd: path });
      console.log(`[gather] Base SHA: ${baseSha}`);

      const gatherResult = await gatherData({
        repositories: repositories as RepositoryConfig[],
        baseSha,
        retries,
        concurrencyLimit,
        primaryRepo: baseRepo || undefined,
      });
      commitTuple = gatherResult.commitTuple;
      console.log(`[gather] CommitTuple: ${commitTuple.toString()}`);
    }

    // Set the commit-tuple output for downstream steps
    core.setOutput('commit-tuple', commitTuple.toString());

    if (mode === 'gather_only') {
      console.log(`[gather_only] Done. commit-tuple: ${commitTuple.toString()}`);
      // Write build metadata and exit early — no merging
      if (generateBuildMetadata === 'true') {
        const buildMetadata: BuildMetadata = { commitTuple: commitTuple.toString() };
        const p = pathModule.normalize(`${path}/build-metadata.json`);
        console.log("Writing build metadata to " + p);
        fs.writeFileSync(p, JSON.stringify(buildMetadata, null, 2));
      }
      return;
    }

    // ── Step 2: Verify baseSha matches current HEAD ──────────────────────
    {
      // For the base repo, set remote and fetch to get current HEAD
      const baseRepoConfig = baseRepo
        ? repositories.find(r => `${r.owner}/${r.repo}` === baseRepo) ?? repositories[0]
        : repositories[0];
      const verifyRemoteUrl = `https://x-access-token:${baseRepoConfig.token}@github.com/${baseRepoConfig.owner}/${baseRepoConfig.repo}.git`;
      await exec.exec('git remote set-url origin', [verifyRemoteUrl], { cwd: path });
      await execWithRetry('git', ['fetch', 'origin'], path, fetchRetries);
      const currentHead = await execStdout('git', ['rev-parse', 'HEAD'], { cwd: path });

      if (currentHead !== commitTuple.baseSha) {
        throw new Error(
          `Base SHA mismatch: commit tuple expects ${commitTuple.baseSha} but current HEAD is ${currentHead}. ` +
          `The base branch may have moved since the commit tuple was created.`
        );
      }
      console.log(`[!] Base SHA verified: ${currentHead}`);
    }

    // ── Step 3: Merge PRs from the CommitTuple ─────────────────────────────
    const octokitsByAuthToken = new Map<string | undefined, InstanceType<typeof MyOctokit>>();

    for (const repository of repositories) {
      const { repo, token, owner } = repository;

      // Determine which PRs from the commit tuple belong to this repo
      const fullRepoName = `${owner}/${repo}`;
      const isBaseRepo = baseRepo ? fullRepoName === baseRepo : false;
      // If no base-repo specified, the first repo in the list is the base repo
      const isFirstRepo = repositories.indexOf(repository) === 0;
      const matchingPrs = commitTuple.prs.filter((pr: MergeRequest) => {
        if (pr.repo) {
          return pr.repo === repo;
        }
        // PRs without repo prefix belong to the base repo
        return baseRepo ? isBaseRepo : isFirstRepo;
      });

      if (matchingPrs.length === 0) {
        console.log(`[!] No PRs to merge for ${fullRepoName}, skipping`);
        continue;
      }

      console.log(`[!] Processing ${fullRepoName}: ${matchingPrs.length} PRs to merge`);

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

      // Fetch full PR data from the API (we need branch name, author, etc.)
      const prResponses = await Promise.all(matchingPrs.map(mr =>
        limit(async () => {
          const res = await octokit.rest.pulls.get({
            owner,
            repo,
            pull_number: mr.number
          });
          return { prData: res.data, targetSha: mr.sha };
        })
      ));

      const sortedPrs = sortPullRequests(prResponses.map(r => ({ number: r.prData.number, ...r })));

      for (const entry of sortedPrs) {
        const { prData, targetSha } = entry;
        const prNumber = prData.number;
        const prBranch = prData.head.ref;
        const prAuthor = prData.user.login;

        console.log(`[!] Processing PR #${prNumber} from ${prAuthor} with branch ${prBranch}`);

        console.log(`[!] Fetching PR #${prNumber} from remote`);
        await execWithRetry('git', ['fetch', 'origin', `pull/${prNumber}/head:${prBranch}`], path, fetchRetries);

        // If the current PR tip differs from our target, fetch the exact SHA
        const currentTipSha = prData.head.sha;
        if (currentTipSha !== targetSha) {
          console.log(`[!] Current PR tip (${currentTipSha}) differs from target (${targetSha}). Fetching exact target...`);
          await execWithRetry('git', ['fetch', 'origin', targetSha], path, fetchRetries);
        }

        // Point the branch ref to the exact target SHA
        await exec.exec('git', ['update-ref', `refs/heads/${prBranch}`, targetSha], { cwd: path });

        // Merge the PR branch
        console.log(`[!] Merging branch ${prBranch} (target: ${targetSha})`);
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

    }

    // ── Step 4: Write build metadata ──────────────────────────────────────
    if (generateBuildMetadata === 'true') {
      const buildMetadata: BuildMetadata = {
        commitTuple: commitTuple.toString(),
      };
      console.log("Build metadata:", buildMetadata);
      const p = pathModule.normalize(`${path}/build-metadata.json`);
      console.log("Writing build metadata to " + p);
      fs.writeFileSync(p, JSON.stringify(buildMetadata, null, 2));
    } else {
      console.log("Build metadata generation skipped");
    }
  } catch (error) {
    console.error(error);
    core.setFailed(`Action failed with error: ${error}`);
  }
}

run();
