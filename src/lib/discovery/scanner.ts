import { readdir, stat, access } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Project } from "../types.ts";
import { extractGitMetadata } from "./git-metadata.ts";
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
  const { maxDepth = 5, verbose = false } = options;
  const absRoot = resolve(rootPath);
  const projects: Project[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const foundProjectPaths = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

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
          const project = await buildProject(
            dir,
            primaryMarker,
            detectedMarkers,
            hasGit
          );
          projects.push(project);
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
  hasGit: boolean
): Promise<Project> {
  const name = basename(dir);
  const id = createHash("sha256").update(dir).digest("hex").slice(0, 16);

  // Detect language from package.json if it's a node project
  let language = primaryMarker?.language || "Unknown";
  let type = primaryMarker?.type || (hasGit ? "git" : "unknown");
  const frameworks: string[] = [];

  if (type === "node") {
    try {
      const pkg = await Bun.file(join(dir, "package.json")).json();
      // Detect TypeScript
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      if (allDeps?.typescript || (await fileExists(join(dir, "tsconfig.json")))) {
        language = "TypeScript";
      }
      // Detect common frameworks
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
      ] as const) {
        if (allDeps?.[dep]) frameworks.push(fw);
      }
    } catch {
      // package.json read failed, keep defaults
    }
  }

  // Git metadata (dates, commits)
  const gitMeta = hasGit ? await extractGitMetadata(dir) : null;

  // File timestamps fallback
  let dateRange = {
    start: "",
    end: "",
    approximate: !hasGit,
  };

  if (gitMeta) {
    dateRange.start = gitMeta.firstCommitDate;
    dateRange.end = gitMeta.lastCommitDate;
  } else {
    try {
      const dirStat = await stat(dir);
      const created = dirStat.birthtime.toISOString().split("T")[0]!;
      const modified = dirStat.mtime.toISOString().split("T")[0]!;
      dateRange.start = created;
      dateRange.end = modified;
    } catch {
      // Can't get dates
    }
  }

  // Privacy audit
  const privacyAudit = await scanForSecrets(dir);

  // Count files (quick, depth 1 only for speed)
  let fileCount = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    fileCount = entries.filter((e) => e.isFile()).length;
  } catch {
    // ignore
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
    lastCommit: gitMeta?.lastCommitDate,
    markers: hasGit
      ? [...detectedMarkers, ".git"]
      : detectedMarkers,
    size: { files: fileCount, lines: 0 },
    privacyAudit,
    tags: [],
    included: true,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
