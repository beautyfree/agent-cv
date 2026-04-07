import type { AgentAdapter, ProjectAnalysis, ProjectContext } from "../types.ts";

/**
 * OpenCode CLI adapter.
 * Delegates project analysis to the `opencode` agent CLI.
 * https://github.com/opencode-ai/opencode
 */
export class OpenCodeAdapter implements AgentAdapter {
  name = "opencode";

  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", "opencode"], { stdout: "pipe", stderr: "pipe" });
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  }

  async analyze(context: ProjectContext): Promise<ProjectAnalysis> {
    const prompt = buildPrompt(context);

    // OpenCode supports piping prompt via stdin with -p (print mode)
    const proc = Bun.spawn(
      ["opencode", "run", "-p", prompt],
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
      throw new Error(`OpenCode exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }
    if (!stdout.trim()) throw new Error("OpenCode returned empty response");

    if (context.rawPrompt) {
      return { summary: stdout.trim(), techStack: [], contributions: [], analyzedAt: new Date().toISOString(), analyzedBy: "opencode" };
    }

    return parseResponse(stdout);
  }
}

function buildPrompt(context: ProjectContext): string {
  if (context.rawPrompt) return context.rawPrompt;

  const parts: string[] = [];

  const isOwner = context.isOwner !== false && (context.authorCommitCount ?? 0) > 0;
  if (!isOwner && context.commitCount) {
    parts.push(`NOTE: The user is NOT the author (${context.authorCommitCount ?? 0}/${context.commitCount} commits). Describe what the project does, not what the user built.`, "");
  }

  if (context.previousAnalysis) {
    parts.push(
      "Previous analysis:", JSON.stringify(context.previousAnalysis, null, 2), "",
      "Project changed since. Update the analysis. Respond with ONLY JSON:",
    );
  } else {
    parts.push("Analyze this software project as an experienced CTO evaluating engineering talent. Respond with ONLY a JSON object (no markdown, no explanation).", "");
  }

  parts.push('{"summary": "2-3 sentence description", "techStack": ["Tech1"], "contributions": ["Feature 1"], "impactScore": 7}', "");
  parts.push("impactScore: Rate 1-10 as a senior CTO would. Consider: technical complexity (architecture, scale, novel solutions), real-world value (solves a real problem, has users), engineering quality (tests, CI/CD, clean architecture), scope (full product vs toy/demo).", "");
  if (context.readme) parts.push("=== README ===", context.readme, "");
  if (context.dependencies) parts.push("=== DEPENDENCIES ===", context.dependencies, "");
  if (context.directoryTree) parts.push("=== DIRECTORY STRUCTURE ===", context.directoryTree, "");
  if (context.gitShortlog) parts.push("=== GIT CONTRIBUTORS ===", context.gitShortlog, "");
  if (context.recentCommits) parts.push("=== RECENT COMMITS ===", context.recentCommits, "");

  return parts.join("\n");
}

function parseResponse(raw: string): ProjectAnalysis {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in OpenCode response");

  const parsed = JSON.parse(jsonMatch[0]);
  const analysis: ProjectAnalysis = {
    summary: parsed.summary || "",
    techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
    contributions: Array.isArray(parsed.contributions) ? parsed.contributions : [],
    impactScore: typeof parsed.impactScore === "number" ? Math.min(10, Math.max(1, parsed.impactScore)) : undefined,
    analyzedAt: new Date().toISOString(),
    analyzedBy: "opencode",
  };

  if (!analysis.summary) throw new Error("Analysis has empty summary");
  if (analysis.techStack.length === 0) throw new Error("Analysis has empty techStack");

  return analysis;
}
