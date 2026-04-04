/**
 * Shared pipeline logic for generate and publish commands.
 * UI components (pickers) stay in the commands — this is pure logic.
 */

import { scanDirectory, type ScanOptions } from "./discovery/scanner.ts";
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
import { PROMPT_VERSION } from "./types.ts";
import type { Project, Inventory, AgentAdapter } from "./types.ts";

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

  const existingInventory = await readInventory();
  const merged = mergeInventory(existingInventory, scanResult.projects, directory);
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
    if (!p.analysis.analyzedAtCommit) return true;
    if (p.lastCommit && p.lastCommit !== p.analysis.analyzedAtCommit) return true;
    if (p.analysis.promptVersion !== PROMPT_VERSION) return true;
    return false;
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
  let completed = 0;
  let analyzedOk = 0;
  const failed: Array<{ project: Project; error: string }> = [];

  for (let i = 0; i < toAnalyze.length; i += BATCH_SIZE) {
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

    await Promise.all(
      batch.map(async (project) => {
        onProjectStatus?.(project.id, "analyzing");
        try {
          const context = await buildProjectContext(project);
          const analysis = await adapter.analyze(context);
          analysis.analyzedAtCommit = project.lastCommit || "";
          analysis.promptVersion = PROMPT_VERSION;
          project.analysis = analysis;
          analyzedOk++;
          onProjectStatus?.(project.id, "done", analysis.summary?.slice(0, 60));
        } catch (err: any) {
          failed.push({ project, error: err.message });
          onProjectStatus?.(project.id, "failed", err.message.slice(0, 60));
        }
      })
    );

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
 * Batches API calls 10 at a time. Only checks projects with github.com remoteUrl.
 */
export async function enrichGitHubData(
  projects: Project[],
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const toCheck = projects.filter((p) => p.remoteUrl?.includes("github.com"));
  if (toCheck.length === 0) return;

  const BATCH = 10;
  let done = 0;

  for (let i = 0; i < toCheck.length; i += BATCH) {
    const batch = toCheck.slice(i, i + BATCH);
    await Promise.all(batch.map(async (p) => {
      try {
        const match = p.remoteUrl!.match(/github\.com\/([^/]+\/[^/]+)/);
        if (!match) return;
        const res = await fetch(`https://api.github.com/repos/${match[1]}`, {
          redirect: "follow",
          headers: { "User-Agent": "agent-cv" },
        });
        if (res.status === 200) {
          const data = await res.json();
          p.stars = data.stargazers_count || 0;
          p.isPublic = !data.private;
        }
      } catch { /* skip */ }
    }));
    done += batch.length;
    onProgress?.(done, toCheck.length);
  }
}
