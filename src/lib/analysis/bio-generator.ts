import type { AgentAdapter, Project, ProjectContext } from "../types.ts";

export interface YearlyTheme {
  year: string;
  focus: string;
  topProjects: string[];
  exploring?: string[];
}

export interface YearlyInsight {
  year: string;
  focus: string;
  highlights: string[];
  skills: string[];
  domains: string[];
  achievement?: string;
  exploring?: string[];
  source: "llm" | "metadata";
}

export interface ProfileInsights {
  bio: string;
  highlights: string[];
  highlightsByYear?: Record<string, string[]>;
  narrative: string;
  strongestSkills: string[];
  uniqueTraits: string[];
  yearlyThemes: YearlyTheme[];
  yearlyInsights?: YearlyInsight[];
}

const INSIGHTS_BATCH_SIZE = 3;

/**
 * Detect domains from a set of projects based on tech stacks and language.
 */
export function detectDomains(projects: Project[]): Set<string> {
  const domains = new Set<string>();
  for (const p of projects) {
    const tech = (p.analysis?.techStack || []).concat(p.frameworks).join(" ").toLowerCase();
    if (tech.match(/react|next|vue|svelte|angular|frontend/)) domains.add("frontend");
    if (tech.match(/express|fastify|nest|hono|backend|api|server/)) domains.add("backend");
    if (tech.match(/solana|ethereum|web3|blockchain|defi|wallet|swap/)) domains.add("crypto/web3");
    if (tech.match(/openai|llm|ai|ml|agent|claude|gpt/)) domains.add("AI/ML");
    if (tech.match(/react.native|swift|kotlin|mobile|ios|android/)) domains.add("mobile");
    if (tech.match(/cli|terminal|command/)) domains.add("CLI tools");
    if (tech.match(/docker|kubernetes|k8s|terraform|infra/)) domains.add("infrastructure");
    if (tech.match(/game|unity|three|canvas/)) domains.add("games/graphics");
    if (p.language === "Rust") domains.add("Rust/systems");
  }
  return domains;
}

/**
 * Generate profile insights in three steps:
 * 1. Per-year analysis — rich insights for each year independently
 * 2. Profile aggregation — bio, narrative, skills from yearly summaries
 * 3. Merge — derive backward-compatible fields
 */
export async function generateProfileInsights(
  projects: Project[],
  adapter: AgentAdapter,
  onStep?: (step: string) => void
): Promise<ProfileInsights | null> {
  const analyzed = projects.filter((p) => p.analysis);
  if (analyzed.length === 0) return null;

  // Step 1: Per-year analysis
  onStep?.("analyzing per-year insights...");
  const yearlyInsights = await generateYearlyInsights(projects, adapter, onStep);

  if (yearlyInsights.length === 0) return null;

  // Step 2: Profile aggregation
  onStep?.("generating profile...");
  const profile = await generateAggregateProfile(yearlyInsights, projects, adapter);

  if (!profile) return null;

  // Step 3: Merge — derive highlights and backward-compatible fields

  // Highlights = all primary-tier authored projects, sorted by significance per year
  // No LLM picking, no artificial limits — significance score decides
  const byYear = groupByYear(projects);
  const highlightsByYear: Record<string, string[]> = {};
  const allYears = [...byYear.keys()].sort((a, b) => b.localeCompare(a));
  for (const year of allYears) {
    const yProjects = byYear.get(year)!;
    // "Significant author" = owner, or substantial contributor (not a drive-by PR)
    const isSignificantAuthor = (p: Project) =>
      p.isOwner || p.hasUncommittedChanges || !p.hasGit ||
      (p.authorCommitCount > 0 && (p.commitCount === 0 || p.authorCommitCount / p.commitCount > 0.1 || p.authorCommitCount >= 10));
    const highlighted = yProjects
      .filter((p) => isSignificantAuthor(p) && (p.tier === "primary" || p.isPublic))
      .sort((a, b) => (b.significance || 0) - (a.significance || 0));
    if (highlighted.length > 0) {
      // Deduplicate (same project can match both primary and isPublic)
      highlightsByYear[year] = [...new Set(highlighted.map((p) => p.displayName))];
    }
  }

  const yearlyThemes: YearlyTheme[] = yearlyInsights.map((yi) => ({
    year: yi.year,
    focus: yi.focus,
    topProjects: highlightsByYear[yi.year] ?? [],
    exploring: yi.exploring,
  }));

  // Flat highlights (newest first)
  const highlights: string[] = [];
  for (const year of allYears) {
    highlights.push(...(highlightsByYear[year] ?? []));
  }

  return {
    ...profile,
    highlights,
    highlightsByYear: Object.keys(highlightsByYear).length > 0 ? highlightsByYear : undefined,
    yearlyThemes,
    yearlyInsights,
  };
}

/**
 * Group projects by year.
 */
function groupByYear(projects: Project[]): Map<string, Project[]> {
  const byYear = new Map<string, Project[]>();
  for (const p of projects) {
    const year = p.dateRange.end?.split("-")[0] || p.dateRange.start?.split("-")[0] || "Unknown";
    if (year === "Unknown") continue;
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(p);
  }
  return byYear;
}

/**
 * Step 1: Analyze each year independently with its own LLM call.
 * Years with ≤2 projects and no analysis get a metadata fallback.
 */
async function generateYearlyInsights(
  projects: Project[],
  adapter: AgentAdapter,
  onStep?: (step: string) => void
): Promise<YearlyInsight[]> {
  const byYear = groupByYear(projects);
  // Newest years first — most relevant, and shows progress immediately
  const sortedYears = [...byYear.keys()].sort((a, b) => b.localeCompare(a));
  if (sortedYears.length === 0) return [];

  const results: YearlyInsight[] = [];

  // Process years in batches
  for (let i = 0; i < sortedYears.length; i += INSIGHTS_BATCH_SIZE) {
    const batch = sortedYears.slice(i, i + INSIGHTS_BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (year) => {
        const yProjects = byYear.get(year)!;
        const analyzedInYear = yProjects.filter((p) => p.analysis);

        // Fallback for thin years
        if (analyzedInYear.length <= 2) {
          onStep?.(`${year} (${yProjects.length} projects, metadata)`);
          const domains = detectDomains(yProjects);
          return {
            year,
            focus: "",
            highlights: analyzedInYear.length > 0
              ? analyzedInYear
                  .sort((a, b) => (b.significance || 0) - (a.significance || 0))
                  .slice(0, 1)
                  .map((p) => p.displayName)
              : [],
            skills: [],
            domains: [...domains],
            source: "metadata" as const,
          };
        }

        onStep?.(`${year} (${yProjects.length} projects)...`);
        return analyzeYear(year, yProjects, adapter);
      })
    );

    results.push(...batchResults);
  }

  return results;
}

/**
 * Analyze a single year's projects via LLM.
 */
async function analyzeYear(
  year: string,
  projects: Project[],
  adapter: AgentAdapter
): Promise<YearlyInsight> {
  const domains = detectDomains(projects);

  // Separate authored projects (real work) from cloned/forked (interests)
  // "Authored" = has commits, has uncommitted changes, OR no git (user created the folder)
  const isAuthored = (p: Project) =>
    p.authorCommitCount > 0 || p.hasUncommittedChanges || !p.hasGit;
  const authored = projects.filter(isAuthored);
  // "Cloned" = has git, zero author commits, no uncommitted changes (pure clone/fork)
  const cloned = projects.filter((p) => !isAuthored(p) && p.analysis);

  const authoredSorted = [...authored]
    .sort((a, b) => (b.significance || 0) - (a.significance || 0))
    .slice(0, 20);

  const clonedSorted = [...cloned]
    .sort((a, b) => (b.analysis?.impactScore || 0) - (a.analysis?.impactScore || 0))
    .slice(0, 15);

  const formatProject = (p: Project) => {
    const tech = p.analysis?.techStack?.join(", ") || p.language;
    const desc = p.analysis?.summary?.slice(0, 120) || "";
    const commits = p.authorCommitCount || 0;
    const tier = p.tier || "minor";
    const stars = p.stars ? ` ⭐${p.stars}` : "";
    return `  - [${tier}] ${p.displayName} (${commits} commits${stars}): ${tech}. ${desc}`;
  };

  const authoredLines = authoredSorted.map(formatProject).join("\n");
  const clonedLines = clonedSorted.map(formatProject).join("\n");

  const promptParts = [
    `Analyze this developer's work in ${year} for a portfolio page.`,
    `${year}: ${projects.length} total projects (${authored.length} with author commits, ${cloned.length} cloned/studied).`,
    `Detected domains: ${[...domains].join(", ") || "general"}.`,
    "",
    "Respond with ONLY a JSON object:",
    '{',
    '  "focus": "1-2 sentences covering what they worked on this year",',
    '  "skills": ["capability1", "capability2"],',
    '  "domains": ["domain1", "domain2"],',
    '  "achievement": "optional one-line standout",',
    '  "exploring": ["topic1 (project1, project2)", "topic2 (project3)"]',
    '}',
    "",
    "Rules:",
    "- focus: 1-2 sentences about their AUTHORED work. Mention 2+ domains. Plain language.",
    "- skills: 2-4 capabilities demonstrated in authored work (not framework names).",
    "- domains: which domains they touched.",
    "- achievement: optional. One standout from authored work.",
    "- exploring: 1-4 items summarizing what they studied/cloned. Group by theme, mention project names.",
    "  E.g. 'NFT infrastructure (Metaplex, Wormhole)', 'DeFi protocols (Saber, Solend)'.",
    "  Skip if no interesting clones. Don't list trivial starter templates.",
    "",
  ];

  if (authoredLines) {
    promptParts.push("Authored projects (real work):", authoredLines, "");
  }
  if (clonedLines) {
    promptParts.push("Cloned/studied projects (interests, not their work):", clonedLines, "");
  }

  const prompt = promptParts.join("\n");

  try {
    const result = await adapter.analyze({
      path: "", readme: "", dependencies: "", directoryTree: "", gitShortlog: "",
      recentCommits: "", rawPrompt: prompt,
    });
    const text = result.summary || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        year,
        focus: parsed.focus || "",
        highlights: [], // determined by significance, not LLM
        skills: Array.isArray(parsed.skills) ? parsed.skills : [],
        domains: Array.isArray(parsed.domains) ? parsed.domains : [...domains],
        achievement: parsed.achievement || undefined,
        exploring: Array.isArray(parsed.exploring) && parsed.exploring.length > 0 ? parsed.exploring : undefined,
        source: "llm",
      };
    }
  } catch { /* fall through to metadata fallback */ }

  // Fallback if LLM fails
  return {
    year,
    focus: "",
    highlights: projects
      .filter((p) => p.analysis)
      .sort((a, b) => (b.significance || 0) - (a.significance || 0))
      .slice(0, 1)
      .map((p) => p.displayName),
    skills: [],
    domains: [...domains],
    source: "metadata",
  };
}

/**
 * Step 2: Generate overall profile from yearly insights (no raw projects).
 */
async function generateAggregateProfile(
  yearlyInsights: YearlyInsight[],
  projects: Project[],
  adapter: AgentAdapter
): Promise<Omit<ProfileInsights, "yearlyThemes" | "yearlyInsights" | "highlights" | "highlightsByYear"> | null> {
  // Global stats
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

  const allDomains = new Set<string>();
  for (const yi of yearlyInsights) {
    for (const d of yi.domains) allDomains.add(d);
  }

  const years = yearlyInsights.map((yi) => yi.year).sort();
  const firstYear = years[0] || "?";
  const lastYear = years[years.length - 1] || "?";

  // Build yearly evolution summary
  const yearlyContext = yearlyInsights
    .filter((yi) => yi.focus)
    .sort((a, b) => a.year.localeCompare(b.year))
    .map((yi) => {
      const parts = [`- ${yi.year}: ${yi.focus}`];
      if (yi.skills.length > 0) parts.push(`  Skills: ${yi.skills.join(", ")}`);
      if (yi.achievement) parts.push(`  Standout: ${yi.achievement}`);
      return parts.join("\n");
    })
    .join("\n");

  const prompt = [
    `Developer profile: active ${firstYear}-${lastYear}, ${projects.length} projects total.`,
    `Domains: ${[...allDomains].join(", ")}.`,
    `Top languages: ${topLangs}. Top frameworks: ${topFw}.`,
    "",
    "Yearly evolution:",
    yearlyContext,
    "",
    "Given the year-by-year evolution above, write the developer's portfolio summary.",
    "A hiring manager will scan this in 30 seconds.",
    "Respond with ONLY a JSON object:",
    '{',
    '  "bio": "3-4 sentences",',
    '  "narrative": "2-3 sentences career arc",',
    '  "strongestSkills": ["capability1", "capability2", "capability3", "capability4", "capability5"],',
    '  "uniqueTraits": ["trait1", "trait2", "trait3"]',
    '}',
    "",
    "RULES:",
    "",
    "bio: Third person. Max 2 tech names per sentence. Sentence 1 = role. Sentence 2 = breadth (3+ domains). Sentences 3-4 = differentiation.",
    "  BAD: 'Ships React/Vite clients with typed OpenAPI contracts alongside containerized TypeScript microservices on GKE.'",
    "  GOOD: 'Full-stack engineer who builds and ships real products. Has worked across mobile apps, crypto infrastructure, AI tools, and developer tooling.'",
    "",
    "narrative: 2-3 sentences. Full arc from earliest to latest year. Mention transitions between domains. Plain language.",
    "",
    "strongestSkills: 5 capabilities (not framework names). Pattern: 2 broad + 2 specific + 1 soft/meta.",
    "  BAD: ['React', 'TypeScript', 'Node.js']",
    "  GOOD: ['Full-stack web development', 'Crypto wallet infrastructure', 'Shipping solo from idea to production']",
    "",
    "uniqueTraits: 3 items, max 15 words each. What would surprise someone?",
    "",
    "SELF-CHECK: bio mentions 3+ domains? narrative covers early AND recent? skills are capabilities not names? traits under 15 words?",
  ].join("\n");

  try {
    const result = await adapter.analyze({
      path: "", readme: "", dependencies: "", directoryTree: "", gitShortlog: "",
      recentCommits: "", rawPrompt: prompt,
    });
    const text = result.summary || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        bio: parsed.bio || "",
        narrative: parsed.narrative || "",
        strongestSkills: Array.isArray(parsed.strongestSkills) ? parsed.strongestSkills : [],
        uniqueTraits: Array.isArray(parsed.uniqueTraits) ? parsed.uniqueTraits : [],
      };
    }
    return { bio: text, narrative: "", strongestSkills: [], uniqueTraits: [] };
  } catch {
    return null;
  }
}
