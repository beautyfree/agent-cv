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

  const prompt = [
    "You are a tech portfolio writer summarizing a developer's evolution year by year.",
    "Respond with ONLY a JSON array.",
    "",
    "Format: [{\"year\": \"2024\", \"focus\": \"one sentence\", \"topProjects\": [\"name1\", \"name2\"]}]",
    "",
    "Rules:",
    "- focus MUST mention every distinct area they worked in that year, not just the biggest one.",
    "  BAD:  \"Built microservices for Etherean\"",
    "  GOOD: \"Balanced crypto backend work with AI tooling experiments and a React Native feeding tracker\"",
    "- topProjects: pick 1-3 from DIFFERENT domains. If 8 projects are all from one org, still pick only 1 from it and look for others.",
    "- Write focus as if explaining to a friend, not writing a spec. No jargon stacking.",
    "- Skip years with only clones or trivial forks.",
    "",
    "Before outputting, verify: does every focus sentence mention at least 2 different areas? If not, rewrite it.",
    "",
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

  const themesContext = yearlyThemes.length > 0
    ? "\nYearly evolution:\n" + yearlyThemes.map((t) => `- ${t.year}: ${t.focus} (${t.topProjects.join(", ")})`).join("\n") + "\n"
    : "";

  const primaryCount = projects.filter((p) => p.tier === "primary").length;
  const secondaryCount = projects.filter((p) => p.tier === "secondary").length;

  const prompt = [
    "You are a portfolio writer for a developer's personal site. Your reader is a hiring manager or founder scanning this page for 30 seconds. Every sentence must earn its place.",
    "",
    "Respond with ONLY a JSON object:",
    '{',
    '  "bio": "string (3-4 sentences)",',
    '  "highlights": {"2024": ["proj1", "proj2"], "2023": ["proj3"], ...},',
    '  "narrative": "string (2-3 sentences)",',
    '  "strongestSkills": ["skill1", "skill2", "skill3", "skill4", "skill5"],',
    '  "uniqueTraits": ["trait1", "trait2", "trait3"]',
    '}',
    "",
    "===== BIO =====",
    "Write for a human who doesn't know this person. Third person.",
    "Sentence 1: what they are (role + primary strength).",
    "Sentence 2: the range of what they build (mention 3+ different areas from the data).",
    "Sentence 3-4: what sets them apart or what they care about.",
    "",
    "HARD CONSTRAINTS:",
    "- Max 2 technology names per sentence. 'TypeScript and React' is fine. 'TypeScript, React, Vite, OpenAPI, gRPC' is not.",
    "- Never stack jargon. Test: would a non-technical founder understand each sentence?",
    "- Never hedge ('their public story starts', 'based on available data'). You see the complete picture.",
    "- Mention breadth. This developer has " + projects.length + " projects. If the bio sounds like they only do one thing, rewrite.",
    "",
    "BAD: 'Ships React/Vite clients with typed OpenAPI contracts alongside containerized TypeScript microservices on GKE with gRPC and protobuf tooling.'",
    "GOOD: 'Full-stack engineer who builds and ships real products. Has worked across mobile apps, crypto infrastructure, AI tools, and developer tooling. Comfortable owning a project from idea to production deploy.'",
    "",
    "===== HIGHLIGHTS =====",
    "Object keyed by year. For each year with meaningful work, pick 1-3 standout projects.",
    "",
    "HARD CONSTRAINTS:",
    "- MUST cover at least 3 different years (or all years if fewer than 3).",
    "- Within one year, projects must be from different areas. Never 2+ projects from the same org or monorepo.",
    "- Prefer: projects with stars, high impactScore, interesting domain, many commits.",
    "- Include recent years (2025, 2026) if they have notable projects. Don't only highlight old work.",
    "",
    "BAD: {\"2023\": [\"EthereanBackend\", \"auth-app\", \"gate-service\"]} — all from one org.",
    "GOOD: {\"2026\": [\"llm-cv\", \"publora\"], \"2025\": [\"rork-feeding\", \"ai-privet\"], \"2023\": [\"p2p-wallet-ios\", \"datingcrm\"]}",
    "",
    "===== NARRATIVE =====",
    "2-3 sentences telling the career arc using the yearly evolution data below.",
    "Must span the full timeline from earliest to most recent year.",
    "Write like telling a friend 'here's how their interests evolved.'",
    "",
    "BAD: 'They moved from Telegram Mini Apps into Etherean microservices.' — too narrow, one transition.",
    "GOOD: 'Started with frontend experiments and game prototypes, then got deep into crypto wallets and blockchain infrastructure. More recently shifted toward AI-powered tools and developer productivity.'",
    "",
    "===== STRONGEST SKILLS =====",
    "Exactly 5 items. Describe capabilities, not framework names.",
    "Pattern: 2 broad + 2 specific + 1 meta/soft.",
    "",
    "BAD: ['React', 'TypeScript', 'Node.js', 'Solidity', 'Docker']",
    "GOOD: ['Full-stack web development', 'Crypto wallet and DeFi infrastructure', 'Building CLI tools and developer SDKs', 'Containerized microservice architecture', 'Shipping solo from idea to production']",
    "",
    "===== UNIQUE TRAITS =====",
    "3 items. What would surprise someone? Under 15 words each.",
    "",
    "BAD: ['Unusually wide surface area from Mini App frontends to Rust microservices and on-chain-adjacent tooling'] — too long, too jargony.",
    "GOOD: ['Ships full products solo, not just components', 'Jumps between crypto, AI, and mobile without losing depth', '500+ projects across 7 years — builds constantly']",
    "",
    "===== SELF-CHECK =====",
    "Before outputting, verify:",
    "1. Does bio mention 3+ different areas? If not, add them.",
    "2. Do highlights span 3+ years? If not, add more years.",
    "3. Does narrative cover early AND recent work? If not, expand.",
    "4. Are skills capabilities, not framework names? If not, rewrite.",
    "5. Is every uniqueTrait under 15 words? If not, trim.",
    "",
    `Active since: ${firstYear}`,
    `Top languages: ${topLangs}`,
    `Top frameworks: ${topFw}`,
    `Total: ${projects.length} projects (${primaryCount} primary, ${secondaryCount} secondary)`,
    themesContext,
    "Projects (sorted by significance):",
    projectSummaries,
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
