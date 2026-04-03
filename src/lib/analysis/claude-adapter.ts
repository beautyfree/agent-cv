import { spawn } from "node:child_process";
import type { AgentAdapter, ProjectAnalysis, ProjectContext } from "../types.ts";

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
        cwd: context.path,
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

    return parseResponse(stdout);
  }
}

function buildPrompt(context: ProjectContext): string {
  const parts: string[] = [
    "Analyze this software project and respond with ONLY a JSON object (no markdown, no explanation).",
    "",
    "The JSON must have this exact structure:",
    '{"summary": "2-3 sentence description of what this project does", "techStack": ["Tech1", "Tech2"], "contributions": ["Key feature or achievement 1", "Key feature or achievement 2"]}',
    "",
  ];

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

function parseResponse(raw: string): ProjectAnalysis {
  // Claude with --output-format json wraps the result
  let text = raw.trim();

  // Try to parse the Claude JSON output format first
  try {
    const claudeOutput = JSON.parse(text);
    // Claude's JSON output has a "result" field with the text content
    if (claudeOutput.result) {
      text = claudeOutput.result;
    }
  } catch {
    // Not Claude JSON format, use raw text
  }

  // Try to find JSON in the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in response");
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const analysis: ProjectAnalysis = {
      summary: parsed.summary || "",
      techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
      contributions: Array.isArray(parsed.contributions)
        ? parsed.contributions
        : [],
      analyzedAt: new Date().toISOString(),
      analyzedBy: "claude",
    };

    // Validate non-empty
    if (!analysis.summary) {
      throw new Error("Analysis has empty summary");
    }
    if (analysis.techStack.length === 0) {
      throw new Error("Analysis has empty techStack");
    }

    return analysis;
  } catch (err: any) {
    if (err.message.includes("Analysis has empty")) throw err;
    throw new Error(`Failed to parse analysis JSON: ${err.message}`);
  }
}
