import type { Project } from "../types.ts";

export type ProjectTier = "primary" | "secondary" | "minor";

/**
 * Calculate significance score for a project.
 * Higher = more important for the developer's portfolio.
 */
export function calculateSignificance(p: Project): number {
  let score = 0;

  // Author contribution weight
  const commits = p.authorCommitCount || 0;
  score += Math.min(commits * 0.5, 50); // cap at 50 points from commits

  // Stars (community validation)
  score += (p.stars || 0) * 10;

  // Code size
  const lines = p.size?.lines || 0;
  if (lines > 10000) score += 5;
  else if (lines > 3000) score += 3;
  else if (lines > 500) score += 1;

  // Duration (months active)
  if (p.dateRange.start && p.dateRange.end) {
    const start = new Date(p.dateRange.start).getTime();
    const end = new Date(p.dateRange.end).getTime();
    const months = (end - start) / (1000 * 60 * 60 * 24 * 30);
    if (months > 12) score += 5;
    else if (months > 3) score += 3;
    else if (months > 1) score += 1;
  }

  // Is main author (>50% of commits)
  if (p.commitCount > 0 && p.authorCommitCount / p.commitCount > 0.5) {
    score += 5;
  }

  // Has LLM analysis (means it was interesting enough to analyze)
  if (p.analysis?.summary && p.analysis.summary.length > 50) {
    score += 3;
  }

  // Tech stack diversity (more diverse = more interesting)
  const techCount = (p.analysis?.techStack?.length || 0) + p.frameworks.length;
  if (techCount > 5) score += 3;
  else if (techCount > 2) score += 1;

  // LLM impact score (CTO assessment) — heaviest signal when available
  if (p.analysis?.impactScore) {
    score += p.analysis.impactScore * 5; // 1-10 → 5-50 points
  }

  // Active project bonus
  if (p.hasUncommittedChanges) score += 2;

  // Owner bonus — user created this project (first commit is theirs)
  if (p.isOwner) score += 10;

  // Penalty for zero author commits in git repos (likely clone/fork)
  // No penalty for owners or non-git projects
  if (p.hasGit && p.authorCommitCount === 0 && !p.hasUncommittedChanges && !p.isOwner) {
    score *= 0.1;
  }

  return Math.round(score * 10) / 10;
}

/**
 * Assign tiers per year — each year gets its own primary/secondary/minor.
 * Ensures every year has visible top projects, not just globally dominant years.
 */
export function assignTiers(projects: Project[]): Map<string, { score: number; tier: ProjectTier }> {
  const result = new Map<string, { score: number; tier: ProjectTier }>();

  // Score all projects first
  const scores = new Map<string, number>();
  for (const p of projects) {
    scores.set(p.id, calculateSignificance(p));
  }

  // Group by year
  const byYear = new Map<string, Project[]>();
  for (const p of projects) {
    const year = p.dateRange.end?.split("-")[0] || p.dateRange.start?.split("-")[0] || "Unknown";
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(p);
  }

  // Assign tiers within each year
  for (const [, yearProjects] of byYear) {
    const sorted = [...yearProjects].sort((a, b) => (scores.get(b.id) || 0) - (scores.get(a.id) || 0));
    const total = sorted.length;
    const primaryCut = Math.max(1, Math.ceil(total * 0.2));
    const secondaryCut = primaryCut + Math.max(1, Math.ceil(total * 0.3));

    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const score = scores.get(p.id) || 0;
      const tier: ProjectTier = i < primaryCut ? "primary" : i < secondaryCut ? "secondary" : "minor";
      result.set(p.id, { score, tier });
    }
  }

  return result;
}
