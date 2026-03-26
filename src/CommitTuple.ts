export interface MergeRequest {
  repo?: string;
  number: number;
  sha: string;
}

/**
 * Represents a set of commits to be merged together, serialized into a human-readable string.
 * 
 * Format: `commit-tuple-v0:<base_sha>[+<repo_name>#<pr_number>:<pr_sha>][+<pr_number>:<pr_sha>]...`
 * Example: `commit-tuple-v0:52e81b1b7d96...+2270:84de80649e...+skymp5-patches#4:256a2db3afe...`
 * 
 * Rationale behind this format:
 * 1. Readability: Semantic characters (+, #, :) make it significantly easier to read and debug than Base64 or minified JSON.
 * 2. Security & Stability: Full SHA hashes are used rather than short SHAs to guarantee uniqueness, security against collisions, and predictable length.
 * 3. Conciseness: The main repository's name is intentionally omitted from the base commit and its own PRs, as it is implicitly understood. Only additional repositories require the "repoName#" prefix.
 * 4. Versioning: Prefix "commit-tuple-vX:" is used to allow backward-compatible changes to the payload scheme in the future.
 */
export class CommitTuple {
  public baseSha: string;
  public prs: MergeRequest[];

  constructor(baseSha: string, prs: MergeRequest[] = []) {
    this.baseSha = baseSha;
    this.prs = prs;
  }

  /**
   * Parses a string of the format:
   * commit-tuple-v0:52e81b...+2270:84de80...+skymp5-patches#4:256a2d...
   */
  public static fromString(str: string): CommitTuple {
    if (!str || str.trim() === '') {
      throw new Error("CommitTuple string cannot be empty");
    }

    const versionPrefix = 'commit-tuple-v0:';
    if (!str.startsWith(versionPrefix)) {
      throw new Error(`Invalid version or format. Expected string to start with "${versionPrefix}"`);
    }

    const payload = str.slice(versionPrefix.length);
    const parts = payload.split('+');
    const baseSha = parts[0];
    const prs: MergeRequest[] = [];

    // Regular expression to parse elements (optional repository, PR number, SHA)
    // Group 1: Repository name (optional)
    // Group 2: PR number
    // Group 3: Commit SHA
    const prRegex = /^(?:([^#]+)#)?(\d+):([a-fA-F0-9]+)$/;

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const match = part.match(prRegex);

      if (!match) {
        throw new Error(`Invalid PR format in CommitTuple string at part "${part}"`);
      }

      const repo = match.at(1);
      const rawNumber = match.at(2);
      const sha = match.at(3);

      if (rawNumber === undefined) {
        throw new Error(`Missing PR number in CommitTuple string at part "${part}"`);
      }
      if (sha === undefined) {
        throw new Error(`Missing commit SHA in CommitTuple string at part "${part}"`);
      }

      const number = parseInt(rawNumber, 10);
      if (isNaN(number)) {
        throw new Error(`Invalid PR number "${rawNumber}" in CommitTuple string at part "${part}"`);
      }

      prs.push({ repo, number, sha });
    }

    return new CommitTuple(baseSha, prs);
  }

  /**
   * Converts the object back to a CommitTuple format string
   */
  public toString(): string {
    let result = `commit-tuple-v0:${this.baseSha}`;

    for (const pr of this.prs) {
      if (pr.repo) {
        result += `+${pr.repo}#${pr.number}:${pr.sha}`;
      } else {
        result += `+${pr.number}:${pr.sha}`;
      }
    }

    return result;
  }
}
