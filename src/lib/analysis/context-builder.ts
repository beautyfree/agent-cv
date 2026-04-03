import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import simpleGit from "simple-git";
import type { Project, ProjectContext } from "../types.ts";

/**
 * Token budget per context section.
 * Approximate: 1 token ~ 4 characters.
 */
const BUDGET = {
  readme: 4000, // ~1K tokens
  dependencies: 2000, // ~500 tokens
  tree: 2000, // ~500 tokens
  shortlog: 2000, // ~500 tokens
  commits: 6000, // ~1.5K tokens
};

/**
 * Build the context payload for LLM analysis.
 * Collects README, deps, tree, git info from a project directory.
 * Respects privacy audit exclusions.
 */
export async function buildProjectContext(
  project: Project
): Promise<ProjectContext> {
  const dir = project.path;
  const excluded = new Set(project.privacyAudit?.excludedFiles ?? []);

  const readme = await getReadme(dir, excluded);
  const dependencies = await getDependencies(dir, excluded);
  const directoryTree = await getDirectoryTree(dir, excluded);
  const gitShortlog = project.hasGit ? await getGitShortlog(dir) : "";
  const recentCommits = project.hasGit ? await getRecentCommits(dir) : "";

  return {
    path: dir,
    readme,
    dependencies,
    directoryTree,
    gitShortlog,
    recentCommits,
  };
}

async function getReadme(
  dir: string,
  excluded: Set<string>
): Promise<string> {
  const candidates = ["README.md", "README", "readme.md", "README.rst"];
  for (const name of candidates) {
    if (excluded.has(name)) continue;
    try {
      const content = await readFile(join(dir, name), "utf-8");
      return truncate(content, BUDGET.readme);
    } catch {
      continue;
    }
  }
  return "";
}

async function getDependencies(
  dir: string,
  excluded: Set<string>
): Promise<string> {
  // Try package.json first
  if (!excluded.has("package.json")) {
    try {
      const pkg = await readFile(join(dir, "package.json"), "utf-8");
      const parsed = JSON.parse(pkg);
      const deps = {
        name: parsed.name,
        description: parsed.description,
        dependencies: Object.keys(parsed.dependencies ?? {}),
        devDependencies: Object.keys(parsed.devDependencies ?? {}),
      };
      return truncate(JSON.stringify(deps, null, 2), BUDGET.dependencies);
    } catch {
      // fall through
    }
  }

  // Try other manifests
  const manifests = [
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "requirements.txt",
    "Gemfile",
    "composer.json",
  ];
  for (const name of manifests) {
    if (excluded.has(name)) continue;
    try {
      const content = await readFile(join(dir, name), "utf-8");
      return truncate(content, BUDGET.dependencies);
    } catch {
      continue;
    }
  }
  return "";
}

async function getDirectoryTree(
  dir: string,
  excluded: Set<string>
): Promise<string> {
  const lines: string[] = [];
  const SKIP = new Set([
    "node_modules", ".git", "dist", "build", "vendor",
    "__pycache__", ".next", "target", ".venv", "coverage",
  ]);

  async function walk(path: string, prefix: string, depth: number) {
    if (depth > 2) return;
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const sorted = entries
        .filter((e) => !SKIP.has(e.name) && !excluded.has(e.name))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) {
            return a.isDirectory() ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

      for (const entry of sorted) {
        const isLast = entry === sorted[sorted.length - 1];
        const connector = isLast ? "└── " : "├── ";
        const suffix = entry.isDirectory() ? "/" : "";
        lines.push(`${prefix}${connector}${entry.name}${suffix}`);

        if (entry.isDirectory() && depth < 2) {
          const newPrefix = prefix + (isLast ? "    " : "│   ");
          await walk(join(path, entry.name), newPrefix, depth + 1);
        }
      }
    } catch {
      // Can't read directory
    }
  }

  await walk(dir, "", 0);
  return truncate(lines.join("\n"), BUDGET.tree);
}

async function getGitShortlog(dir: string): Promise<string> {
  try {
    const git = simpleGit(dir);
    const shortlog = await git.raw(["shortlog", "-sn", "--no-merges", "HEAD"]);
    return truncate(shortlog, BUDGET.shortlog);
  } catch {
    return "";
  }
}

async function getRecentCommits(dir: string): Promise<string> {
  try {
    const git = simpleGit(dir);
    const log = await git.raw([
      "log",
      "--oneline",
      "--no-merges",
      "-50",
    ]);
    return truncate(log, BUDGET.commits);
  } catch {
    return "";
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...(truncated)";
}
