/**
 * Shared pipeline logic for generate and publish commands.
 * UI components (pickers) stay in the commands — this is pure logic.
 */

import { scanDirectory, type ScanOptions } from "./discovery/scanner.ts";
import { buildCloudProjectContext } from "./analysis/cloud-context-builder.ts";
import {
  readInventory,
  writeInventory,
  mergeInventory,
} from "./inventory/store.ts";
import { buildProjectContext } from "./analysis/context-builder.ts";
import {
  collectUserEmails,
  collectAllRepoEmails,
  recountAuthorCommitsBatch,
} from "./discovery/git-metadata.ts";
import { detectForgottenGems } from "./discovery/forgotten-gems.ts";
import { dirname, basename, resolve } from "node:path";
import { PROMPT_VERSION } from "./types.ts";
import type { Project, Inventory, AgentAdapter } from "./types.ts";
import { GitHubClient } from "./discovery/github-client.ts";

/**
 * Determine which pipeline phases can be skipped on return runs.
 * Pure function — easy to test.
 */
export function shouldSkipPhases(
  inventory: Inventory,
  projects: Project[],
  flags: { interactive?: boolean; agent?: string }
): { skipEmails: boolean; skipSelector: boolean; skipAgent: boolean } {
  if (flags.interactive) {
    return { skipEmails: false, skipSelector: false, skipAgent: false };
  }

  const skipEmails = inventory.profile.emailsConfirmed === true;

  const hasSavedSelections = projects.some((p) => p.included !== undefined);
  const hasNoNewProjects = projects.every((p) => !p.tags.includes("new"));
  const skipSelector = hasNoNewProjects && hasSavedSelections;

  const skipAgent = !!(
    (flags.agent || inventory.lastAgent) &&
    !flags.interactive
  );

  return { skipEmails, skipSelector, skipAgent };
}

export interface ScanCallbacks {
  onProjectFound?: (project: Project, total: number) => void;
  onDirectoryEnter?: (dir: string) => void;
}

/**
 * Step 1: Scan directory and merge with existing inventory.
 */
export async function scanAndMerge(
  directory: string,
  callbacks?: ScanCallbacks
): Promise<{ inventory: Inventory; projects: Project[] }> {
  const scanResult = await scanDirectory(directory, {
    verbose: false,
    emails: [],
    onProjectFound: callbacks?.onProjectFound,
    onDirectoryEnter: callbacks?.onDirectoryEnter,
  });

  const absDirectory = resolve(directory);
  const existingInventory = await readInventory();
  const merged = mergeInventory(existingInventory, scanResult.projects, absDirectory);
  await writeInventory(merged);

  const projects = merged.projects.filter((p) => !p.tags.includes("removed"));
  return { inventory: merged, projects };
}

/**
 * Step 2: Collect emails for the email picker.
 */
export async function collectEmails(projects: Project[], savedEmails: string[] = []): Promise<{
  emailCounts: Map<string, number>;
  preSelected: Set<string>;
}> {
  const gitDirs = projects.filter((p) => p.hasGit).map((p) => p.path);
  const allEmails = await collectAllRepoEmails(gitDirs);
  const configEmails = await collectUserEmails([]);

  const preSelected = new Set<string>([
    ...configEmails,
    ...savedEmails.map((e: string) => e.toLowerCase()),
  ]);

  return { emailCounts: allEmails, preSelected };
}

/**
 * Step 3: Recount author commits with confirmed emails + detect forgotten gems.
 */
export async function recountAndTag(
  projects: Project[],
  confirmedEmails: string[]
): Promise<Project[]> {
  const updated = [...projects];

  if (confirmedEmails.length > 0) {
    const counts = await recountAuthorCommitsBatch(updated, confirmedEmails);
    for (const project of updated) {
      const result = counts.get(project.path);
      if (result) {
        project.authorCommitCount = result.authorCommits;
        project.authorEmail = result.matchedEmail;
      }
    }
  }

  const gems = detectForgottenGems(updated);
  for (const gem of gems) {
    if (!gem.tags.includes("forgotten-gem")) {
      gem.tags.push("forgotten-gem");
    }
  }

  return updated;
}

/**
 * Detect project groups: projects sharing a parent directory are part of the same product.
 * e.g. orgs/etherearn-app/frontend + orgs/etherearn-app/backend → group "etherearn-app"
 * Only groups with 2+ projects are assigned.
 */
export function detectProjectGroups(projects: Project[], scanRoot: string): void {
  const parentCounts = new Map<string, Project[]>();
  for (const p of projects) {
    const parent = dirname(p.path);
    // Skip if parent IS the scan root (these are top-level, not grouped)
    if (parent === scanRoot) continue;
    if (!parentCounts.has(parent)) parentCounts.set(parent, []);
    parentCounts.get(parent)!.push(p);
  }

  for (const [parent, children] of parentCounts) {
    if (children.length >= 2) {
      const groupName = basename(parent);
      for (const p of children) {
        p.projectGroup = groupName;
      }
    }
  }
}

/**
 * Transient error patterns that are worth retrying (rate limits, network, server errors).
 */
const TRANSIENT_PATTERNS = [
  "429", "rate limit", "timeout", "timed out",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE",
  "AbortError", "abort",
  "500", "502", "503", "504",
  "fetch failed", "network",
];

function isTransientError(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Retry a function with exponential backoff. Only retries transient errors.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelay?: number; onRetry?: (attempt: number, error: string) => void } = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelay = 2000, onRetry } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const message = err.message || String(err);
      if (attempt === maxAttempts || !isTransientError(message)) {
        throw err;
      }
      const delay = baseDelay * Math.pow(2, attempt - 1);
      onRetry?.(attempt, message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("retryWithBackoff: unreachable");
}

/**
 * Step 4: Analyze projects with AI agent.
 */
export interface AnalysisResult {
  analyzed: number;
  failed: Array<{ project: Project; error: string }>;
  skipped: number;
}

export type ProjectStatus = "queued" | "analyzing" | "done" | "failed" | "cached";

export async function analyzeProjects(
  projects: Project[],
  adapter: AgentAdapter,
  inventory: Inventory,
  options: {
    noCache?: boolean;
    dryRun?: boolean;
    onProgress?: (done: number, total: number, current: string) => void;
    onProjectStatus?: (projectId: string, status: ProjectStatus, detail?: string) => void;
  } = {}
): Promise<AnalysisResult> {
  const { noCache = false, dryRun = false, onProgress, onProjectStatus } = options;

  const needsAnalysis = (p: Project) => {
    if (!p.analysis) return true;
    if (p.analysis.promptVersion !== PROMPT_VERSION) return true;
    if (p.lastCommit) {
      // Git project: re-analyze if new commits
      return p.analysis.analyzedAtCommit !== p.lastCommit;
    }
    // Non-git project: re-analyze if files changed (count or dates)
    const fingerprint = `files:${p.size?.files || 0}:${p.dateRange.end}`;
    return p.analysis.analyzedAtCommit !== fingerprint;
  };

  const toAnalyze = noCache ? projects : projects.filter(needsAnalysis);
  const cachedProjects = projects.filter((p) => !needsAnalysis(p));
  const skipped = cachedProjects.length;

  // Report cached projects
  for (const p of cachedProjects) {
    onProjectStatus?.(p.id, "cached");
  }
  // Report queued projects
  for (const p of toAnalyze) {
    onProjectStatus?.(p.id, "queued");
  }
  const BATCH_SIZE = 3;
  const CIRCUIT_BREAKER_THRESHOLD = 3; // consecutive failures to trigger
  let completed = 0;
  let analyzedOk = 0;
  const failed: Array<{ project: Project; error: string }> = [];
  let consecutiveFailures = 0;
  let lastFailureMessage = "";
  let circuitBroken = false;

  for (let i = 0; i < toAnalyze.length; i += BATCH_SIZE) {
    // Circuit breaker: if adapter is consistently failing, stop early
    if (circuitBroken) {
      const remaining = toAnalyze.slice(i);
      for (const project of remaining) {
        failed.push({ project, error: lastFailureMessage });
        onProjectStatus?.(project.id, "failed", `skipped: ${lastFailureMessage.slice(0, 40)}`);
      }
      completed += remaining.length;
      break;
    }

    const batch = toAnalyze.slice(i, i + BATCH_SIZE);
    onProgress?.(completed, toAnalyze.length, batch.map((p) => p.displayName).join(", "));

    if (dryRun) {
      for (const project of batch) {
        const context = await buildProjectContext(project);
        const totalChars = context.readme.length + context.dependencies.length +
          context.directoryTree.length + context.gitShortlog.length + context.recentCommits.length;
        console.error(`\n--- DRY RUN: ${project.displayName} ---\nContext size: ~${Math.round(totalChars / 4)} tokens\n`);
      }
      completed += batch.length;
      continue;
    }

    let batchSuccesses = 0;
    await Promise.all(
      batch.map(async (project) => {
        onProjectStatus?.(project.id, "analyzing");
        try {
          let context;
          try {
            if (project.source === "github") {
              const ghClient = new GitHubClient();
              context = await buildCloudProjectContext(project, ghClient);
            } else {
              context = await buildProjectContext(project);
            }
          } catch (ctxErr: any) {
            failed.push({ project, error: `context build failed: ${ctxErr.message}` });
            onProjectStatus?.(project.id, "failed", `context: ${ctxErr.message}`.slice(0, 60));
            return;
          }

          const analysis = await retryWithBackoff(
            () => adapter.analyze(context),
            {
              onRetry: (attempt, error) => {
                onProjectStatus?.(project.id, "analyzing", `retry ${attempt + 1}/3... ${error.slice(0, 40)}`);
              },
            }
          );
          // For git projects: last commit hash. For non-git: file fingerprint.
          analysis.analyzedAtCommit = project.lastCommit
            || `files:${project.size?.files || 0}:${project.dateRange.end}`;
          analysis.promptVersion = PROMPT_VERSION;
          project.analysis = analysis;
          analyzedOk++;
          batchSuccesses++;
          onProjectStatus?.(project.id, "done", analysis.summary?.slice(0, 60));
        } catch (err: any) {
          failed.push({ project, error: err.message });
          onProjectStatus?.(project.id, "failed", err.message.slice(0, 60));
          lastFailureMessage = err.message;
        }
      })
    );

    // Track consecutive batch failures for circuit breaker
    if (batchSuccesses === 0) {
      consecutiveFailures++;
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitBroken = true;
        onProgress?.(completed + batch.length, toAnalyze.length,
          `Agent broken — ${consecutiveFailures} batches failed: ${lastFailureMessage.slice(0, 60)}`);
      }
    } else {
      consecutiveFailures = 0;
    }

    completed += batch.length;
    onProgress?.(completed, toAnalyze.length, "");
    await writeInventory(inventory);
  }

  return { analyzed: analyzedOk, failed, skipped };
}

/**
 * Check how many projects need analysis.
 */
export function countUnanalyzed(projects: Project[]): number {
  return projects.filter((p) => p.included !== false && !p.analysis).length;
}

/**
 * Enrich projects with GitHub data (stars, isPublic).
 * Uses centralized GitHubClient for auth and rate limit tracking.
 * Batches API calls 10 at a time. Only checks local projects with github.com remoteUrl
 * that don't already have cloud-sourced data.
 */
export async function enrichGitHubData(
  projects: Project[],
  client?: GitHubClient,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  // Skip cloud-sourced projects (they already have stars/isPublic from the API listing)
  const toCheck = projects.filter(
    (p) => p.remoteUrl?.includes("github.com") && p.source !== "github"
  );
  if (toCheck.length === 0) return;

  const ghClient = client || new GitHubClient();
  const BATCH = 10;
  let done = 0;

  for (let i = 0; i < toCheck.length; i += BATCH) {
    if (ghClient.isRateLimited) {
      console.error("Warning: GitHub API rate limit reached, skipping remaining repos. Set GITHUB_TOKEN for higher limits.");
      break;
    }
    const batch = toCheck.slice(i, i + BATCH);
    await Promise.all(batch.map(async (p) => {
      if (ghClient.isRateLimited) return;
      try {
        const match = p.remoteUrl!.match(/github\.com\/([^/]+\/[^/]+)/);
        if (!match) return;
        const data = await ghClient.get<{ stargazers_count: number; private: boolean }>(
          `/repos/${match[1]}`
        );
        p.stars = data.stargazers_count || 0;
        p.isPublic = !data.private;
      } catch {
        // Non-critical: skip this repo's enrichment
      }
    }));
    done += batch.length;
    onProgress?.(done, toCheck.length);
  }
}
