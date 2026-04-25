import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { getDataDir } from "../data-dir.ts";
import { readCredentials, writeCredentials } from "./credentials.ts";
import { createAgentCvTrpcClient, TRPCClientError } from "./trpc-client.ts";
import { isTrpcUnauthorized } from "./trpc-errors.ts";

function getConfigDir(): string {
  return getDataDir();
}

function getAuthFile(): string {
  return join(getConfigDir(), "auth.json");
}

const GITHUB_CLIENT_ID = "Ov23liErP4pFLMnM3e1J";

/** Base URL for agent-cv HTTP API (publish, auth device-poll, unpublish). No trailing slash. */
export function getAgentCvApiUrl(): string {
  const raw = (process.env.AGENT_CV_API_URL ?? "").trim() || "https://agent-cv.dev";
  return raw.replace(/\/+$/, "");
}

export interface AuthToken {
  jwt: string;
  username: string;
  obtainedAt: string;
}

export async function readAuthToken(): Promise<AuthToken | null> {
  try {
    const content = await readFile(getAuthFile(), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function writeAuthToken(token: AuthToken): Promise<void> {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.auth.tmp.${randomBytes(4).toString("hex")}`);
  await writeFile(tmpPath, JSON.stringify(token, null, 2), "utf-8");
  await rename(tmpPath, getAuthFile());
}

/**
 * Start GitHub device flow. Returns device_code and user_code for display.
 */
export async function startDeviceFlow(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "read:user,repo" }),
  });

  const data = (await res.json()) as {
    error?: string;
    error_description?: string;
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    interval?: number;
  };
  if (data.error) throw new Error(data.error_description || data.error);

  return {
    deviceCode: data.device_code ?? "",
    userCode: data.user_code ?? "",
    verificationUri: data.verification_uri ?? "",
    interval: data.interval || 5,
  };
}

/**
 * Poll our server once to exchange device_code for JWT (tRPC auth.devicePoll).
 * Server handles the client_secret exchange with GitHub.
 */
export async function pollForToken(deviceCode: string): Promise<AuthToken> {
  const client = createAgentCvTrpcClient();

  let result: Awaited<
    ReturnType<typeof client.auth.devicePoll.mutate>
  >;
  try {
    result = await client.auth.devicePoll.mutate({ device_code: deviceCode });
  } catch (e) {
    if (e instanceof TRPCClientError) {
      throw new Error(e.message || "Auth request failed");
    }
    throw e;
  }

  if (!result.ok) {
    if (result.error === "authorization_pending") {
      throw new PendingError();
    }
    if (result.error === "slow_down") {
      throw new SlowDownError();
    }
    throw new Error(result.error);
  }

  const token: AuthToken = {
    jwt: result.jwt,
    username: result.username,
    obtainedAt: new Date().toISOString(),
  };

  await writeAuthToken(token);

  if (result.githubToken) {
    const creds = await readCredentials();
    creds.githubToken = result.githubToken;
    await writeCredentials(creds);
  }

  return token;
}

export class PendingError extends Error {
  constructor() {
    super("authorization_pending");
  }
}

export class SlowDownError extends Error {
  constructor() {
    super("slow_down");
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

/**
 * Repeatedly poll until GitHub authorization completes or an error is thrown.
 * Handles PendingError / SlowDownError backoff like the CLI used to inline.
 */
export async function runDeviceFlowPoll(
  deviceCode: string,
  initialIntervalSec: number,
  options?: { signal?: AbortSignal }
): Promise<AuthToken> {
  let interval = initialIntervalSec;
  const signal = options?.signal;
  while (true) {
    await sleep(interval * 1000, signal);
    try {
      return await pollForToken(deviceCode);
    } catch (e) {
      if (e instanceof PendingError) continue;
      if (e instanceof SlowDownError) {
        interval += 2;
        continue;
      }
      throw e;
    }
  }
}

/**
 * Start device flow, optionally open the verification URI, then poll until success.
 */
export async function runFullDeviceAuthentication(
  openVerificationUri: (uri: string) => void | Promise<void>,
  options?: { signal?: AbortSignal }
): Promise<AuthToken> {
  const flow = await startDeviceFlow();
  await openVerificationUri(flow.verificationUri);
  return runDeviceFlowPoll(flow.deviceCode, flow.interval, options);
}

export type EnsureAuthResult =
  | { kind: "jwt"; token: AuthToken }
  | { kind: "skipped" }
  | { kind: "error"; error: Error };

/**
 * If a JWT is already on disk, return it. Otherwise run `authenticate()` (e.g. device flow).
 * When `required` is false, authentication failure yields `skipped` instead of `error`.
 */
export async function ensureAuth(options: {
  required: boolean;
  authenticate: () => Promise<AuthToken>;
}): Promise<EnsureAuthResult> {
  const existing = await readAuthToken();
  if (existing?.jwt) {
    return { kind: "jwt", token: existing };
  }
  try {
    const token = await options.authenticate();
    return { kind: "jwt", token };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (err.name === "AbortError") {
      if (!options.required) return { kind: "skipped" };
      return { kind: "error", error: err };
    }
    if (!options.required) {
      return { kind: "skipped" };
    }
    return { kind: "error", error: err };
  }
}

