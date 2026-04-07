import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { getDataDir } from "./data-dir.ts";
import { readCredentials, writeCredentials } from "./credentials.ts";

function getConfigDir(): string {
  return getDataDir();
}

function getAuthFile(): string {
  return join(getConfigDir(), "auth.json");
}

const API_URL = process.env.AGENT_CV_API_URL || "https://agent-cv.dev";
const GITHUB_CLIENT_ID = "Ov23liErP4pFLMnM3e1J";

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

  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: data.interval || 5,
  };
}

/**
 * Poll our server to exchange device_code for JWT.
 * Server handles the client_secret exchange with GitHub.
 */
export async function pollForToken(deviceCode: string): Promise<AuthToken> {
  const res = await fetch(`${API_URL}/api/auth/device-poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });

  const data = await res.json();

  if (data.error === "authorization_pending") {
    throw new PendingError();
  }
  if (data.error === "slow_down") {
    throw new SlowDownError();
  }
  if (data.error) {
    throw new Error(data.error);
  }

  const token: AuthToken = {
    jwt: data.jwt,
    username: data.username,
    obtainedAt: new Date().toISOString(),
  };

  await writeAuthToken(token);

  // Save GitHub token from device flow for API scanning
  if (data.githubToken) {
    const creds = await readCredentials();
    creds.githubToken = data.githubToken;
    await writeCredentials(creds);
  }

  return token;
}

export class PendingError extends Error {
  constructor() { super("authorization_pending"); }
}

export class SlowDownError extends Error {
  constructor() { super("slow_down"); }
}

/**
 * Publish inventory to the API.
 */
export async function publishToApi(
  jwt: string,
  payload: unknown
): Promise<{ url: string; username: string }> {
  const res = await fetch(`${API_URL}/api/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 401) {
    throw new Error("AUTH_EXPIRED");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Unknown error" }));
    let msg = err.error || `HTTP ${res.status}`;
    if (err.details?.length) {
      msg += ": " + err.details.map((d: any) => `${d.path} ${d.message}`).join(", ");
    }
    throw new Error(msg);
  }

  return res.json();
}
