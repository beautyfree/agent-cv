import simpleGit from "simple-git";

export interface GitMetadata {
  firstCommitDate: string;
  lastCommitDate: string;
  firstCommitAuthorEmail: string;
  authorFirstCommitDate: string;
  authorLastCommitDate: string;
  totalCommits: number;
  authorCommits: number;
  authorEmail: string;
  hasUncommittedChanges: boolean;
}

/**
 * Collect known user emails from reliable sources only.
 *
 * Reliable = things the user explicitly configured on their machine:
 * 1. Global git config (user.email)
 * 2. Per-directory git configs (includeIf in ~/.gitconfig)
 * 3. Repo-local git configs (git config --local user.email)
 * 4. Environment variables (GIT_AUTHOR_EMAIL)
 * 5. User-provided extras (--email flag)
 *
 * Does NOT use name matching or sole-committer heuristics.
 * Those produce false positives (common names, cloned repos).
 */
export async function collectUserEmails(
  extraEmails: string[] = []
): Promise<Set<string>> {
  const emails = new Set<string>();

  try {
    const git = simpleGit();

    // Global email
    try {
      const globalEmail = (
        await git.raw(["config", "--global", "user.email"])
      ).trim();
      if (globalEmail) emails.add(globalEmail.toLowerCase());
    } catch { /* no global email */ }

    // All emails from global config (catches includeIf conditional configs)
    try {
      const allConfig = await git.raw(["config", "--global", "--get-all", "user.email"]);
      for (const line of allConfig.split("\n")) {
        const email = line.trim();
        if (email && email.includes("@")) emails.add(email.toLowerCase());
      }
    } catch { /* single or no entries */ }
  } catch {
    // git not available
  }

  // Environment variables
  for (const envVar of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) {
    const val = process.env[envVar];
    if (val) emails.add(val.toLowerCase());
  }

  // User-provided extras
  for (const e of extraEmails) {
    if (e.includes("@")) emails.add(e.toLowerCase());
  }

  return emails;
}

/**
 * Discover the repo-local git config email.
 * This is reliable because the user set it themselves on their machine.
 * Returns the email if found, or null.
 */
export async function discoverRepoLocalEmail(
  dir: string
): Promise<string | null> {
  try {
    const git = simpleGit(dir);
    const localEmail = (
      await git.raw(["config", "--local", "user.email"])
    ).trim().toLowerCase();
    return localEmail || null;
  } catch {
    return null;
  }
}

/**
 * Collect ALL unique email addresses found across scanned repos.
 * Returns a map of email → number of repos it appears in.
 * No filtering. User picks their own from the list via search.
 */
const PARALLEL_BATCH = 10;

export async function collectAllRepoEmails(
  dirs: string[]
): Promise<Map<string, number>> {
  const emailCounts = new Map<string, number>();

  // Process repos in parallel batches of 10
  for (let i = 0; i < dirs.length; i += PARALLEL_BATCH) {
    const batch = dirs.slice(i, i + PARALLEL_BATCH);
    const results = await Promise.all(
      batch.map(async (dir) => {
        try {
          const git = simpleGit(dir);
          const shortlog = await git.raw(["shortlog", "-sne", "--no-merges", "HEAD"]);
          const emails: string[] = [];
          for (const line of shortlog.split("\n")) {
            const match = line.match(/<(.+?)>/);
            if (match?.[1]) emails.push(match[1].toLowerCase());
          }
          return emails;
        } catch {
          return [];
        }
      })
    );
    for (const emails of results) {
      for (const email of emails) {
        emailCounts.set(email, (emailCounts.get(email) || 0) + 1);
      }
    }
  }

  return emailCounts;
}

/**
 * Recount author commits for a single project.
 */
async function recountOne(
  dir: string,
  emails: string[]
): Promise<{ authorCommits: number; matchedEmail: string }> {
  let authorCommits = 0;
  let matchedEmail = "";
  try {
    const git = simpleGit(dir);
    for (const email of emails) {
      try {
        const count = await git.raw(["rev-list", "--count", "--author", email, "HEAD"]);
        const n = parseInt(count.trim(), 10) || 0;
        authorCommits += n;
        if (n > 0 && !matchedEmail) matchedEmail = email;
      } catch { /* ignore */ }
    }
  } catch { /* not a git repo */ }
  return { authorCommits, matchedEmail };
}

/**
 * Recount author commits for many projects in parallel batches.
 */
export async function recountAuthorCommitsBatch(
  projects: Array<{ path: string; hasGit: boolean }>,
  emails: string[]
): Promise<Map<string, { authorCommits: number; matchedEmail: string }>> {
  const results = new Map<string, { authorCommits: number; matchedEmail: string }>();

  const gitProjects = projects.filter((p) => p.hasGit);
  for (let i = 0; i < gitProjects.length; i += PARALLEL_BATCH) {
    const batch = gitProjects.slice(i, i + PARALLEL_BATCH);
    const batchResults = await Promise.all(
      batch.map(async (p) => ({
        path: p.path,
        result: await recountOne(p.path, emails),
      }))
    );
    for (const { path, result } of batchResults) {
      results.set(path, result);
    }
  }

  return results;
}

/**
 * Extract git metadata from a repository.
 * Counts commits matching ANY of the user's known emails.
 */
/**
 * Extract git metadata in a single pass.
 *
 * Old impl forked git up to (3 + 3*N) times per repo where N = #user emails.
 * New impl runs one `git log` (all commits, %aI %ae) plus one `status` in
 * parallel and aggregates everything in JS. ~6× fewer subprocesses on the
 * common single-email case, ~10× on multi-email setups.
 */
export async function extractGitMetadata(
  dir: string,
  userEmails: Set<string>
): Promise<GitMetadata | null> {
  try {
    const git = simpleGit(dir);

    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;

    const [statusOut, logOut] = await Promise.all([
      git.raw(["status", "--porcelain"]).catch(() => ""),
      // Tab-separated to avoid date/email ambiguity. Newest first.
      git.raw(["log", "--format=%aI%x09%ae", "HEAD"]).catch(() => ""),
    ]);

    const hasUncommittedChanges = statusOut.trim().length > 0;
    const lines = logOut.split("\n").filter(Boolean);

    if (lines.length === 0) {
      return {
        firstCommitDate: "",
        lastCommitDate: "",
        firstCommitAuthorEmail: "",
        authorFirstCommitDate: "",
        authorLastCommitDate: "",
        totalCommits: 0,
        authorCommits: 0,
        authorEmail: "",
        hasUncommittedChanges,
      };
    }

    // First line = newest commit; last line = oldest. Each line: "<aI>\t<email>".
    const parseLine = (l: string): { date: string; email: string } => {
      const tab = l.indexOf("\t");
      if (tab < 0) return { date: "", email: "" };
      return {
        date: l.slice(0, tab).split("T")[0] || "",
        email: l.slice(tab + 1).trim().toLowerCase(),
      };
    };

    const newest = parseLine(lines[0]!);
    const oldest = parseLine(lines[lines.length - 1]!);
    const lastCommitDate = newest.date;
    const firstCommitDate = oldest.date;
    const firstCommitAuthorEmail = oldest.email;

    let authorCommits = 0;
    let matchedEmail = "";
    let authorFirstCommitDate = "";
    let authorLastCommitDate = "";

    for (const raw of lines) {
      const { date, email } = parseLine(raw);
      if (!date || !email) continue;
      if (!userEmails.has(email)) continue;

      authorCommits++;
      if (!matchedEmail) matchedEmail = email;
      if (!authorLastCommitDate || date > authorLastCommitDate) authorLastCommitDate = date;
      if (!authorFirstCommitDate || date < authorFirstCommitDate) authorFirstCommitDate = date;
    }

    return {
      firstCommitDate,
      lastCommitDate,
      firstCommitAuthorEmail,
      authorFirstCommitDate,
      authorLastCommitDate,
      totalCommits: lines.length,
      authorCommits,
      authorEmail: matchedEmail,
      hasUncommittedChanges,
    };
  } catch {
    return null;
  }
}

/**
 * Extract the remote origin URL and normalize SSH → HTTPS.
 */
export async function extractRemoteUrl(dir: string): Promise<string | null> {
  try {
    const git = simpleGit(dir);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    if (!origin?.refs?.fetch) return null;

    return normalizeGitUrl(origin.refs.fetch);
  } catch {
    return null;
  }
}

/**
 * Normalize git remote URL to HTTPS format.
 * git@github.com:user/repo.git → https://github.com/user/repo
 * https://github.com/user/repo.git → https://github.com/user/repo
 */
export function normalizeGitUrl(url: string): string {
  // SSH format: git@github.com:user/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  // HTTPS with .git suffix
  return url.replace(/\.git$/, "");
}

/**
 * Parse github.com owner/repo from a normalized HTTPS remote URL.
 */
export function parseGitHubOwnerRepoFromUrl(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/i, "") };
}

