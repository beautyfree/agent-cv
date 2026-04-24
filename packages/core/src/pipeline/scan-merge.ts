import { scanDirectory } from "../discovery/scanner.ts";
import { readInventory, readInventoryForFreshScan, writeInventory, mergeInventory } from "../inventory/store.ts";
import { resolve } from "node:path";
import type { Inventory, Project } from "../types.ts";
import { GitHubClient } from "../discovery/github-client.ts";
import { enrichUpstreamPullRequestCounts } from "../discovery/github-upstream.ts";
import { detectGitHubUsername } from "../discovery/github-scanner.ts";
import { withPipelineTiming } from "../telemetry.ts";

export interface ScanCallbacks {
  onProjectFound?: (project: Project, total: number) => void;
  onDirectoryEnter?: (dir: string) => void;
  onStatus?: (message: string) => void;
}

export interface ScanMergeOptions {
  /** Skip GitHub GET /repos enrichment (e.g. dry-run). Fork/stars/public come from API in one call. */
  skipGitHubEnrich?: boolean;
  /** When aborted (e.g. CLI Ctrl+C / Ink unmount), stops before further I/O and GitHub calls */
  signal?: AbortSignal;
  /**
   * Do not merge into the full on-disk project list: scan as if starting over (no carried analysis
   * or other directories' projects). Profile (name, emails) is still read from disk.
   */
  fresh?: boolean;
}

/**
 * Step 1: Scan directory and merge with existing inventory.
 * Enriches local github.com remotes with one batched GET /repos pass (stars, visibility, fork).
 */
export async function scanAndMerge(
  directory: string,
  callbacks?: ScanCallbacks,
  options?: ScanMergeOptions
): Promise<{ inventory: Inventory; projects: Project[] }> {
  callbacks?.onStatus?.("Traversing files...");
  const scanResult = await withPipelineTiming("scan_filesystem", () =>
    scanDirectory(directory, {
      verbose: false,
      emails: [],
      onProjectFound: callbacks?.onProjectFound,
      onDirectoryEnter: callbacks?.onDirectoryEnter,
      signal: options?.signal,
    })
  );

  options?.signal?.throwIfAborted();

  callbacks?.onStatus?.(
    options?.fresh ? "Preparing fresh scan (ignoring saved projects)..." : "Reading existing inventory..."
  );
  const absDirectory = resolve(directory);
  const existingInventory = options?.fresh ? await readInventoryForFreshScan() : await readInventory();
  callbacks?.onStatus?.("Merging scan results...");
  const merged = mergeInventory(existingInventory, scanResult.projects, absDirectory);

  const projects = merged.projects.filter((p) => !p.tags.includes("removed"));
  if (!options?.skipGitHubEnrich) {
    options?.signal?.throwIfAborted();
    const ghClient = await GitHubClient.create();
    callbacks?.onStatus?.("Enriching GitHub metadata...");
    await withPipelineTiming("github_enrich_rest", () =>
      enrichGitHubData(
        projects,
        ghClient,
        (done, total) => {
          callbacks?.onStatus?.(`Enriching GitHub metadata... ${done}/${total}`);
        },
        options?.signal
      )
    );
    const ghLogin = merged.profile.socials?.github?.trim() || detectGitHubUsername(merged) || undefined;
    callbacks?.onStatus?.("Collecting upstream PR stats...");
    await withPipelineTiming("github_upstream_prs", () =>
      enrichUpstreamPullRequestCounts(projects, ghClient, ghLogin, options?.signal)
    );
  }
  options?.signal?.throwIfAborted();
  callbacks?.onStatus?.("Saving inventory...");
  await writeInventory(merged);
  callbacks?.onStatus?.("Scan complete.");

  return { inventory: merged, projects };
}

/**
 * Enrich local projects with GitHub REST data (stars, visibility, fork) via GET /repos/{owner}/{repo}.
 * Single request per repo — same endpoint previously split across scan (fork) and post-analysis (stars).
 * Uses centralized GitHubClient for auth and rate limit tracking.
 * Batches API calls 10 at a time. Includes cloud-listed repos so fork `parent` is filled in.
 */
export async function enrichGitHubData(
  projects: Project[],
  client?: GitHubClient,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const toCheck = projects.filter((p) => p.remoteUrl?.includes("github.com"));
  if (toCheck.length === 0) return;

  const ghClient = client ?? (await GitHubClient.create());
  const BATCH = 10;
  let done = 0;

  for (let i = 0; i < toCheck.length; i += BATCH) {
    signal?.throwIfAborted();
    if (ghClient.isRateLimited) {
      console.error(
        "Warning: GitHub API rate limit reached, skipping remaining repos. Set GITHUB_TOKEN or save githubToken in credentials.json for higher limits."
      );
      break;
    }
    const batch = toCheck.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (p) => {
        if (ghClient.isRateLimited) return;
        try {
          const match = p.remoteUrl!.match(/github\.com\/([^/]+\/[^/]+)/);
          if (!match) return;
          const data = await ghClient.get<{
            stargazers_count: number;
            private: boolean;
            fork: boolean;
            parent?: { full_name: string };
          }>(`/repos/${match[1]}`);
          p.stars = data.stargazers_count || 0;
          p.isPublic = !data.private;
          p.isFork = data.fork;
          if (data.parent?.full_name) {
            p.githubParentFullName = data.parent.full_name;
          }
        } catch {
          // Non-critical: skip this repo's enrichment
        }
      })
    );
    done += batch.length;
    onProgress?.(done, toCheck.length);
  }
}
