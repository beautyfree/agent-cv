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

    const proc = Bun.spawn(
      ["codex", "exec", prompt, "-C", context.path, "-s", "read-only"],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      }
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Codex exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }
    if (!stdout.trim()) throw new Error("Codex returned empty response");

    return parseResponse(stdout);
  }
}

function buildPrompt(context: ProjectContext): string {
  const parts: string[] = [
    "Analyze this software project. Respond with ONLY a JSON object:",
    '{"summary": "2-3 sentence description", "techStack": ["Tech1"], "contributions": ["Feature 1"]}',
    "",
  ];
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
    analyzedAt: new Date().toISOString(),
    analyzedBy: "codex",
  };
}
