import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const CONFIG_DIR = join(process.env.HOME || "~", ".agent-cv");
const AUTH_FILE = join(CONFIG_DIR, "auth.json");

const API_URL = "https://agent-cv.dev";
const GITHUB_CLIENT_ID = "Ov23liErP4pFLMnM3e1J";

export interface AuthToken {
  jwt: string;
  username: string;
  obtainedAt: string;
}

export async function readAuthToken(): Promise<AuthToken | null> {
  try {
    const content = await readFile(AUTH_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function writeAuthToken(token: AuthToken): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const tmpPath = join(CONFIG_DIR, `.auth.tmp.${randomBytes(4).toString("hex")}`);
  await writeFile(tmpPath, JSON.stringify(token, null, 2), "utf-8");
  await rename(tmpPath, AUTH_FILE);
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
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
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
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}
