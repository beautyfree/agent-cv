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
export async function collectEmails(projects: Project[]): Promise<{
  emailCounts: Map<string, number>;
  preSelected: Set<string>;
}> {
  const { readConfig } = await import("./config.ts");

  const gitDirs = projects.filter((p) => p.hasGit).map((p) => p.path);
  const allEmails = await collectAllRepoEmails(gitDirs);
  const configEmails = await collectUserEmails([]);
  const config = await readConfig();

  const preSelected = new Set<string>([
    ...configEmails,
    ...(config.emails || []).map((e: string) => e.toLowerCase()),
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
export async function analyzeProjects(
  projects: Project[],
  adapter: AgentAdapter,
  inventory: Inventory,
  options: {
    noCache?: boolean;
    dryRun?: boolean;
    onProgress?: (done: number, total: number, current: string) => void;
  } = {}
): Promise<void> {
  const { noCache = false, dryRun = false, onProgress } = options;

  const needsAnalysis = (p: Project) => {
    if (!p.analysis) return true;
    if (!p.analysis.analyzedAtCommit) return true;
    if (p.lastCommit && p.lastCommit !== p.analysis.analyzedAtCommit) return true;
    if (p.analysis.promptVersion !== PROMPT_VERSION) return true;
    return false;
  };

  const toAnalyze = noCache ? projects : projects.filter(needsAnalysis);
  const BATCH_SIZE = 3;
  let completed = 0;

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
        try {
          const context = await buildProjectContext(project);
          const analysis = await adapter.analyze(context);
          analysis.analyzedAtCommit = project.lastCommit || "";
          analysis.promptVersion = PROMPT_VERSION;
          project.analysis = analysis;
        } catch (err: any) {
          console.error(`Warning: Failed to analyze ${project.displayName}: ${err.message}`);
        }
      })
    );

    completed += batch.length;
    onProgress?.(completed, toAnalyze.length, "");
    await writeInventory(inventory);
  }
}

/**
 * Check how many projects need analysis.
 */
export function countUnanalyzed(projects: Project[]): number {
  return projects.filter((p) => p.included !== false && !p.analysis).length;
}
