/**
 * Cloud project context builder.
 * Fetches README, deps, directory tree, and commits from GitHub API
 * to build a ProjectContext for LLM analysis. No cloning needed.
 *
 *   GitHub API           cloud-context-builder         LLM adapter
 *   ──────────           ─────────────────────         ───────────
 *   /readme         ──▶  readme (base64 decode)   ──▶
 *   /git/trees      ──▶  directoryTree + manifest ──▶  ProjectContext
 *   /commits        ──▶  recentCommits            ──▶
 *   /contributors   ──▶  gitShortlog              ──▶
 */

import type { Project, ProjectContext } from "../types.ts";
import { GitHubClient } from "../discovery/github-client.ts";

const BUDGET = {
  readme: 4000,
  dependencies: 2000,
  tree: 2000,
  shortlog: 2000,
  commits: 6000,
};

const MANIFEST_FILES = [
  "package.json", "Cargo.toml", "go.mod", "pyproject.toml",
  "requirements.txt", "Gemfile", "composer.json", "pubspec.yaml",
  "mix.exs", "pom.xml", "build.gradle",
];

/**
 * Build a ProjectContext for a cloud-sourced project using GitHub API.
 */
export async function buildCloudProjectContext(
  project: Project,
  client: GitHubClient
): Promise<ProjectContext> {
  const repoPath = extractRepoPath(project.remoteUrl || "");
  if (!repoPath) {
    return emptyContext(project);
  }

  // Fetch tree first — it gives us both directory structure and manifest detection
  const { directoryTree, manifestFile } = await fetchTree(repoPath, client);

  // Fetch README, deps, and commits in parallel
  const [readme, dependencies, commitsData, contributors] = await Promise.all([
    fetchReadme(repoPath, client),
    manifestFile ? fetchFileContent(repoPath, manifestFile, client) : Promise.resolve(""),
    fetchRecentCommits(repoPath, client),
    fetchContributors(repoPath, client),
  ]);

  return {
    path: "",
    readme: truncate(readme, BUDGET.readme),
    dependencies: truncate(formatDependencies(dependencies, manifestFile), BUDGET.dependencies),
    directoryTree: truncate(directoryTree, BUDGET.tree),
    gitShortlog: truncate(contributors, BUDGET.shortlog),
    recentCommits: truncate(commitsData, BUDGET.commits),
    previousAnalysis: project.analysis,
  };
}

function emptyContext(project: Project): ProjectContext {
  return {
    path: "",
    readme: project.description || "",
    dependencies: "",
    directoryTree: "",
    gitShortlog: "",
    recentCommits: "",
    previousAnalysis: project.analysis,
  };
}

/**
 * Extract owner/repo from a GitHub URL.
 */
function extractRepoPath(url: string): string | null {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? match[1]!.replace(/\.git$/, "") : null;
}

async function fetchReadme(repoPath: string, client: GitHubClient): Promise<string> {
  try {
    const data = await client.get<{ content: string; encoding: string }>(
      `/repos/${repoPath}/readme`
    );
    if (data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return data.content || "";
  } catch {
    return "";
  }
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
}

async function fetchTree(
  repoPath: string,
  client: GitHubClient
): Promise<{ directoryTree: string; manifestFile: string | null }> {
  try {
    // Get default branch SHA from the repo endpoint (already fetched in scanner, but cheap)
    const repo = await client.get<{ default_branch: string }>(`/repos/${repoPath}`);
    const branch = repo.default_branch || "main";

    const data = await client.get<{ tree: TreeEntry[]; truncated: boolean }>(
      `/repos/${repoPath}/git/trees/${branch}?recursive=1`
    );

    // Build directory tree (2 levels deep)
    const lines: string[] = [];
    let manifestFile: string | null = null;
    const manifestSet = new Set(MANIFEST_FILES);

    for (const entry of data.tree || []) {
      // Check for manifest at root level
      if (entry.type === "blob" && manifestSet.has(entry.path)) {
        if (!manifestFile) manifestFile = entry.path;
      }

      // Only show 2 levels deep for the tree display
      const depth = entry.path.split("/").length;
      if (depth <= 3) {
        const prefix = entry.type === "tree" ? "📁 " : "   ";
        lines.push(`${prefix}${entry.path}`);
      }
    }

    if (data.truncated) {
      lines.push("...(tree truncated, repo too large)");
    }

    return {
      directoryTree: lines.slice(0, 100).join("\n"),
      manifestFile,
    };
  } catch {
    return { directoryTree: "", manifestFile: null };
  }
}

async function fetchFileContent(
  repoPath: string,
  filePath: string,
  client: GitHubClient
): Promise<string> {
  try {
    const data = await client.get<{ content: string; encoding: string }>(
      `/repos/${repoPath}/contents/${filePath}`
    );
    if (data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return data.content || "";
  } catch {
    return "";
  }
}

async function fetchRecentCommits(repoPath: string, client: GitHubClient): Promise<string> {
  try {
    const commits = await client.get<Array<{
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
    }>>(`/repos/${repoPath}/commits?per_page=50`);

    return (commits || [])
      .map(c => `${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]}`)
      .join("\n");
  } catch {
    return "";
  }
}

async function fetchContributors(repoPath: string, client: GitHubClient): Promise<string> {
  try {
    const contributors = await client.get<Array<{
      login: string;
      contributions: number;
    }>>(`/repos/${repoPath}/contributors?per_page=20`);

    return (contributors || [])
      .map(c => `  ${String(c.contributions).padStart(6)} ${c.login}`)
      .join("\n");
  } catch {
    return "";
  }
}

function formatDependencies(content: string, manifestFile: string | null): string {
  if (!content || !manifestFile) return "";

  if (manifestFile === "package.json") {
    try {
      const parsed = JSON.parse(content);
      const deps = {
        name: parsed.name,
        description: parsed.description,
        dependencies: Object.keys(parsed.dependencies ?? {}),
        devDependencies: Object.keys(parsed.devDependencies ?? {}),
      };
      return JSON.stringify(deps, null, 2);
    } catch {
      return content;
    }
  }

  return content;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...(truncated)";
}
