import { readdir, stat, access, readFile } from "node:fs/promises";
import simpleGit from "simple-git";
import { join, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Project } from "../types.ts";
import {
  extractGitMetadata,
  extractRemoteUrl,
  collectUserEmails,
  discoverRepoLocalEmail,
} from "./git-metadata.ts";
import { scanForSecrets } from "./privacy-auditor.ts";

/**
 * Directories to skip during recursive scan.
 * These never contain project root markers.
 */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  "__pycache__",
  ".next",
  ".nuxt",
  "target",
  ".venv",
  "venv",
  ".cache",
  ".turbo",
  ".output",
  "coverage",
  ".parcel-cache",
]);

/**
 * Project markers and their corresponding type/language.
 */
const PROJECT_MARKERS: Array<{
  file: string;
  type: string;
  language: string;
}> = [
  { file: "package.json", type: "node", language: "JavaScript" },
  { file: "Cargo.toml", type: "rust", language: "Rust" },
  { file: "go.mod", type: "go", language: "Go" },
  { file: "pyproject.toml", type: "python", language: "Python" },
  { file: "requirements.txt", type: "python", language: "Python" },
  { file: "setup.py", type: "python", language: "Python" },
  { file: "Gemfile", type: "ruby", language: "Ruby" },
  { file: "pom.xml", type: "java", language: "Java" },
  { file: "build.gradle", type: "java", language: "Java" },
  { file: "Makefile", type: "make", language: "C/C++" },
  { file: "Dockerfile", type: "docker", language: "Docker" },
  { file: "docker-compose.yml", type: "docker", language: "Docker" },
  { file: "docker-compose.yaml", type: "docker", language: "Docker" },
  { file: "pubspec.yaml", type: "dart", language: "Dart" },
  { file: "Package.swift", type: "swift", language: "Swift" },
  { file: "mix.exs", type: "elixir", language: "Elixir" },
  { file: "composer.json", type: "php", language: "PHP" },
];

export interface ScanOptions {
  maxDepth?: number;
  verbose?: boolean;
  /** Extra email addresses to recognize as "mine" (work, old, etc.) */
  emails?: string[];
  /** Called when a new project is found during scan */
  onProjectFound?: (project: Project, total: number) => void;
  /** Called when entering a new directory */
  onDirectoryEnter?: (dir: string) => void;
}

export interface ScanResult {
  projects: Project[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Scan a directory tree for IT projects.
 * Detects projects by filesystem markers, extracts metadata.
 * Zero LLM calls — git only for dates/author.
 */
export async function scanDirectory(
  rootPath: string,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const { maxDepth = 5, verbose = false, emails = [], onProjectFound, onDirectoryEnter } = options;
  const absRoot = resolve(rootPath);
  const projects: Project[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const foundProjectPaths = new Set<string>();

  // Collect known user emails from reliable sources
  const userEmails = await collectUserEmails(emails);
  if (verbose && userEmails.size > 0) {
    console.error(`  Git identities: ${[...userEmails].join(", ")}`);
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    onDirectoryEnter?.(dir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err.code === "EACCES") {
        errors.push({ path: dir, error: "Permission denied" });
        return;
      }
      if (err.code === "ENOENT") {
        errors.push({ path: dir, error: "Directory not found" });
        return;
      }
      if (err.code === "ELOOP") {
        errors.push({ path: dir, error: "Symlink loop detected" });
        return;
      }
      throw err;
    }

    // Check if this directory is a project (has markers)
    const detectedMarkers: string[] = [];
    let primaryMarker: (typeof PROJECT_MARKERS)[0] | undefined;

    for (const marker of PROJECT_MARKERS) {
      if (entries.some((e) => e.name === marker.file && e.isFile())) {
        detectedMarkers.push(marker.file);
        if (!primaryMarker) primaryMarker = marker;
      }
    }

    // Also check for .git as a standalone indicator
    const hasGit = entries.some(
      (e) => e.name === ".git" && (e.isDirectory() || e.isFile())
    );

    if (primaryMarker || hasGit) {
      // Nested project dedup: skip if a parent is already a project
      const isNested = [...foundProjectPaths].some((pp) =>
        dir.startsWith(pp + "/")
      );
      if (!isNested) {
        foundProjectPaths.add(dir);

        try {
          // Discover repo-local email (user configured it on this machine)
          if (hasGit) {
            const localEmail = await discoverRepoLocalEmail(dir);
            if (localEmail) userEmails.add(localEmail);
          }

          const project = await buildProject(
            dir,
            primaryMarker,
            detectedMarkers,
            hasGit,
            userEmails
          );
          projects.push(project);
          onProjectFound?.(project, projects.length);
          if (verbose) {
            console.error(`  Found: ${project.displayName} (${project.type})`);
          }
        } catch (err: any) {
          errors.push({ path: dir, error: err.message });
        }

        // Don't recurse into project subdirectories for more projects
        // (handles monorepo dedup — shallowest marker wins)
        return;
      }
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".git") continue;

      await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(absRoot, 0);

  // Sort by most recent first
  projects.sort((a, b) => {
    const dateA = a.dateRange.end || a.dateRange.start || "";
    const dateB = b.dateRange.end || b.dateRange.start || "";
    return dateB.localeCompare(dateA);
  });

  return { projects, errors };
}

async function buildProject(
  dir: string,
  primaryMarker: (typeof PROJECT_MARKERS)[0] | undefined,
  detectedMarkers: string[],
  hasGit: boolean,
  userEmails: Set<string>
): Promise<Project> {
  const name = basename(dir);
  const id = createHash("sha256").update(dir).digest("hex").slice(0, 16);

  // Detect language from package.json if it's a node project
  let language = primaryMarker?.language || "Unknown";
  let type = primaryMarker?.type || (hasGit ? "git" : "unknown");
  const frameworks: string[] = [];

  let description: string | undefined;
  let topics: string[] = [];
  let license: string | undefined;

  if (type === "node") {
    try {
      const pkg = await Bun.file(join(dir, "package.json")).json();
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps?.typescript || (await fileExists(join(dir, "tsconfig.json")))) {
        language = "TypeScript";
      }
      for (const [dep, fw] of [
        ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"],
        ["@angular/core", "Angular"], ["next", "Next.js"], ["nuxt", "Nuxt"],
        ["express", "Express"], ["fastify", "Fastify"], ["nest", "NestJS"],
        ["electron", "Electron"], ["hono", "Hono"], ["elysia", "Elysia"],
        ["astro", "Astro"], ["remix", "Remix"], ["solid-js", "Solid"],
        ["@tanstack/react-query", "TanStack Query"], ["prisma", "Prisma"],
        ["drizzle-orm", "Drizzle"], ["trpc", "tRPC"], ["@trpc/server", "tRPC"],
      ] as const) {
        if (allDeps?.[dep]) frameworks.push(fw);
      }
      if (pkg.description) description = pkg.description;
      if (Array.isArray(pkg.keywords)) topics = pkg.keywords;
      if (pkg.license) license = pkg.license;
    } catch { /* ignore */ }
  } else if (type === "python") {
    try {
      const content = await readFile(join(dir, "requirements.txt"), "utf-8").catch(() => "");
      for (const [pattern, fw] of [
        ["django", "Django"], ["flask", "Flask"], ["fastapi", "FastAPI"],
        ["celery", "Celery"], ["sqlalchemy", "SQLAlchemy"], ["pandas", "Pandas"],
        ["numpy", "NumPy"], ["torch", "PyTorch"], ["tensorflow", "TensorFlow"],
      ] as const) {
        if (content.toLowerCase().includes(pattern)) frameworks.push(fw);
      }
    } catch { /* ignore */ }
  } else if (type === "rust") {
    try {
      const content = await readFile(join(dir, "Cargo.toml"), "utf-8").catch(() => "");
      for (const [pattern, fw] of [
        ["actix", "Actix"], ["tokio", "Tokio"], ["axum", "Axum"],
        ["serde", "Serde"], ["warp", "Warp"], ["rocket", "Rocket"],
        ["tauri", "Tauri"], ["bevy", "Bevy"],
      ] as const) {
        if (content.toLowerCase().includes(pattern)) frameworks.push(fw);
      }
      const descMatch = content.match(/description\s*=\s*"([^"]+)"/);
      if (descMatch?.[1]) description = descMatch[1];
      const licMatch = content.match(/license\s*=\s*"([^"]+)"/);
      if (licMatch?.[1]) license = licMatch[1];
    } catch { /* ignore */ }
  } else if (type === "go") {
    try {
      const content = await readFile(join(dir, "go.mod"), "utf-8").catch(() => "");
      for (const [pattern, fw] of [
        ["gin-gonic", "Gin"], ["gofiber", "Fiber"], ["echo", "Echo"],
        ["gorilla/mux", "Gorilla"], ["grpc", "gRPC"],
      ] as const) {
        if (content.includes(pattern)) frameworks.push(fw);
      }
    } catch { /* ignore */ }
  }

  // License fallback: check for LICENSE file
  if (!license) {
    try {
      const licContent = await readFile(join(dir, "LICENSE"), "utf-8").catch(
        () => readFile(join(dir, "LICENSE.md"), "utf-8").catch(() => "")
      );
      if (licContent.includes("MIT")) license = "MIT";
      else if (licContent.includes("Apache")) license = "Apache-2.0";
      else if (licContent.includes("GPL")) license = "GPL";
      else if (licContent.includes("BSD")) license = "BSD";
      else if (licContent.length > 0) license = "Other";
    } catch { /* ignore */ }
  }

  // Fallback: detect language by file extensions if still Unknown
  if (language === "Unknown") {
    language = await detectLanguageByFiles(dir);
  }

  // Git metadata (dates, commits)
  const gitMeta = hasGit ? await extractGitMetadata(dir, userEmails) : null;

  // Date range: prefer author's own commits, fall back to all commits, then file dates
  let dateRange = { start: "", end: "", approximate: true };

  if (gitMeta?.authorFirstCommitDate) {
    // Best case: user has commits in this repo
    let start = gitMeta.authorFirstCommitDate;
    let end = gitMeta.authorLastCommitDate || start;
    // Guard against swapped dates (can happen with multi-email iteration)
    if (start > end) [start, end] = [end, start];
    dateRange.start = start;
    dateRange.end = end;
    dateRange.approximate = false;
  } else if (gitMeta && gitMeta.totalCommits === 0) {
    // git init but no commits — use file dates
    const fileDates = await getFileDates(dir);
    dateRange.start = fileDates.start;
    dateRange.end = fileDates.end;
  } else if (gitMeta) {
    // Cloned repo, no user commits — use .git/HEAD birthtime (clone date)
    const cloneDate = await getGitCreationDate(dir);
    dateRange.start = cloneDate || gitMeta.firstCommitDate;
    dateRange.end = gitMeta.lastCommitDate;
  } else {
    // No git at all — use file dates
    const fileDates = await getFileDates(dir);
    dateRange.start = fileDates.start;
    dateRange.end = fileDates.end;
  }

  // Final guard: ensure start <= end for all paths
  if (dateRange.start && dateRange.end && dateRange.start > dateRange.end) {
    [dateRange.start, dateRange.end] = [dateRange.end, dateRange.start];
  }

  // Privacy audit
  const privacyAudit = await scanForSecrets(dir);

  // Count files and lines via git or fallback
  let fileCount = 0;
  let lineCount = 0;
  if (hasGit) {
    try {
      const git = simpleGit(dir);
      const files = await git.raw(["ls-files"]);
      const fileList = files.trim().split("\n").filter(Boolean);
      fileCount = fileList.length;
      // Count lines (fast: use git's built-in)
      try {
        const stats = await git.raw(["diff", "--stat", "--diff-filter=ACMR", "4b825dc642cb6eb9a060e54bf899d15f3f338fb9", "HEAD"]);
        const lastLine = stats.trim().split("\n").pop() || "";
        const insMatch = lastLine.match(/(\d+) insertion/);
        if (insMatch) lineCount = parseInt(insMatch[1]!, 10);
      } catch { /* no commits */ }
    } catch { /* fallback */ }
  }
  if (fileCount === 0) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      fileCount = entries.filter((e) => e.isFile()).length;
    } catch { /* ignore */ }
  }

  return {
    id,
    path: dir,
    displayName: name,
    type,
    language,
    frameworks,
    dateRange,
    hasGit,
    commitCount: gitMeta?.totalCommits ?? 0,
    authorCommitCount: gitMeta?.authorCommits ?? 0,
    hasUncommittedChanges: gitMeta?.hasUncommittedChanges ?? false,
    lastCommit: gitMeta?.lastCommitDate,
    markers: hasGit
      ? [...detectedMarkers, ".git"]
      : detectedMarkers,
    size: { files: fileCount, lines: lineCount },
    description,
    topics: topics.length > 0 ? topics : undefined,
    license,
    privacyAudit,
    tags: [],
    included: true,
    remoteUrl: hasGit ? await extractRemoteUrl(dir) : undefined,
    authorEmail: gitMeta?.authorEmail,
    isOwner: gitMeta?.firstCommitAuthorEmail
      ? userEmails.has(gitMeta.firstCommitAuthorEmail)
      : !hasGit, // no git = user created this folder
  };
}

/**
 * Get the creation date of .git/HEAD — reflects when git init or git clone happened.
 */
async function getGitCreationDate(dir: string): Promise<string> {
  try {
    const headStat = await stat(join(dir, ".git", "HEAD"));
    return headStat.birthtime.toISOString().split("T")[0] || "";
  } catch {
    return "";
  }
}

/**
 * Walk top-level files to find min birthtime and max mtime.
 * Used when git has no commits or no git at all.
 */
async function getFileDates(dir: string): Promise<{ start: string; end: string }> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let minBirth = Infinity;
    let maxMtime = 0;

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      try {
        const s = await stat(join(dir, entry.name));
        const birth = s.birthtime.getTime();
        const mtime = s.mtime.getTime();
        if (birth < minBirth) minBirth = birth;
        if (mtime > maxMtime) maxMtime = mtime;
      } catch { /* skip */ }
    }

    if (minBirth === Infinity) return { start: "", end: "" };
    return {
      start: new Date(minBirth).toISOString().split("T")[0] || "",
      end: new Date(maxMtime).toISOString().split("T")[0] || "",
    };
  } catch {
    return { start: "", end: "" };
  }
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".rb": "Ruby",
  ".java": "Java", ".kt": "Kotlin",
  ".swift": "Swift",
  ".cs": "C#",
  ".cpp": "C++", ".cc": "C++", ".c": "C", ".h": "C",
  ".php": "PHP",
  ".ex": "Elixir", ".exs": "Elixir",
  ".dart": "Dart",
  ".lua": "Lua",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
  ".yml": "YAML", ".yaml": "YAML",
  ".sol": "Solidity",
  ".html": "HTML", ".htm": "HTML",
  ".css": "CSS", ".scss": "CSS", ".less": "CSS",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".fc": "FunC",
  ".circom": "Circom",
  ".move": "Move",
  ".zig": "Zig",
  ".r": "R",
  ".jl": "Julia",
  ".scala": "Scala",
  ".clj": "Clojure",
  ".hs": "Haskell",
  ".erl": "Erlang",
  ".elm": "Elm",
  ".ml": "OCaml",
  ".pbxproj": "Swift",
};

async function detectLanguageByFiles(dir: string): Promise<string> {
  try {
    const counts = new Map<string, number>();
    const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", "__pycache__", ".next", "vendor", ".turbo"]);

    // Walk up to 3 levels deep to find code files
    async function walk(d: string, depth: number) {
      if (depth > 3) return;
      const entries = await readdir(d, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIP.has(entry.name)) {
          await walk(join(d, entry.name), depth + 1);
        }
        if (!entry.isFile()) continue;
        const dot = entry.name.lastIndexOf(".");
        if (dot < 0) continue;
        const ext = entry.name.slice(dot).toLowerCase();
        const lang = EXT_TO_LANG[ext];
        if (lang) counts.set(lang, (counts.get(lang) || 0) + 1);
      }
    }

    await walk(dir, 0);

    if (counts.size === 0) return "Unknown";

    let best = "Unknown";
    let bestCount = 0;
    for (const [lang, count] of counts) {
      if (count > bestCount) { best = lang; bestCount = count; }
    }
    return best;
  } catch {
    return "Unknown";
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
