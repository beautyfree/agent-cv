import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import superjson from "superjson";
import {
  ensureAuth,
  getAgentCvApiUrl,
  runDeviceFlowPoll,
} from "@agent-cv/core/src/auth/index.ts";
import { resetDataDir } from "@agent-cv/core/src/data-dir.ts";

/** Minimal tRPC HTTP batch + superjson wire shape for mocking fetch in tests */
function trpcBatchJsonResponse(data: unknown, status = 200) {
  const body = JSON.stringify([
    { result: { data: superjson.serialize(data) } },
  ]);
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.AGENT_CV_API_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.AGENT_CV_API_URL = originalApiUrl;
  resetDataDir();
});

beforeEach(() => {
  process.env.NODE_ENV = "test";
});

describe("getAgentCvApiUrl", () => {
  it("defaults and strips trailing slashes", () => {
    delete process.env.AGENT_CV_API_URL;
    expect(getAgentCvApiUrl()).toBe("https://agent-cv.dev");
    process.env.AGENT_CV_API_URL = "https://custom.example/api/";
    expect(getAgentCvApiUrl()).toBe("https://custom.example/api");
  });
});

describe("ensureAuth", () => {
  it("returns jwt from authenticate when no stored token", async () => {
    const token = { jwt: "j", username: "u", obtainedAt: "t" };
    const r = await ensureAuth({
      required: true,
      authenticate: async () => token,
    });
    expect(r).toEqual({ kind: "jwt", token });
  });

  it("returns skipped when required false and authenticate fails", async () => {
    const r = await ensureAuth({
      required: false,
      authenticate: async () => {
        throw new Error("network");
      },
    });
    expect(r.kind).toBe("skipped");
  });

  it("returns error when required true and authenticate fails", async () => {
    const r = await ensureAuth({
      required: true,
      authenticate: async () => {
        throw new Error("network");
      },
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error.message).toBe("network");
  });

  it("maps AbortError to skipped when required false", async () => {
    const r = await ensureAuth({
      required: false,
      authenticate: async () => {
        const e = new Error("Aborted");
        e.name = "AbortError";
        throw e;
      },
    });
    expect(r.kind).toBe("skipped");
  });
});

describe("runDeviceFlowPoll", () => {
  it("retries on authorization_pending then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (url: string | URL) => {
      calls += 1;
      expect(String(url)).toContain("/api/trpc/auth.devicePoll");
      if (calls === 1) {
        return Promise.resolve(
          trpcBatchJsonResponse({ ok: false, error: "authorization_pending" })
        );
      }
      return Promise.resolve(
        trpcBatchJsonResponse({
          ok: true,
          jwt: "jwt",
          username: "user",
          avatarUrl: "https://a",
          githubToken: "gh",
        })
      );
    };

    const token = await runDeviceFlowPoll("device-code", 0);
    expect(token.jwt).toBe("jwt");
    expect(token.username).toBe("user");
    expect(calls).toBe(2);
  });

  it("respects AbortSignal", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runDeviceFlowPoll("x", 0, { signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

