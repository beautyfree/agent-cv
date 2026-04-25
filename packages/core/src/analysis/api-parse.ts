import type { ProjectAnalysis } from "../types.ts";

/**
 * Extract the first balanced top-level `{...}` from text (handles strings and escapes).
 * Avoids greedy `\{[\s\S]*\}` matching across unrelated braces or a second JSON value.
 */
export function extractFirstJsonObject(s: string): string {
  const start = s.indexOf("{");
  if (start === -1) throw new Error("No JSON found in model response");

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < s.length; i++) {
    const c = s[i]!;

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        continue;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }

  throw new Error("No JSON found in model response");
}

/**
 * Extract a JSON object string from LLM output (plain JSON, or ```json ... ``` fences).
 */
export function extractJsonCandidate(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("{")) return extractFirstJsonObject(inner);
  }
  return extractFirstJsonObject(raw);
}

/**
 * Noise that bleeds into `techStack` when the model can't resist listing it.
 * We strip these after parsing — keeping them out of the prompt isn't enough
 * because older models regularly echo dependency names and hosting providers.
 */
const TECH_STACK_BLACKLIST = new Set([
  // Hosting / infra / CI
  "vercel", "railway", "fly", "fly.io", "neon", "heroku", "aws", "gcp", "azure",
  "netlify", "cloudflare pages", "cloudflare", "render", "digitalocean",
  "github actions", "github", "gitlab ci", "circleci", "travis",
  // Generic / implied
  "node", "node.js", "npm", "pnpm", "yarn", "git", "docker",
]);

/** Drop workspace-internal packages like `@my-project/core` whose first
 *  path segment matches the project's display name. */
function cleanTechStack(raw: string[], projectName?: string): string[] {
  const owner = projectName?.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (TECH_STACK_BLACKLIST.has(lower)) continue;
    // Strip `@<project>/<pkg>` workspace deps when we know the project name
    if (owner && lower.startsWith(`@${owner}/`)) continue;
    // De-dupe case-insensitively, keep first-seen casing
    const key = lower;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Shared structured analysis shape for API, Ollama, and CLI adapters.
 * Bump `PROMPT_VERSION` in `types.ts` when the expected JSON schema or prompts change.
 */
export function parseStructuredAnalysisResponse(
  raw: string,
  analyzedBy: string,
  opts: { projectName?: string } = {}
): ProjectAnalysis {
  const jsonStr = extractJsonCandidate(raw);
  const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const techStackRaw = Array.isArray(parsed.techStack)
    ? (parsed.techStack as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  const techStack = cleanTechStack(techStackRaw, opts.projectName);
  const contributions = Array.isArray(parsed.contributions)
    ? (parsed.contributions as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  let impactScore: number | undefined;
  if (typeof parsed.impactScore === "number") {
    impactScore = Math.min(10, Math.max(1, parsed.impactScore));
  } else if (typeof parsed.impactScore === "string" && parsed.impactScore.trim() !== "") {
    const n = Number(parsed.impactScore);
    if (!Number.isNaN(n)) impactScore = Math.min(10, Math.max(1, n));
  }

  const analysis: ProjectAnalysis = {
    summary,
    techStack,
    contributions,
    impactScore,
    analyzedAt: new Date().toISOString(),
    analyzedBy,
  };

  if (!analysis.summary) throw new Error("Analysis has empty summary");
  if (analysis.techStack.length === 0) throw new Error("Analysis has empty techStack");

  return analysis;
}

/** OpenAI-compatible / Anthropic HTTP chat `message.content`. */
export function parseApiAnalysisResponse(
  raw: string,
  opts: { projectName?: string } = {}
): ProjectAnalysis {
  return parseStructuredAnalysisResponse(raw, "api", opts);
}

/** Ollama `/v1/chat/completions` message content. */
export function parseOllamaAnalysisResponse(
  raw: string,
  opts: { projectName?: string } = {}
): ProjectAnalysis {
  return parseStructuredAnalysisResponse(raw, "ollama", opts);
}

/**
 * Strip Claude CLI `--output-format json` wrapper: top-level `{ "result": "..." }`.
 */
export function unwrapClaudeCliJsonStdout(raw: string): string {
  let text = raw.trim();
  try {
    const claudeOutput = JSON.parse(text) as { result?: unknown };
    if (typeof claudeOutput.result === "string") {
      text = claudeOutput.result;
    }
  } catch {
    /* not full-document JSON */
  }
  return text;
}

/** Claude Code CLI stdout after optional JSON wrapper. */
export function parseClaudeCliAnalysisResponse(
  stdout: string,
  opts: { projectName?: string } = {}
): ProjectAnalysis {
  const inner = unwrapClaudeCliJsonStdout(stdout);
  try {
    return parseStructuredAnalysisResponse(inner, "claude", opts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Analysis has empty")) throw err;
    throw new Error(`Failed to parse analysis JSON: ${msg}`);
  }
}
