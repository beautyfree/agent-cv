import type { AgentAdapter, Project } from "../types.ts";

export interface ProfileInsights {
  bio: string;
  highlights: string[];
  narrative: string;
  strongestSkills: string[];
  uniqueTraits: string[];
}

/**
 * Generate professional profile insights from analyzed projects.
 * One LLM call returns bio + highlights + narrative + skills + unique traits.
 */
export async function generateProfileInsights(
  projects: Project[],
  adapter: AgentAdapter
): Promise<ProfileInsights | null> {
  const analyzed = projects.filter((p) => p.analysis);
  if (analyzed.length === 0) return null;

  // Include ALL selected projects — analyzed ones with full details, rest with basics
  const sorted = [...projects].sort((a, b) => (b.authorCommitCount || b.commitCount) - (a.authorCommitCount || a.commitCount));
  const projectSummaries = sorted
    .slice(0, 50)
    .map((p) => {
      const tech = p.analysis?.techStack?.join(", ") || p.language;
      const desc = p.analysis?.summary?.slice(0, 120) || "";
      const commits = p.authorCommitCount || p.commitCount;
      const lines = p.size?.lines ? `${Math.round(p.size.lines / 1000)}K lines` : "";
      const date = p.dateRange.start?.split("-")[0] || "?";
      const stars = p.stars ? `, ⭐${p.stars}` : "";
      const analyzed = p.analysis ? "" : " [not analyzed]";
      return `- ${p.displayName} (${date}, ${commits} commits${stars}${lines ? ", " + lines : ""}): ${tech}. ${desc}${analyzed}`;
    })
    .join("\n");

  const langCounts = new Map<string, number>();
  for (const p of projects) {
    if (p.language !== "Unknown") langCounts.set(p.language, (langCounts.get(p.language) || 0) + 1);
  }
  const topLangs = [...langCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l]) => l).join(", ");

  const fwCounts = new Map<string, number>();
  for (const p of projects) {
    for (const fw of p.frameworks) fwCounts.set(fw, (fwCounts.get(fw) || 0) + 1);
  }
  const topFw = [...fwCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([f]) => f).join(", ");

  const years = projects.map((p) => p.dateRange.start?.split("-")[0]).filter(Boolean).sort();
  const firstYear = years[0] || "?";

  const prompt = [
    "Analyze this developer's portfolio and respond with ONLY a JSON object.",
    "",
    "The JSON must have this exact structure:",
    '{',
    '  "bio": "3-4 sentence professional bio. Third person. Specific, not generic. What they build, strongest tech, what makes them unique.",',
    '  "highlights": ["project_name_1", "project_name_2", "project_name_3", "project_name_4", "project_name_5"],',
    '  "narrative": "One sentence describing their career arc/evolution. Example: Started with frontend experiments, evolved into full-stack SaaS builder with a focus on developer tools.",',
    '  "strongestSkills": ["skill1", "skill2", "skill3", "skill4", "skill5"],',
    '  "uniqueTraits": ["trait1", "trait2", "trait3"]',
    '}',
    "",
    "Guidelines:",
    "- bio: NO generic phrases (passionate, problem-solver, results-driven). Be concrete.",
    "- highlights: Pick 3-5 projects that best demonstrate their abilities. Choose based on:",
    "  * GitHub stars (⭐) — community validation, higher weight",
    "  * Technical complexity (many commits, large codebase, diverse tech stack)",
    "  * Interesting/unusual domain (games, blockchain, AI agents, hardware)",
    "  * Shows growth (early simple projects vs recent complex ones)",
    "  * Has real users or solves a real problem",
    "- narrative: What story do these projects tell about their career?",
    "- strongestSkills: NOT just languages. Include patterns like 'CLI tool design', 'real-time systems', 'full-stack SaaS'.",
    "- uniqueTraits: What makes this developer different? Width of stack? Speed? Domain expertise? Open source contributions?",
    "",
    `Active since: ${firstYear}`,
    `Top languages: ${topLangs}`,
    `Top frameworks: ${topFw}`,
    `Total projects: ${projects.length} (${analyzed.length} analyzed)`,
    "",
    "Projects:",
    projectSummaries,
  ].join("\n");

  const context = {
    path: "",
    readme: "",
    dependencies: "",
    directoryTree: "",
    gitShortlog: "",
    recentCommits: "",
    rawPrompt: prompt,
  };

  try {
    const result = await adapter.analyze(context);

    // Try to parse the summary as JSON (our prompt asks for JSON)
    const text = result.summary || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        bio: parsed.bio || "",
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
        narrative: parsed.narrative || "",
        strongestSkills: Array.isArray(parsed.strongestSkills) ? parsed.strongestSkills : [],
        uniqueTraits: Array.isArray(parsed.uniqueTraits) ? parsed.uniqueTraits : [],
      };
    }

    // Fallback: use raw text as bio
    return {
      bio: text,
      highlights: [],
      narrative: "",
      strongestSkills: [],
      uniqueTraits: [],
    };
  } catch {
    return null;
  }
}

