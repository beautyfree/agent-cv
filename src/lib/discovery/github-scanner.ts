/**
 * GitHub cloud repository scanner.
 * Lists user repos via API, builds Project objects, auto-detects username.
 *
 * No cloning. All data comes from GitHub REST API.
 */

import { createHash } from "node:crypto";
import type { Project, Inventory } from "../types.ts";
import { GitHubClient, GitHubAuthError, GitHubNotFoundError } from "./github-client.ts";
import { normalizeGitUrl } from "./git-metadata.ts";

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stargazers_count: number;
  fork: boolean;
  archived: boolean;
  private: boolean;
  created_at: string;
  pushed_at: string;
  updated_at: string;
  default_branch: string;
  html_url: string;
  owner: { login: string };
  size: number;
}

interface GitHubProfile {
  login: string;
  name: string | null;
  bio: string | null;
  avatar_url: string;
  company: string | null;
  location: string | null;
  blog: string | null;
  twitter_username: string | null;
  public_repos: number;
}

interface GitHubEvent {
  type: string;
  repo: { name: string };
  created_at: string;
}

export interface GitHubScanResult {
  projects: Project[];
  profile: GitHubProfile | null;
  starredRepos: Array<{ name: string; description: string | null; language: string | null; stars: number; url: string }>;
  contributions: Array<{ repo: string; type: string; date: string }>;
  errors: Array<{ context: string; error: string }>;
}

export interface GitHubScanOptions {
  includeForks?: boolean;
  onProgress?: (done: number, total: number, current: string) => void;
}

/**
 * Auto-detect GitHub username from existing inventory remoteUrls.
 * Parses github.com/{username}/ from all project remoteUrls,
 * returns the most common one.
 */
export function detectGitHubUsername(inventory: Inventory): string | null {
  const counts = new Map<string, number>();

  for (const project of inventory.projects) {
    if (!project.remoteUrl) continue;
    const normalized = normalizeGitUrl(project.remoteUrl);
    const match = normalized.match(/github\.com\/([^/]+)\//);
    if (match?.[1]) {
      const username = match[1].toLowerCase();
      counts.set(username, (counts.get(username) || 0) + 1);
    }
  }

  if (counts.size === 0) return null;

  // Return the most common username
  let best = "";
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Scan a GitHub user's repositories and profile.
 */
export async function scanGitHub(
  username: string,
  client: GitHubClient,
  options: GitHubScanOptions = {}
): Promise<GitHubScanResult> {
  const { includeForks = false, onProgress } = options;
  const errors: Array<{ context: string; error: string }> = [];

  // Fetch profile
  let profile: GitHubProfile | null = null;
  try {
    profile = await client.get<GitHubProfile>(`/users/${username}`);
  } catch (err: any) {
    if (err instanceof GitHubNotFoundError) {
      throw new Error(`GitHub user '${username}' not found. Check the username.`);
    }
    if (err instanceof GitHubAuthError) throw err;
    errors.push({ context: "profile", error: err.message });
  }

  // Fetch repos
  let repos: GitHubRepo[] = [];
  try {
    repos = await client.paginate<GitHubRepo>(`/users/${username}/repos?sort=pushed`);
  } catch (err: any) {
    if (err instanceof GitHubAuthError) throw err;
    errors.push({ context: "repos", error: err.message });
    return { projects: [], profile, starredRepos: [], contributions: [], errors };
  }

  // Filter forks unless opted in
  if (!includeForks) {
    repos = repos.filter(r => !r.fork);
  }

  // Build Project objects
  const projects: Project[] = [];
  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i]!;
    onProgress?.(i + 1, repos.length, repo.name);

    const id = createHash("sha256").update(`github:${repo.full_name}`).digest("hex").slice(0, 16);
    const tags: string[] = [];
    if (repo.archived) tags.push("archived");
    if (repo.fork) tags.push("fork");

    const createdDate = repo.created_at?.split("T")[0] || "";
    const pushedDate = repo.pushed_at?.split("T")[0] || "";

    projects.push({
      id,
      path: "",
      displayName: repo.name,
      type: detectProjectType(repo.language),
      language: repo.language || "Unknown",
      frameworks: repo.topics || [],
      dateRange: {
        start: createdDate,
        end: pushedDate,
        approximate: false,
      },
      hasGit: true,
      commitCount: 0, // not available from listing, populated during context build
      authorCommitCount: 0,
      hasUncommittedChanges: false,
      lastCommit: pushedDate,
      markers: [],
      size: { files: 0, lines: 0 },
      description: repo.description || undefined,
      topics: repo.topics.length > 0 ? repo.topics : undefined,
      tags,
      included: true,
      remoteUrl: repo.html_url,
      isPublic: !repo.private,
      stars: repo.stargazers_count,
      source: "github",
      isOwner: true, // user's own repos
    });
  }

  // Fetch starred repos (taste signal)
  let starredRepos: GitHubScanResult["starredRepos"] = [];
  try {
    const starred = await client.paginate<GitHubRepo>(`/users/${username}/starred`, 2); // cap at 200
    starredRepos = starred.map(r => ({
      name: r.full_name,
      description: r.description,
      language: r.language,
      stars: r.stargazers_count,
      url: r.html_url,
    }));
  } catch (err: any) {
    errors.push({ context: "starred", error: `Starred repos fetch failed: ${err.message}` });
  }

  // Fetch recent contributions (Events API, 90-day window)
  let contributions: GitHubScanResult["contributions"] = [];
  try {
    const events = await client.paginate<GitHubEvent>(`/users/${username}/events/public`, 3);
    const seen = new Set<string>();
    for (const event of events) {
      if (event.type === "PushEvent" || event.type === "PullRequestEvent") {
        // Skip own repos (already listed)
        const repoOwner = event.repo.name.split("/")[0]?.toLowerCase();
        if (repoOwner === username.toLowerCase()) continue;
        if (seen.has(event.repo.name)) continue;
        seen.add(event.repo.name);
        contributions.push({
          repo: event.repo.name,
          type: event.type === "PushEvent" ? "push" : "pull_request",
          date: event.created_at?.split("T")[0] || "",
        });
      }
    }
  } catch (err: any) {
    errors.push({ context: "events", error: `Contributions fetch failed: ${err.message}` });
  }

  return { projects, profile, starredRepos, contributions, errors };
}

function detectProjectType(language: string | null): string {
  if (!language) return "unknown";
  const map: Record<string, string> = {
    "TypeScript": "node", "JavaScript": "node",
    "Python": "python", "Rust": "rust", "Go": "go",
    "Ruby": "ruby", "Java": "java", "Kotlin": "java",
    "Swift": "swift", "Dart": "dart", "PHP": "php",
    "C#": "dotnet", "C++": "cpp", "C": "c",
    "Elixir": "elixir", "Shell": "shell",
  };
  return map[language] || "unknown";
}
