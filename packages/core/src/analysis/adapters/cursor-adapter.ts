import type { AgentAdapter, ProjectAnalysis, ProjectContext } from "../../types.ts";
import { parseStructuredAnalysisResponse } from "../api-parse.ts";

/**
 * Cursor Agent CLI adapter.
 * Uses `agent` (cursor-agent) in headless mode with --trust -p.
 * Docs: https://cursor.com/docs/cli/headless
 */
export class CursorAdapter implements AgentAdapter {
  name = "cursor";

  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", "agent"], { stdout: "pipe", stderr: "pipe" });
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  }

  async analyze(context: ProjectContext): Promise<ProjectAnalysis> {
    const prompt = buildPrompt(context);

    // Use --trust to skip workspace trust prompt, -p for headless print mode
    const proc = Bun.spawn(
      ["agent", "--trust", "-p", prompt],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: context.path || undefined,
        timeout: 120_000,
      }
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Cursor agent exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }
    if (!stdout.trim()) throw new Error("Cursor agent returned empty response");

    if (context.rawPrompt) {
      return { summary: stdout.trim(), techStack: [], contributions: [], analyzedAt: new Date().toISOString(), analyzedBy: "cursor" };
    }

    return parseStructuredAnalysisResponse(stdout, "cursor", { projectName: context.displayName });
  }
}

function buildPrompt(context: ProjectContext): string {
  if (context.rawPrompt) return context.rawPrompt;

  const parts: string[] = [];

  const isOwner = context.isOwner !== false && (context.authorCommitCount ?? 0) > 0;
  if (!isOwner && context.commitCount) {
    parts.push(
      `NOTE: The user is NOT the author (${context.authorCommitCount ?? 0}/${context.commitCount} commits). They cloned/studied this. Do NOT copy README marketing as if the user built it. In "contributions", describe what the USER learned or explored, starting each item with a past-tense verb about the user.`,
      ""
    );
  }

  if (context.previousAnalysis) {
    parts.push(
      "Previous analysis:", JSON.stringify(context.previousAnalysis, null, 2), "",
      "Project changed since. Update the analysis: keep what's accurate, replace any contribution that reads like a commit message with a capability-level description.",
      "Respond with ONLY a JSON object:",
    );
  } else {
    parts.push("Analyze this software project as an experienced CTO evaluating engineering talent. Respond with ONLY a JSON object (no markdown, no explanation).", "");
  }

  parts.push('{"summary": "2-3 sentence product description", "techStack": ["Framework", "Language", "Database"], "contributions": ["Designed X", "Built Y", "Implemented Z"], "impactScore": 5}', "");
  parts.push("Rules:", "");
  parts.push("- summary: 2-3 sentences about what the project is and why it matters (the product/value). Do not restate the stack.", "");
  parts.push("- techStack: 3-8 real technologies (languages, frameworks, databases, notable libraries). EXCLUDE workspace packages (anything `@<project>/*` where project equals this project's name), hosting providers (Vercel, Railway, Fly, Neon, Heroku, AWS), CI services, and generic words already implied by a listed framework.", "");
  if (isOwner) {
    parts.push('- contributions: 3-5 CAPABILITIES the user demonstrated. Phrase as skills/engineering work ("Designed HLC-based LWW conflict resolution", "Built OAuth device flow"). Do NOT copy commit messages, do NOT use changelog verbs like "Fixed", "Updated", "Bumped".', "");
  } else {
    parts.push('- contributions: 2-3 takeaways about what the USER explored/learned. Start with past-tense verbs about the user ("Studied X patterns", "Explored Y internals"). Do NOT describe the project\'s features as user contributions.', "");
  }
  parts.push("- impactScore: integer 1-10, calibrated. 1=tutorial, 3=hobby/small utility, 5=solid side project, 7=production app others depend on, 9=widely used infra. Most side projects are 3-5.", "");
  if (context.readme) parts.push("=== README ===", context.readme, "");
  if (context.dependencies) parts.push("=== DEPENDENCIES ===", context.dependencies, "");
  if (context.directoryTree) parts.push("=== DIRECTORY STRUCTURE ===", context.directoryTree, "");
  if (context.gitShortlog) parts.push("=== GIT CONTRIBUTORS ===", context.gitShortlog, "");
  if (context.recentCommits) parts.push("=== RECENT COMMITS ===", context.recentCommits, "");

  return parts.join("\n");
}
