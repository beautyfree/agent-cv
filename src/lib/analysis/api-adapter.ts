import type { AgentAdapter, ProjectAnalysis, ProjectContext } from "../types.ts";
import { resolveApiConfig, readCredentials, type SavedCredentials } from "../credentials.ts";

/**
 * API adapter for LLM analysis.
 * Works with OpenRouter, OpenAI, Anthropic, and any OpenAI-compatible endpoint.
 *
 * Resolution order: env vars → saved credentials (~/.agent-cv/credentials.json)
 */
export class APIAdapter implements AgentAdapter {
  name = "api";
  private savedCredentials: SavedCredentials | undefined;

  private async getConfig(): Promise<{ apiKey: string; baseUrl: string; model: string } | null> {
    if (this.savedCredentials === undefined) {
      this.savedCredentials = await readCredentials();
    }
    return resolveApiConfig(this.savedCredentials);
  }

  async isAvailable(): Promise<boolean> {
    return (await this.getConfig()) !== null;
  }

  async analyze(context: ProjectContext): Promise<ProjectAnalysis> {
    const config = await this.getConfig();
    if (!config) {
      throw new Error("No API key found. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.");
    }

    const prompt = buildPrompt(context);

    if (context.rawPrompt) {
      // Raw prompt mode: get LLM response as-is, caller parses
      const content = config.baseUrl.includes("anthropic.com")
        ? await this.callAnthropicRaw(config, prompt)
        : await this.callOpenAIRaw(config, prompt);
      return { summary: content, techStack: [], contributions: [], analyzedAt: new Date().toISOString(), analyzedBy: "api" };
    }

    // Anthropic has a different API format
    if (config.baseUrl.includes("anthropic.com")) {
      return this.callAnthropic(config, prompt);
    }

    // OpenAI-compatible (OpenRouter, OpenAI, Ollama, etc.)
    return this.callOpenAI(config, prompt);
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return response;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error("API request timed out after 120s");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callOpenAIRaw(config: { apiKey: string; baseUrl: string; model: string }, prompt: string): Promise<string> {
    const response = await this.fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: 2048 }),
    });
    if (!response.ok) throw new Error(`API error ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const json = await response.json() as any;
    return json.choices?.[0]?.message?.content || "";
  }

  private async callAnthropicRaw(config: { apiKey: string; baseUrl: string; model: string }, prompt: string): Promise<string> {
    const response = await this.fetchWithTimeout(`${config.baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: config.model, max_tokens: 2048, messages: [{ role: "user", content: prompt }] }),
    });
    if (!response.ok) throw new Error(`Anthropic API error ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const json = await response.json() as any;
    return json.content?.[0]?.text || "";
  }

  private async callOpenAI(
    config: { apiKey: string; baseUrl: string; model: string },
    prompt: string
  ): Promise<ProjectAnalysis> {
    const response = await this.fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
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
    const response = await this.fetchWithTimeout(`${config.baseUrl}/messages`, {
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
  if (context.rawPrompt) return context.rawPrompt;

  const parts: string[] = [];

  const isOwner = context.isOwner !== false && (context.authorCommitCount ?? 0) > 0;
  if (!isOwner && context.commitCount) {
    parts.push(`NOTE: The user is NOT the author (${context.authorCommitCount ?? 0}/${context.commitCount} commits). Describe what the project does, not what the user built.`, "");
  }

  if (context.previousAnalysis) {
    parts.push(
      "This project was previously analyzed:",
      JSON.stringify(context.previousAnalysis, null, 2),
      "",
      "The project has changed since then. Update the analysis: keep what's still accurate, add new contributions.",
      "Respond with ONLY a JSON object:",
      '{"summary": "2-3 sentence description", "techStack": ["Tech1"], "contributions": ["Feature 1"], "impactScore": 7}',
      "impactScore: Rate 1-10 as a senior CTO would. Consider: technical complexity (architecture, scale, novel solutions), real-world value (solves a real problem, has users), engineering quality (tests, CI/CD, clean architecture), scope (full product vs toy/demo).",
      "",
    );
  } else {
    parts.push(
      "Analyze this software project as an experienced CTO evaluating engineering talent. Respond with ONLY a JSON object (no markdown, no explanation).",
      "",
      '{"summary": "2-3 sentence description", "techStack": ["Tech1", "Tech2"], "contributions": ["Key feature 1", "Key feature 2"], "impactScore": 7}',
      "impactScore: Rate 1-10 as a senior CTO would. Consider: technical complexity (architecture, scale, novel solutions), real-world value (solves a real problem, has users), engineering quality (tests, CI/CD, clean architecture), scope (full product vs toy/demo).",
      "",
    );
  }

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
    impactScore: typeof parsed.impactScore === "number" ? Math.min(10, Math.max(1, parsed.impactScore)) : undefined,
    analyzedAt: new Date().toISOString(),
    analyzedBy: "api",
  };

  if (!analysis.summary) throw new Error("Analysis has empty summary");
  if (analysis.techStack.length === 0) throw new Error("Analysis has empty techStack");

  return analysis;
}
