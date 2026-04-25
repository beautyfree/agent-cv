import {
  collectUserEmails,
  collectAllRepoEmails,
  recountAuthorCommitsBatch,
} from "../discovery/git-metadata.ts";
import { detectForgottenGems } from "../discovery/forgotten-gems.ts";
import { dirname, basename } from "node:path";
import type { Project } from "../types.ts";
import { withPipelineTiming } from "../telemetry.ts";

/**
 * Step 2: Collect emails for the email picker.
 */
export async function collectEmails(projects: Project[], savedEmails: string[] = []): Promise<{
  emailCounts: Map<string, number>;
  preSelected: Set<string>;
}> {
  return withPipelineTiming("collect_emails", async () => {
    const gitDirs = projects.filter((p) => p.hasGit).map((p) => p.path);
    const allEmails = await collectAllRepoEmails(gitDirs);
    const configEmails = await collectUserEmails([]);

    const preSelected = new Set<string>([
      ...configEmails,
      ...savedEmails.map((e: string) => e.toLowerCase()),
    ]);

    return { emailCounts: allEmails, preSelected };
  });
}

/**
 * Step 3: Recount author commits with confirmed emails + detect forgotten gems.
 */
export async function recountAndTag(
  projects: Project[],
  confirmedEmails: string[]
): Promise<Project[]> {
  return withPipelineTiming("recount_and_tag", async () => {
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
  });
}

/**
 * Generic "landing zone" directory names — projects living here are unrelated,
 * so we skip path-based grouping for them. Remote-based grouping still applies.
 */
const LANDING_ZONE_DIRS = new Set([
  "tmp",
  "temp",
  "scratch",
  "playground",
  "sandbox",
  "downloads",
  "dev",
  "work",
  "projects",
  "code",
  "repos",
  "src",
]);

/**
 * Detect project groups: projects sharing a parent directory are part of the same product.
 * e.g. orgs/etherearn-app/frontend + orgs/etherearn-app/backend → group "etherearn-app"
 * Only groups with 2+ projects are assigned. Skips landing-zone folders (`tmp/`,
 * `playground/`, etc.) where adjacency does not mean relationship.
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
    if (children.length < 2) continue;
    const groupName = basename(parent);
    if (LANDING_ZONE_DIRS.has(groupName.toLowerCase())) continue;
    for (const p of children) {
      p.projectGroup = groupName;
    }
  }
}

export { detectProjectGroupsFromRemotes } from "../discovery/remote-grouping.ts";
