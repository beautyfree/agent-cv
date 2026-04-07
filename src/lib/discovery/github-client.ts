/**
 * Centralized GitHub API client with auth, rate limiting, and retry.
 * Used by both GitHubProvider (cloud scanning) and enrichGitHubData().
 *
 *   ┌────────────┐     ┌──────────────┐     ┌─────────────┐
 *   │ github-    │────▶│ Rate limit   │────▶│ GitHub API  │
 *   │ scanner.ts │     │ tracker      │     │             │
 *   ├────────────┤     │              │     │ 5000 req/hr │
 *   │ enrich     │────▶│ Retry on 429 │────▶│ with token  │
 *   │ GitHubData │     │ Auth header  │     │             │
 *   └────────────┘     └──────────────┘     └─────────────┘
 */

export class GitHubClient {
  private token: string | undefined;
  private remaining: number = -1;
  private resetAt: number = 0;
  private rateLimited: boolean = false;

  constructor(token?: string) {
    this.token = token || process.env.GITHUB_TOKEN;
  }

  /** Create client with token from env or saved credentials */
  static async create(): Promise<GitHubClient> {
    const envToken = process.env.GITHUB_TOKEN;
    if (envToken) return new GitHubClient(envToken);
    const { resolveGitHubToken } = await import("../credentials.ts");
    const saved = await resolveGitHubToken();
    return new GitHubClient(saved || undefined);
  }

  get isAuthenticated(): boolean {
    return !!this.token;
  }

  get remainingRequests(): number {
    return this.remaining;
  }

  get isRateLimited(): boolean {
    return this.rateLimited;
  }

  /**
   * Make an authenticated GET request to the GitHub API.
   * Handles rate limiting, retry on 429, and common error codes.
   */
  async get<T = any>(path: string): Promise<T> {
    if (this.rateLimited) {
      const waitMs = (this.resetAt * 1000) - Date.now();
      if (waitMs > 0) {
        throw new GitHubRateLimitError(this.remaining, this.resetAt);
      }
      this.rateLimited = false;
    }

    const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
    const headers: Record<string, string> = {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "agent-cv",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { headers, redirect: "follow" });

        // Update rate limit tracking from response headers
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = res.headers.get("x-ratelimit-reset");
        if (remaining !== null) this.remaining = parseInt(remaining, 10);
        if (reset !== null) this.resetAt = parseInt(reset, 10);

        if (remaining === "0") {
          this.rateLimited = true;
        }

        if (res.status === 200) {
          return await res.json() as T;
        }

        if (res.status === 401) {
          throw new GitHubAuthError("Invalid GITHUB_TOKEN. See: https://github.com/settings/tokens");
        }

        if (res.status === 403 && this.rateLimited) {
          throw new GitHubRateLimitError(this.remaining, this.resetAt);
        }

        if (res.status === 404) {
          throw new GitHubNotFoundError(path);
        }

        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get("retry-after") || "60", 10);
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            continue;
          }
          throw new GitHubRateLimitError(0, Math.floor(Date.now() / 1000) + retryAfter);
        }

        // Other errors
        const body = await res.text().catch(() => "");
        throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
      } catch (err: any) {
        if (err instanceof GitHubAuthError || err instanceof GitHubNotFoundError) {
          throw err;
        }
        if (err instanceof GitHubRateLimitError && attempt >= 2) {
          throw err;
        }
        lastError = err;
        if (attempt < 2 && isTransient(err.message)) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error("GitHub API: unreachable");
  }

  /**
   * GET with 404 returning null instead of throwing.
   */
  async getOrNull<T = any>(path: string): Promise<T | null> {
    try {
      return await this.get<T>(path);
    } catch (err) {
      if (err instanceof GitHubNotFoundError) return null;
      throw err;
    }
  }

  /**
   * Fetch all pages of a paginated GitHub API endpoint.
   */
  async paginate<T = any>(path: string, maxPages: number = 20): Promise<T[]> {
    const results: T[] = [];
    let url = path.includes("?") ? `${path}&per_page=100` : `${path}?per_page=100`;
    let page = 0;

    while (url && page < maxPages) {
      const fullUrl = url.startsWith("http") ? url : `https://api.github.com${url}`;
      const headers: Record<string, string> = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "agent-cv",
      };
      if (this.token) {
        headers["Authorization"] = `Bearer ${this.token}`;
      }

      const res = await fetch(fullUrl, { headers, redirect: "follow" });

      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = res.headers.get("x-ratelimit-reset");
      if (remaining !== null) this.remaining = parseInt(remaining, 10);
      if (reset !== null) this.resetAt = parseInt(reset, 10);
      if (remaining === "0") this.rateLimited = true;

      if (!res.ok) {
        if (res.status === 401) throw new GitHubAuthError("Invalid GITHUB_TOKEN");
        if (res.status === 403 && this.rateLimited) {
          throw new GitHubRateLimitError(this.remaining, this.resetAt);
        }
        break;
      }

      const data = await res.json() as T[];
      if (!Array.isArray(data) || data.length === 0) break;
      results.push(...data);

      // Parse Link header for next page
      const link = res.headers.get("link");
      const nextMatch = link?.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1]! : "";
      page++;
    }

    return results;
  }
}

function isTransient(message: string): boolean {
  const lower = message.toLowerCase();
  return ["timeout", "econnreset", "econnrefused", "etimedout", "fetch failed", "network"].some(
    p => lower.includes(p)
  );
}

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

export class GitHubRateLimitError extends Error {
  remaining: number;
  resetAt: number;
  constructor(remaining: number, resetAt: number) {
    const resetDate = new Date(resetAt * 1000);
    super(`GitHub API rate limited. Resets at ${resetDate.toLocaleTimeString()}`);
    this.name = "GitHubRateLimitError";
    this.remaining = remaining;
    this.resetAt = resetAt;
  }
}

export class GitHubNotFoundError extends Error {
  constructor(path: string) {
    super(`GitHub API 404: ${path}`);
    this.name = "GitHubNotFoundError";
  }
}
