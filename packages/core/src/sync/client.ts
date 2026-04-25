import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createSyncClient, type SyncClient } from "bettersync/client";
import { pgliteAdapter } from "bettersync/adapters/pglite";
import { syncSchema, type SyncContext } from "@agent-cv/sync-schema";
import { getDataDir } from "../data-dir.ts";
import { readAuthToken } from "../auth/index.ts";

const DEFAULT_API_URL = "https://agent-cv.dev";

function syncUrl(): string {
  const base = process.env.AGENT_CV_API_URL ?? DEFAULT_API_URL;
  return `${base.replace(/\/$/, "")}/api/sync`;
}

let _client: SyncClient<SyncContext> | null = null;
let _pg: PGlite | null = null;

/**
 * Returns a lazily-initialized, shared SyncClient.
 * Backing store: PGlite persisted to `~/.agent-cv/pglite-data/`.
 */
export async function getSyncClient(): Promise<SyncClient<SyncContext>> {
  if (_client) return _client;

  const dataDir = join(getDataDir(), "pglite-data");
  mkdirSync(dataDir, { recursive: true });

  _pg = new PGlite(dataDir);
  const adapter = pgliteAdapter(_pg, { hlcField: "changed" });

  _client = createSyncClient<SyncContext>({
    database: adapter,
    schema: syncSchema,
    syncUrl: syncUrl(),
    headers: async (): Promise<Record<string, string>> => {
      const auth = await readAuthToken();
      return auth?.jwt ? { Authorization: `Bearer ${auth.jwt}` } : {};
    },
    hlcField: "changed",
  });

  await _client.start();
  return _client;
}

/** Manually trigger a sync round-trip. */
export async function syncNow() {
  const client = await getSyncClient();
  return client.syncNow();
}

/** Stop polling and close the underlying PGlite instance. */
export async function closeSyncClient(): Promise<void> {
  _client?.stop();
  _client = null;
  if (_pg) {
    await _pg.close();
    _pg = null;
  }
}
