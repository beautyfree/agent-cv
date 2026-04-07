import type { AgentAdapter, ProjectAnalysis, ProjectContext } from "../types.ts";

/**
 * Codex CLI adapter.
 * Delegates project analysis to OpenAI's `codex` CLI.
 */
export class CodexAdapter implements AgentAdapter {
  name = "codex";

  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", "codex"], { stdout: "pipe", stderr: "pipe" });
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  }

  async analyze(context: ProjectContext): Promise<ProjectAnalysis> {
    const prompt = buildPrompt(context);

    const args = ["codex", "exec", prompt];
    if (context.path) args.push("-C", context.path);
    args.push("-s", "read-only");

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Codex exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }
    if (!stdout.trim()) throw new Error("Codex returned empty response");

    if (context.rawPrompt) {
      return { summary: stdout.trim(), techStack: [], contributions: [], analyzedAt: new Date().toISOString(), analyzedBy: "codex" };
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
    parts.push("Analyze this software project as an experienced CTO evaluating engineering talent. Respond with ONLY a JSON object (no markdown, no explanation).");
  }

  parts.push('{"summary": "2-3 sentence description", "techStack": ["Tech1"], "contributions": ["Feature 1"], "impactScore": 7}', "");
  parts.push("impactScore: Rate 1-10 as a senior CTO would. Consider: technical complexity (architecture, scale, novel solutions), real-world value (solves a real problem, has users), engineering quality (tests, CI/CD, clean architecture), scope (full product vs toy/demo).", "");
  if (context.readme) parts.push("README:", context.readme.slice(0, 2000), "");
  if (context.dependencies) parts.push("DEPS:", context.dependencies.slice(0, 1000), "");
  if (context.recentCommits) parts.push("COMMITS:", context.recentCommits.slice(0, 1000));
  return parts.join("\n");
}

function parseResponse(raw: string): ProjectAnalysis {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in Codex response");

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    summary: parsed.summary || "",
    techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
    contributions: Array.isArray(parsed.contributions) ? parsed.contributions : [],
    impactScore: typeof parsed.impactScore === "number" ? Math.min(10, Math.max(1, parsed.impactScore)) : undefined,
    analyzedAt: new Date().toISOString(),
    analyzedBy: "codex",
  };
}
