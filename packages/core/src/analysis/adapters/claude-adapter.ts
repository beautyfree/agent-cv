import type { AgentAdapter, ProjectAnalysis, ProjectContext } from "../../types.ts";
import { parseClaudeCliAnalysisResponse, unwrapClaudeCliJsonStdout } from "../api-parse.ts";

/**
 * Claude Code CLI adapter.
 * Delegates project analysis to `claude` via stdin piping.
 */
export class ClaudeAdapter implements AgentAdapter {
  name = "claude";

  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", "claude"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  async analyze(context: ProjectContext): Promise<ProjectAnalysis> {
    const prompt = buildPrompt(context);

    // Pipe prompt via stdin to avoid shell history leak
    const proc = Bun.spawn(
      ["claude", "-p", "--output-format", "json"],
      {
        stdin: new Response(prompt),
        stdout: "pipe",
        stderr: "pipe",
        cwd: context.path || undefined,
        timeout: 120_000, // 2 minute timeout
      }
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(
        `Claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`
      );
    }

    if (!stdout.trim()) {
      throw new Error("Claude returned empty response");
    }

    if (context.rawPrompt) {
      // Raw prompt mode: return LLM output as-is in summary, caller parses
      const text = unwrapClaudeCliJsonStdout(stdout);
      return { summary: text, techStack: [], contributions: [], analyzedAt: new Date().toISOString(), analyzedBy: "claude" };
    }

    return parseClaudeCliAnalysisResponse(stdout, { projectName: context.displayName });
  }
}

function buildPrompt(context: ProjectContext): string {
  if (context.rawPrompt) return context.rawPrompt;

  const hasHistory = !!context.previousAnalysis;
  const parts: string[] = [];

  // Ownership context — affects how contributions are framed
  const isOwner = context.isOwner !== false && (context.authorCommitCount ?? 0) > 0;
  if (!isOwner && context.commitCount) {
    parts.push(
      `NOTE: The user is NOT the author (${context.authorCommitCount ?? 0}/${context.commitCount} commits). They cloned/studied this. Do NOT copy README marketing as if the user built it. In "contributions", describe what the USER explored/learned, starting each item with a past-tense verb about the user (e.g. "Studied...", "Explored...").`,
      ""
    );
  }

  const rules = [
    "Rules:",
    '- summary: 2-3 sentences about the product/value. Do not restate the stack.',
    '- techStack: 3-8 real technologies (languages, frameworks, databases, notable libraries). EXCLUDE workspace packages (anything @<project>/* where <project> equals this project\'s name), hosting providers (Vercel, Railway, Fly, Neon, Heroku, AWS), CI services, and generic words already implied by a listed framework.',
    isOwner
      ? '- contributions: 3-5 CAPABILITIES the user demonstrated by building this. Phrase each as a skill or piece of engineering work (e.g. "Designed HLC-based LWW conflict resolution", "Built OAuth device flow for a CLI", "Implemented schema-aware Postgres migrations"). Do NOT copy commit messages. Do NOT use changelog verbs like "Fixed", "Updated", "Bumped".'
      : '- contributions: 2-3 short items describing what the USER can take away from having read this code. Start each with a past-tense verb about the user.',
    "- impactScore: integer 1-10, calibrated. 1=tutorial, 3=hobby/small utility, 5=solid side project, 7=production app others depend on, 9=widely used infra. Most side projects are 3-5.",
    "",
  ];

  if (hasHistory) {
    parts.push(
      "This project was previously analyzed. Here is the prior result:",
      JSON.stringify(context.previousAnalysis, null, 2),
      "",
      "The project has changed since then. Update the analysis: keep what's still accurate, replace any contribution that reads like a commit message with a capability-level description.",
      "Respond with ONLY a JSON object (no markdown, no explanation).",
      "",
      '{"summary": "2-3 sentence product description", "techStack": ["Framework", "Language", "Database"], "contributions": ["Designed X", "Built Y"], "impactScore": 5}',
      "",
      ...rules,
    );
  } else {
    parts.push(
      "Analyze this software project as an experienced CTO evaluating engineering talent. Respond with ONLY a JSON object (no markdown, no explanation).",
      "",
      "The JSON must have this exact structure:",
      '{"summary": "2-3 sentence product description", "techStack": ["Framework", "Language", "Database"], "contributions": ["Designed X", "Built Y"], "impactScore": 5}',
      "",
      ...rules,
    );
  }

  if (context.readme) {
    parts.push("=== README ===", context.readme, "");
  }
  if (context.dependencies) {
    parts.push("=== DEPENDENCIES ===", context.dependencies, "");
  }
  if (context.directoryTree) {
    parts.push("=== DIRECTORY STRUCTURE ===", context.directoryTree, "");
  }
  if (context.gitShortlog) {
    parts.push("=== GIT CONTRIBUTORS ===", context.gitShortlog, "");
  }
  if (context.recentCommits) {
    parts.push("=== RECENT COMMITS ===", context.recentCommits, "");
  }

  return parts.join("\n");
}
