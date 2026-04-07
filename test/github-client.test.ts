import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { GitHubClient, GitHubAuthError, GitHubRateLimitError, GitHubNotFoundError } from "../src/lib/discovery/github-client.ts";

// Mock fetch globally
const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = handler as any;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GitHubClient", () => {
  it("makes authenticated requests with token", async () => {
    let capturedHeaders: Record<string, string> = {};
    mockFetch((url, init) => {
      capturedHeaders = Object.fromEntries(Object.entries(init?.headers || {}));
      return new Response(JSON.stringify({ id: 1 }), {
        status: 200,
        headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "9999999999" },
      });
    });

    const client = new GitHubClient("test-token");
    await client.get("/repos/test/repo");
    expect(capturedHeaders["Authorization"]).toBe("Bearer test-token");
  });

  it("throws GitHubAuthError on 401", async () => {
    mockFetch(() => new Response("Unauthorized", {
      status: 401,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
    }));

    const client = new GitHubClient("bad-token");
    expect(client.get("/repos/test/repo")).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("throws GitHubNotFoundError on 404", async () => {
    mockFetch(() => new Response("Not Found", {
      status: 404,
      headers: { "x-ratelimit-remaining": "100", "x-ratelimit-reset": "9999999999" },
    }));

    const client = new GitHubClient("token");
    expect(client.get("/users/nonexistent")).rejects.toBeInstanceOf(GitHubNotFoundError);
  });

  it("tracks rate limit from response headers", async () => {
    mockFetch(() => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "x-ratelimit-remaining": "4523", "x-ratelimit-reset": "1700000000" },
    }));

    const client = new GitHubClient("token");
    await client.get("/repos/test/repo");
    expect(client.remainingRequests).toBe(4523);
  });

  it("sets rateLimited when remaining hits 0", async () => {
    mockFetch(() => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) },
    }));

    const client = new GitHubClient("token");
    await client.get("/repos/test/repo");
    expect(client.isRateLimited).toBe(true);
  });

  it("getOrNull returns null on 404", async () => {
    mockFetch(() => new Response("Not Found", {
      status: 404,
      headers: { "x-ratelimit-remaining": "100", "x-ratelimit-reset": "9999999999" },
    }));

    const client = new GitHubClient("token");
    const result = await client.getOrNull("/repos/test/nonexistent");
    expect(result).toBeNull();
  });

  it("paginate collects multiple pages", async () => {
    let callCount = 0;
    mockFetch((url) => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "100",
            "x-ratelimit-reset": "9999999999",
            "link": '<https://api.github.com/next?page=2>; rel="next"',
          },
        });
      }
      return new Response(JSON.stringify([{ id: 3 }]), {
        status: 200,
        headers: { "x-ratelimit-remaining": "99", "x-ratelimit-reset": "9999999999" },
      });
    });

    const client = new GitHubClient("token");
    const results = await client.paginate("/users/test/repos");
    expect(results).toHaveLength(3);
  });
});
