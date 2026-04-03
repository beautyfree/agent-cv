import simpleGit from "simple-git";

export interface GitMetadata {
  firstCommitDate: string;
  lastCommitDate: string;
  totalCommits: number;
  authorCommits: number;
  authorEmail: string;
}

/**
 * Extract git metadata from a repository.
 * Uses simple-git for date/author extraction.
 * Returns null if git operations fail.
 */
export async function extractGitMetadata(
  dir: string
): Promise<GitMetadata | null> {
  try {
    const git = simpleGit(dir);

    // Check if it's actually a git repo
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;

    // Get author email
    let authorEmail = "";
    try {
      authorEmail = (await git.raw(["config", "user.email"])).trim();
    } catch {
      // No user.email configured, use empty
    }

    // Get total commit count
    let totalCommits = 0;
    try {
      const countOutput = await git.raw(["rev-list", "--count", "HEAD"]);
      totalCommits = parseInt(countOutput.trim(), 10) || 0;
    } catch {
      // Possibly empty repo
      return null;
    }

    // Get first and last commit dates
    let firstCommitDate = "";
    let lastCommitDate = "";
    try {
      const firstLog = await git.raw([
        "log",
        "--reverse",
        "--format=%aI",
        "--max-count=1",
      ]);
      firstCommitDate = firstLog.trim().split("T")[0] || "";

      const lastLog = await git.raw(["log", "--format=%aI", "--max-count=1"]);
      lastCommitDate = lastLog.trim().split("T")[0] || "";
    } catch {
      // Can't get dates
    }

    // Get author commit count
    let authorCommits = 0;
    if (authorEmail) {
      try {
        const authorCount = await git.raw([
          "rev-list",
          "--count",
          "--author",
          authorEmail,
          "HEAD",
        ]);
        authorCommits = parseInt(authorCount.trim(), 10) || 0;
      } catch {
        // ignore
      }
    }

    return {
      firstCommitDate,
      lastCommitDate,
      totalCommits,
      authorCommits,
      authorEmail,
    };
  } catch {
    // Git not installed or corrupted repo
    return null;
  }
}
