import type { AgentAdapter, ProjectAnalysis, ProjectContext } from "../types.ts";

/**
 * API adapter for LLM analysis.
 * Works with OpenRouter, OpenAI, Anthropic, and any OpenAI-compatible endpoint.
 *
 * Resolution order for API key:
 * 1. LLM_CV_API_KEY env var
 * 2. OPENROUTER_API_KEY
 * 3. ANTHROPIC_API_KEY
 * 4. OPENAI_API_KEY
 *
 * Resolution order for base URL:
 * 1. LLM_CV_BASE_URL env var
 * 2. Inferred from which API key was found
 */
export class APIAdapter implements AgentAdapter {
  name = "api";

  private getConfig(): { apiKey: string; baseUrl: string; model: string } | null {
    const llmCvKey = process.env.LLM_CV_API_KEY;
    const llmCvUrl = process.env.LLM_CV_BASE_URL;

    if (llmCvKey && llmCvUrl) {
      return { apiKey: llmCvKey, baseUrl: llmCvUrl, model: process.env.LLM_CV_MODEL || "gpt-4o" };
    }

    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (openRouterKey) {
      return {
        apiKey: openRouterKey,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "anthropic/claude-sonnet-4",
      };
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      return {
        apiKey: anthropicKey,
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4-20250514",
      };
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      return {
        apiKey: openaiKey,
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o",
      };
    }

    return null;
  }

  async isAvailable(): Promise<boolean> {
    return this.getConfig() !== null;
  }

  async analyze(context: ProjectContext): Promise<ProjectAnalysis> {
    const config = this.getConfig();
    if (!config) {
      throw new Error("No API key found. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.");
    }

    const prompt = buildPrompt(context);

    // Anthropic has a different API format
    if (config.baseUrl.includes("anthropic.com")) {
      return this.callAnthropic(config, prompt);
    }

    // OpenAI-compatible (OpenRouter, OpenAI, Ollama, etc.)
    return this.callOpenAI(config, prompt);
  }

  private async callOpenAI(
    config: { apiKey: string; baseUrl: string; model: string },
    prompt: string
  ): Promise<ProjectAnalysis> {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text.slice(0, 200)}`);
    }

    const json = await response.json() as any;
    const content = json.choices?.[0]?.message?.content || "";
    return parseResponse(content);
  }

  private async callAnthropic(
    config: { apiKey: string; baseUrl: string; model: string },
    prompt: string
  ): Promise<ProjectAnalysis> {
    const response = await fetch(`${config.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
    }

    const json = await response.json() as any;
    const content = json.content?.[0]?.text || "";
    return parseResponse(content);
  }
}

function buildPrompt(context: ProjectContext): string {
  const parts: string[] = [
    "Analyze this software project and respond with ONLY a JSON object (no markdown, no explanation).",
    "",
    '{"summary": "2-3 sentence description", "techStack": ["Tech1", "Tech2"], "contributions": ["Key feature 1", "Key feature 2"]}',
    "",
  ];

  if (context.readme) parts.push("=== README ===", context.readme, "");
  if (context.dependencies) parts.push("=== DEPENDENCIES ===", context.dependencies, "");
  if (context.directoryTree) parts.push("=== DIRECTORY STRUCTURE ===", context.directoryTree, "");
  if (context.gitShortlog) parts.push("=== GIT CONTRIBUTORS ===", context.gitShortlog, "");
  if (context.recentCommits) parts.push("=== RECENT COMMITS ===", context.recentCommits, "");

  return parts.join("\n");
}

function parseResponse(raw: string): ProjectAnalysis {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in API response");

  const parsed = JSON.parse(jsonMatch[0]);
  const analysis: ProjectAnalysis = {
    summary: parsed.summary || "",
    techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
    contributions: Array.isArray(parsed.contributions) ? parsed.contributions : [],
    analyzedAt: new Date().toISOString(),
    analyzedBy: "api",
  };

  if (!analysis.summary) throw new Error("Analysis has empty summary");
  if (analysis.techStack.length === 0) throw new Error("Analysis has empty techStack");

  return analysis;
}
