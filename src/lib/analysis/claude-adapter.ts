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
      let text = stdout.trim();
      try {
        const claudeOutput = JSON.parse(text);
        if (claudeOutput.result) text = claudeOutput.result;
      } catch { /* not Claude JSON format */ }
      return { summary: text, techStack: [], contributions: [], analyzedAt: new Date().toISOString(), analyzedBy: "claude" };
    }

    return parseResponse(stdout);
  }
}

function buildPrompt(context: ProjectContext): string {
  if (context.rawPrompt) return context.rawPrompt;

  const hasHistory = !!context.previousAnalysis;
  const parts: string[] = [];

  // Ownership context — affects how contributions are framed
  const isOwner = context.isOwner !== false && (context.authorCommitCount ?? 0) > 0;
  if (!isOwner && context.commitCount) {
    parts.push(`NOTE: The user is NOT the author of this project (${context.authorCommitCount ?? 0}/${context.commitCount} commits). They cloned or studied it. Describe what the project does, not what the user built. Use "This project" not "Built" or "Created".`, "");
  }

  if (hasHistory) {
    parts.push(
      "This project was previously analyzed. Here is the prior result:",
      JSON.stringify(context.previousAnalysis, null, 2),
      "",
      "The project has changed since then. Update the analysis: keep what's still accurate, revise what changed, add new contributions from recent commits.",
      "Respond with ONLY a JSON object (no markdown, no explanation).",
      "",
      '{"summary": "2-3 sentence description", "techStack": ["Tech1", "Tech2"], "contributions": ["Key feature or achievement 1", "Key feature or achievement 2"], "impactScore": 7}',
      "impactScore: Rate 1-10 as a senior CTO would. Consider: technical complexity (architecture, scale, novel solutions), real-world value (solves a real problem, has users), engineering quality (tests, CI/CD, clean architecture), scope (full product vs toy/demo).",
      "",
    );
  } else {
    parts.push(
      "Analyze this software project as an experienced CTO evaluating engineering talent. Respond with ONLY a JSON object (no markdown, no explanation).",
      "",
      "The JSON must have this exact structure:",
      '{"summary": "2-3 sentence description of what this project does", "techStack": ["Tech1", "Tech2"], "contributions": ["Key feature or achievement 1", "Key feature or achievement 2"], "impactScore": 7}',
      "impactScore: Rate 1-10 as a senior CTO would. Consider: technical complexity (architecture, scale, novel solutions), real-world value (solves a real problem, has users), engineering quality (tests, CI/CD, clean architecture), scope (full product vs toy/demo).",
      "",
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
      impactScore: typeof parsed.impactScore === "number" ? Math.min(10, Math.max(1, parsed.impactScore)) : undefined,
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
