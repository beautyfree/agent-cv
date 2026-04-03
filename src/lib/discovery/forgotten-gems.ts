import type { Project } from "../types.ts";

/**
 * A project is a "forgotten gem" if:
 * - commitCount > 20 AND lastCommit > 6 months ago AND no remote on github.com
 * - OR: commitCount > 10 AND has no analysis yet (never been included in a CV)
 *
 * These are projects with real work that the user probably forgot about.
 */
export function detectForgottenGems(projects: Project[]): Project[] {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const cutoff = sixMonthsAgo.toISOString().split("T")[0]!;

  const gems: Project[] = [];

  for (const p of projects) {
    if (p.tags.includes("removed")) continue;
    if (p.authorCommitCount === 0 && p.hasGit && p.commitCount > 0) continue; // not yours

    const isOldEnough = p.lastCommit ? p.lastCommit < cutoff : true;
    const hasSignificantWork = p.commitCount > 20 || (p.authorCommitCount > 10);
    const neverAnalyzed = !p.analysis;

    if (hasSignificantWork && isOldEnough && neverAnalyzed) {
      gems.push(p);
    }
  }

  return gems;
}
