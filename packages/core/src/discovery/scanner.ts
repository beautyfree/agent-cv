import { readdir, stat, access, readFile } from "node:fs/promises";
import simpleGit from "simple-git";
import { join, basename, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import ignore, { type Ignore } from "ignore";
import type { Project } from "../types.ts";
import { extractGitMetadata, extractRemoteUrl, collectUserEmails, discoverRepoLocalEmail } from "./git-metadata.ts";
import { scanForSecrets } from "./privacy-auditor.ts";

/**
 * Directories to skip during recursive scan.
 * These never contain project root markers. Acts as baseline floor in addition
 * to any .gitignore rules we accumulate while walking.
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
  ".svelte-kit",
  "target",
  ".venv",
  "venv",
  ".cache",
  ".turbo",
  ".output",
  ".vercel",
  "coverage",
  ".parcel-cache",
  ".gradle",
  ".idea",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "bower_components",
  ".yarn",
  ".pnpm-store",
  "Pods",
  "DerivedData",
]);

/** Concurrency cap for parallel directory walk. */
const WALK_CONCURRENCY = (() => {
  const env = Number(process.env.AGENT_CV_SCAN_CONCURRENCY);
  return Number.isFinite(env) && env > 0 ? env : 16;
})();

/**
 * Tiny semaphore — caps in-flight async operations to avoid EMFILE / fork bombs.
 */
function makeSemaphore(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((res) => queue.push(res));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

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
  /** When aborted, walk stops and the scan rejects with AbortError */
  signal?: AbortSignal;
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
export async function scanDirectory(rootPath: string, options: ScanOptions = {}): Promise<ScanResult> {
  const { maxDepth = 5, verbose = false, emails = [], onProjectFound, onDirectoryEnter, signal } = options;
  const absRoot = resolve(rootPath);
  const projects: Project[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const foundProjectPaths = new Set<string>();

  // Collect known user emails from reliable sources
  const userEmails = await collectUserEmails(emails);
  if (verbose && userEmails.size > 0) {
    console.error(`  Git identities: ${[...userEmails].join(", ")}`);
  }
  signal?.throwIfAborted();

  const limit = makeSemaphore(WALK_CONCURRENCY);

  /**
   * Load .gitignore at `dir` (if present) and return a child Ignore matcher.
   * Matchers are stacked: a directory's matcher is parent + own .gitignore.
   * Paths fed to the matcher are relative to `dir` and never start with "/".
   */
  async function loadGitignore(dir: string, parent: Ignore | null): Promise<Ignore> {
    const ig = ignore();
    if (parent) {
      // ignore@7 doesn't expose rules, so we compose by re-checking parent first
      // via a wrapper. Cheap path: read every .gitignore on the chain.
    }
    try {
      const content = await readFile(join(dir, ".gitignore"), "utf-8");
      ig.add(content);
    } catch {
      /* no .gitignore here */
    }
    return ig;
  }

  /**
   * Returns true if `name` (a basename inside `dir`) is ignored by any matcher
   * in the chain from root to here. We pass paths relative to each matcher's
   * own directory so .gitignore semantics stay correct.
   */
  function isIgnored(
    name: string,
    isDir: boolean,
    chain: Array<{ matcher: Ignore; dir: string }>,
    dir: string
  ): boolean {
    for (const { matcher, dir: matcherDir } of chain) {
      const rel = relative(matcherDir, join(dir, name));
      if (!rel || rel.startsWith("..")) continue;
      const target = isDir ? `${rel}/` : rel;
      if (matcher.ignores(target)) return true;
    }
    return false;
  }

  async function walk(
    dir: string,
    depth: number,
    chain: Array<{ matcher: Ignore; dir: string }>
  ): Promise<void> {
    if (depth > maxDepth) return;

    signal?.throwIfAborted();
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
    const hasGit = entries.some((e) => e.name === ".git" && (e.isDirectory() || e.isFile()));

    if (primaryMarker || hasGit) {
      // Nested project dedup: skip if a parent is already a project
      const isNested = [...foundProjectPaths].some((pp) => dir.startsWith(pp + "/"));
      if (!isNested) {
        foundProjectPaths.add(dir);

        try {
          // Discover repo-local email (user configured it on this machine)
          if (hasGit) {
            const localEmail = await discoverRepoLocalEmail(dir);
            if (localEmail) userEmails.add(localEmail);
          }

          const project = await buildProject(dir, primaryMarker, detectedMarkers, hasGit, userEmails);
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

    // Pull this dir's .gitignore (if any) and extend the chain for children
    const ownIg = await loadGitignore(dir, null);
    const childChain = [...chain, { matcher: ownIg, dir }];

    // Walk subdirectories in parallel, capped by semaphore
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      // Hidden dirs (except .git which we already handled above) are skipped
      if (entry.name.startsWith(".") && entry.name !== ".git") continue;
      if (isIgnored(entry.name, true, childChain, dir)) continue;
      subdirs.push(entry.name);
    }

    if (subdirs.length === 0) return;
    await Promise.all(
      subdirs.map((name) =>
        limit(() => {
          signal?.throwIfAborted();
          return walk(join(dir, name), depth + 1, childChain);
        })
      )
    );
  }

  await walk(absRoot, 0, []);

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
        ["react", "React"],
        ["vue", "Vue"],
        ["svelte", "Svelte"],
        ["@angular/core", "Angular"],
        ["next", "Next.js"],
        ["nuxt", "Nuxt"],
        ["express", "Express"],
        ["fastify", "Fastify"],
        ["nest", "NestJS"],
        ["electron", "Electron"],
        ["hono", "Hono"],
        ["elysia", "Elysia"],
        ["astro", "Astro"],
        ["remix", "Remix"],
        ["solid-js", "Solid"],
        ["@tanstack/react-query", "TanStack Query"],
        ["prisma", "Prisma"],
        ["drizzle-orm", "Drizzle"],
        ["trpc", "tRPC"],
        ["@trpc/server", "tRPC"],
      ] as const) {
        if (allDeps?.[dep]) frameworks.push(fw);
      }
      if (pkg.description) description = pkg.description;
      if (Array.isArray(pkg.keywords)) topics = pkg.keywords;
      if (pkg.license) license = pkg.license;
    } catch {
      /* ignore */
    }
  } else if (type === "python") {
    try {
      const content = await readFile(join(dir, "requirements.txt"), "utf-8").catch(() => "");
      for (const [pattern, fw] of [
        ["django", "Django"],
        ["flask", "Flask"],
        ["fastapi", "FastAPI"],
        ["celery", "Celery"],
        ["sqlalchemy", "SQLAlchemy"],
        ["pandas", "Pandas"],
        ["numpy", "NumPy"],
        ["torch", "PyTorch"],
        ["tensorflow", "TensorFlow"],
      ] as const) {
        if (content.toLowerCase().includes(pattern)) frameworks.push(fw);
      }
    } catch {
      /* ignore */
    }
  } else if (type === "rust") {
    try {
      const content = await readFile(join(dir, "Cargo.toml"), "utf-8").catch(() => "");
      for (const [pattern, fw] of [
        ["actix", "Actix"],
        ["tokio", "Tokio"],
        ["axum", "Axum"],
        ["serde", "Serde"],
        ["warp", "Warp"],
        ["rocket", "Rocket"],
        ["tauri", "Tauri"],
        ["bevy", "Bevy"],
      ] as const) {
        if (content.toLowerCase().includes(pattern)) frameworks.push(fw);
      }
      const descMatch = content.match(/description\s*=\s*"([^"]+)"/);
      if (descMatch?.[1]) description = descMatch[1];
      const licMatch = content.match(/license\s*=\s*"([^"]+)"/);
      if (licMatch?.[1]) license = licMatch[1];
    } catch {
      /* ignore */
    }
  } else if (type === "go") {
    try {
      const content = await readFile(join(dir, "go.mod"), "utf-8").catch(() => "");
      for (const [pattern, fw] of [
        ["gin-gonic", "Gin"],
        ["gofiber", "Fiber"],
        ["echo", "Echo"],
        ["gorilla/mux", "Gorilla"],
        ["grpc", "gRPC"],
      ] as const) {
        if (content.includes(pattern)) frameworks.push(fw);
      }
    } catch {
      /* ignore */
    }
  }

  // From here, manifest detection is done. Everything below is independent-ish
  // I/O — fan out in parallel.
  const [
    licenseFromFile,
    fallbackLanguage,
    gitMeta,
    privacyAudit,
    gitFileStats,
    rawRemote,
    cloneDate,
    fileDatesPromise,
  ] = await Promise.all([
    license ? Promise.resolve<string | undefined>(license) : detectLicense(dir),
    language === "Unknown" ? detectLanguageByFiles(dir) : Promise.resolve(language),
    hasGit ? extractGitMetadata(dir, userEmails) : Promise.resolve(null),
    scanForSecrets(dir),
    hasGit ? collectGitFileStats(dir) : Promise.resolve({ fileCount: 0, lineCount: 0 }),
    hasGit ? extractRemoteUrl(dir) : Promise.resolve(null),
    hasGit ? getGitCreationDate(dir) : Promise.resolve(""),
    getFileDates(dir),
  ]);

  if (licenseFromFile) license = licenseFromFile;
  if (language === "Unknown") language = fallbackLanguage;

  // Date range: prefer author's own commits, fall back to all commits, then file dates
  let dateRange = { start: "", end: "", approximate: true };

  if (gitMeta?.authorFirstCommitDate) {
    let start = gitMeta.authorFirstCommitDate;
    let end = gitMeta.authorLastCommitDate || start;
    if (start > end) [start, end] = [end, start];
    dateRange.start = start;
    dateRange.end = end;
    dateRange.approximate = false;
  } else if (gitMeta && gitMeta.totalCommits === 0) {
    dateRange = { ...dateRange, ...fileDatesPromise };
  } else if (gitMeta) {
    dateRange.start = cloneDate || gitMeta.firstCommitDate;
    dateRange.end = gitMeta.lastCommitDate;
  } else {
    dateRange = { ...dateRange, ...fileDatesPromise };
  }

  if (dateRange.start && dateRange.end && dateRange.start > dateRange.end) {
    [dateRange.start, dateRange.end] = [dateRange.end, dateRange.start];
  }

  let { fileCount, lineCount } = gitFileStats;
  if (fileCount === 0) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      fileCount = entries.filter((e) => e.isFile()).length;
    } catch {
      /* ignore */
    }
  }

  const remoteUrl = rawRemote ?? undefined;

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
    markers: hasGit ? [...detectedMarkers, ".git"] : detectedMarkers,
    size: { files: fileCount, lines: lineCount },
    description,
    topics: topics.length > 0 ? topics : undefined,
    license,
    privacyAudit,
    tags: [],
    included: true,
    remoteUrl,
    authorEmail: gitMeta?.authorEmail,
    isOwner: gitMeta?.firstCommitAuthorEmail ? userEmails.has(gitMeta.firstCommitAuthorEmail) : !hasGit, // no git = user created this folder
  };
}

/** Detect license by sniffing a LICENSE file (fast keyword scan). */
async function detectLicense(dir: string): Promise<string | undefined> {
  try {
    const licContent = await readFile(join(dir, "LICENSE"), "utf-8").catch(() =>
      readFile(join(dir, "LICENSE.md"), "utf-8").catch(() => "")
    );
    if (licContent.includes("MIT")) return "MIT";
    if (licContent.includes("Apache")) return "Apache-2.0";
    if (licContent.includes("GPL")) return "GPL";
    if (licContent.includes("BSD")) return "BSD";
    if (licContent.length > 0) return "Other";
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Count files + lines via two parallel git invocations. */
async function collectGitFileStats(dir: string): Promise<{ fileCount: number; lineCount: number }> {
  try {
    const git = simpleGit(dir);
    const [filesRaw, statsRaw] = await Promise.all([
      git.raw(["ls-files"]).catch(() => ""),
      git
        .raw([
          "diff",
          "--stat",
          "--diff-filter=ACMR",
          "4b825dc642cb6eb9a060e54bf899d15f3f338fb9",
          "HEAD",
        ])
        .catch(() => ""),
    ]);
    const fileCount = filesRaw.trim().split("\n").filter(Boolean).length;
    const lastLine = statsRaw.trim().split("\n").pop() || "";
    const insMatch = lastLine.match(/(\d+) insertion/);
    const lineCount = insMatch ? parseInt(insMatch[1]!, 10) : 0;
    return { fileCount, lineCount };
  } catch {
    return { fileCount: 0, lineCount: 0 };
  }
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
      } catch {
        /* skip */
      }
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
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".rb": "Ruby",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".cs": "C#",
  ".cpp": "C++",
  ".cc": "C++",
  ".c": "C",
  ".h": "C",
  ".php": "PHP",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".dart": "Dart",
  ".lua": "Lua",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".sol": "Solidity",
  ".html": "HTML",
  ".htm": "HTML",
  ".css": "CSS",
  ".scss": "CSS",
  ".less": "CSS",
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
    const SKIP = new Set([
      "node_modules",
      ".git",
      "dist",
      "build",
      "target",
      "__pycache__",
      ".next",
      "vendor",
      ".turbo",
    ]);

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
      if (count > bestCount) {
        best = lang;
        bestCount = count;
      }
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
