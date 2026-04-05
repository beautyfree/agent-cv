import type { AgentAdapter, Project, ProjectContext } from "../types.ts";

export interface YearlyTheme {
  year: string;
  focus: string;
  topProjects: string[];
}

export interface ProfileInsights {
  bio: string;
  highlights: string[];
  narrative: string;
  strongestSkills: string[];
  uniqueTraits: string[];
  yearlyThemes: YearlyTheme[];
}

/**
 * Generate profile insights in two steps:
 * 1. Yearly themes — what was the developer focused on each year
 * 2. Final profile — bio, highlights, narrative, skills using yearly context
 */
export async function generateProfileInsights(
  projects: Project[],
  adapter: AgentAdapter,
  onStep?: (step: string) => void
): Promise<ProfileInsights | null> {
  const analyzed = projects.filter((p) => p.analysis);
  if (analyzed.length === 0) return null;

  // Step 1: Generate yearly themes
  onStep?.("analyzing yearly themes...");
  const yearlyThemes = await generateYearlyThemes(projects, adapter);

  // Step 2: Generate final profile using yearly context
  onStep?.("generating profile insights...");
  const profile = await generateFinalProfile(projects, adapter, yearlyThemes);

  if (!profile) return null;
  return { ...profile, yearlyThemes };
}

/**
 * Step 1: Group projects by year, ask LLM to identify themes per year.
 */
async function generateYearlyThemes(
  projects: Project[],
  adapter: AgentAdapter
): Promise<YearlyTheme[]> {
  // Group by year, only include primary/secondary tier projects
  const byYear = new Map<string, Project[]>();
  for (const p of projects) {
    if (p.tier === "minor" && !p.analysis) continue;
    const year = p.dateRange.end?.split("-")[0] || p.dateRange.start?.split("-")[0] || "Unknown";
    if (year === "Unknown") continue;
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(p);
  }

  const sortedYears = [...byYear.keys()].sort();
  if (sortedYears.length === 0) return [];

  const yearSummaries = sortedYears.map((year) => {
    const yProjects = byYear.get(year)!;
    const lines = yProjects
      .sort((a, b) => (b.significance || 0) - (a.significance || 0))
      .slice(0, 10)
      .map((p) => {
        const tech = p.analysis?.techStack?.join(", ") || p.language;
        const desc = p.analysis?.summary?.slice(0, 80) || "";
        const tier = p.tier || "minor";
        const stars = p.stars ? ` ⭐${p.stars}` : "";
        return `  - [${tier}] ${p.displayName}${stars}: ${tech}. ${desc}`;
      })
      .join("\n");
    return `${year} (${yProjects.length} projects):\n${lines}`;
  }).join("\n\n");

  // Compute domain distribution per year for the prompt
  const domainHints = sortedYears.map((year) => {
    const yProjects = byYear.get(year)!;
    const domains = new Set<string>();
    for (const p of yProjects) {
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
    return domains.size > 0 ? `${year} domains: ${[...domains].join(", ")}` : null;
  }).filter(Boolean).join("\n");

  const prompt = [
    "Summarize this developer's year-by-year evolution for a portfolio page.",
    "Respond with ONLY a JSON array.",
    "",
    "Format: [{\"year\": \"2024\", \"focus\": \"one sentence\", \"topProjects\": [\"name1\", \"name2\"]}]",
    "",
    "Example input:",
    "2024 (15 projects):",
    "  - [primary] my-wallet: React, Ethers.js. Crypto wallet with swap feature",
    "  - [primary] chat-ai: TypeScript, OpenAI. AI chat assistant",
    "  - [secondary] landing-page: Next.js. Company marketing site",
    "",
    "Example output:",
    '[{"year": "2024", "focus": "Split time between a crypto wallet project and an AI chat tool, with some marketing site work on the side.", "topProjects": ["my-wallet", "chat-ai"]}]',
    "",
    "Rules:",
    "- focus: one sentence covering ALL distinct areas they touched that year. Mention 2+ domains.",
    "- topProjects: 1-3 from DIFFERENT domains. Max 1 per org/monorepo.",
    "- Write like you're telling a friend, not writing a resume. Plain language.",
    "- Skip years with only clones or trivial forks.",
    "",
    "Domain hints (pre-computed from tech stacks):",
    domainHints,
    "",
    "Projects by year:",
    yearSummaries,
  ].join("\n");

  try {
    const result = await adapter.analyze({
      path: "", readme: "", dependencies: "", directoryTree: "", gitShortlog: "",
      recentCommits: "", rawPrompt: prompt,
    });
    const text = result.summary || "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return Array.isArray(parsed) ? parsed.filter((t: any) => t.year && t.focus) : [];
    }
  } catch { /* optional */ }
  return [];
}

/**
 * Step 2: Generate final profile using yearly themes as context.
 */
async function generateFinalProfile(
  projects: Project[],
  adapter: AgentAdapter,
  yearlyThemes: YearlyTheme[]
): Promise<Omit<ProfileInsights, "yearlyThemes"> | null> {
  // Sort by significance, include top projects with full details
  const sorted = [...projects].sort((a, b) => (b.significance || 0) - (a.significance || 0));
  const projectSummaries = sorted
    .slice(0, 50)
    .map((p) => {
      const tech = p.analysis?.techStack?.join(", ") || p.language;
      const desc = p.analysis?.summary?.slice(0, 120) || "";
      const commits = p.authorCommitCount || p.commitCount;
      const lines = p.size?.lines ? `${Math.round(p.size.lines / 1000)}K lines` : "";
      const stars = p.stars ? `, ⭐${p.stars}` : "";
      const tier = p.tier ? ` [${p.tier}]` : "";
      return `- ${p.displayName}${tier} (${p.dateRange.start?.split("-")[0] || "?"}, ${commits} commits${stars}${lines ? ", " + lines : ""}): ${tech}. ${desc}`;
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
  const sortedYears = [...new Set(years)];

  const themesContext = yearlyThemes.length > 0
    ? "\nYearly evolution:\n" + yearlyThemes.map((t) => `- ${t.year}: ${t.focus} (${t.topProjects.join(", ")})`).join("\n") + "\n"
    : "";

  const primaryCount = projects.filter((p) => p.tier === "primary").length;
  const secondaryCount = projects.filter((p) => p.tier === "secondary").length;

  // Compute domain summary for breadth hint
  const allDomains = new Set<string>();
  for (const p of projects) {
    const tech = (p.analysis?.techStack || []).concat(p.frameworks).join(" ").toLowerCase();
    if (tech.match(/react|next|vue|svelte|frontend/)) allDomains.add("web frontend");
    if (tech.match(/express|fastify|nest|hono|backend|api/)) allDomains.add("backend services");
    if (tech.match(/solana|ethereum|web3|blockchain|defi|wallet/)) allDomains.add("crypto/blockchain");
    if (tech.match(/openai|llm|ai|ml|agent|claude/)) allDomains.add("AI/ML");
    if (tech.match(/react.native|swift|kotlin|mobile|ios|android/)) allDomains.add("mobile");
    if (tech.match(/cli|terminal/)) allDomains.add("CLI/developer tools");
    if (tech.match(/docker|kubernetes|terraform/)) allDomains.add("infrastructure");
    if (p.language === "Rust") allDomains.add("Rust/systems");
  }
  const domainList = [...allDomains].join(", ");

  const prompt = [
    // === DATA FIRST (anchoring — LLM reads this with full attention) ===
    `Developer profile: active since ${firstYear}, ${projects.length} projects total (${primaryCount} primary, ${secondaryCount} secondary).`,
    `Domains: ${domainList}.`,
    `Top languages: ${topLangs}. Top frameworks: ${topFw}.`,
    themesContext,
    "Top projects by significance:",
    projectSummaries,
    "",
    // === TASK (what to produce) ===
    "Given the developer data above, write their portfolio page. A hiring manager will scan this in 30 seconds.",
    "Respond with ONLY a JSON object:",
    '{',
    '  "bio": "3-4 sentences",',
    '  "highlights": {"2026": ["proj1"], "2025": ["proj2", "proj3"], "2023": ["proj4"]},',
    '  "narrative": "2-3 sentences",',
    '  "strongestSkills": ["capability1", "capability2", "capability3", "capability4", "capability5"],',
    '  "uniqueTraits": ["trait1", "trait2", "trait3"]',
    '}',
    "",
    // === CONSTRAINTS (recency — LLM reads these last, strongest enforcement) ===
    "RULES FOR EACH FIELD:",
    "",
    "bio: Third person. Max 2 tech names per sentence. Sentence 1 = role. Sentence 2 = breadth (mention 3+ domains from the Domains list above). Sentences 3-4 = what sets them apart. Never hedge or imply partial data.",
    "  BAD: 'Ships React/Vite clients with typed OpenAPI contracts alongside containerized TypeScript microservices on GKE.'",
    "  GOOD: 'Full-stack engineer who builds and ships real products. Has worked across mobile apps, crypto infrastructure, AI tools, and developer tooling. Comfortable owning a project from idea to production.'",
    "",
    "highlights: Object by year. EVERY year that has projects MUST have 1-3 highlights. No year skipped. Max 1 project from any single org per year. Prefer: starred, high impactScore, unique domain.",
    "  BAD: {\"2023\": [\"EthereanBackend\", \"auth-app\", \"gate-service\"]} — same org, missing other years.",
    "  GOOD: {\"2026\": [\"llm-cv\", \"publora\"], \"2025\": [\"rork-feeding\", \"ai-privet\"], \"2024\": [\"ads-mcp\"], \"2023\": [\"p2p-wallet-ios\", \"datingcrm\"], \"2022\": [\"mmorpg\"], \"2021\": [\"react-portalslots\"]}",
    "",
    "narrative: 2-3 sentences. Full arc from earliest year to latest. Multiple transitions, not just one. Plain language.",
    "  BAD: 'Moved from Telegram Mini Apps into Etherean microservices.' — one transition, narrow.",
    "  GOOD: 'Started with frontend experiments, got deep into crypto wallets and DeFi, then shifted toward AI tools and developer productivity.'",
    "",
    "strongestSkills: 5 capabilities (not framework names). Pattern: 2 broad + 2 specific + 1 soft/meta.",
    "  BAD: ['React', 'TypeScript', 'Node.js', 'Solidity', 'Docker']",
    "  GOOD: ['Full-stack web development', 'Crypto wallet infrastructure', 'CLI tools and developer SDKs', 'Containerized microservices', 'Shipping solo from idea to production']",
    "",
    "uniqueTraits: 3 items, max 15 words each. What would surprise someone?",
    "  BAD: ['Unusually wide surface area from Mini App frontends to Rust microservices'] — jargon.",
    "  GOOD: ['Ships full products solo, not just components', 'Builds across crypto, AI, and mobile', '" + projects.length + " projects across " + (sortedYears.length) + " years']",
    "",
    "SELF-CHECK: Before outputting verify — bio mentions 3+ domains? highlights span 3+ years? narrative covers early AND recent? skills are capabilities not names? traits under 15 words?",
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
      // highlights can be { "2024": ["a", "b"], "2023": ["c"] } or flat ["a", "b"]
      let highlights: string[] = [];
      if (parsed.highlights && typeof parsed.highlights === "object" && !Array.isArray(parsed.highlights)) {
        // Per-year format — flatten to array but keep in yearly order (newest first)
        const years = Object.keys(parsed.highlights).sort((a, b) => b.localeCompare(a));
        for (const year of years) {
          const yearProjects = parsed.highlights[year];
          if (Array.isArray(yearProjects)) highlights.push(...yearProjects);
        }
      } else if (Array.isArray(parsed.highlights)) {
        highlights = parsed.highlights;
      }

      // Preserve per-year structure if available
      const highlightsByYear: Record<string, string[]> = {};
      if (parsed.highlights && typeof parsed.highlights === "object" && !Array.isArray(parsed.highlights)) {
        for (const [year, projs] of Object.entries(parsed.highlights)) {
          if (Array.isArray(projs)) highlightsByYear[year] = projs;
        }
      }

      return {
        bio: parsed.bio || "",
        highlights,
        highlightsByYear: Object.keys(highlightsByYear).length > 0 ? highlightsByYear : undefined,
        narrative: parsed.narrative || "",
        strongestSkills: Array.isArray(parsed.strongestSkills) ? parsed.strongestSkills : [],
        uniqueTraits: Array.isArray(parsed.uniqueTraits) ? parsed.uniqueTraits : [],
      };
    }
    return { bio: text, highlights: [], narrative: "", strongestSkills: [], uniqueTraits: [] };
  } catch {
    return null;
  }
}
