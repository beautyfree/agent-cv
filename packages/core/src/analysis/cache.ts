/**
 * Local content-hashed cache for LLM analysis.
 *
 * Stays exclusively on the device — nothing syncs, nothing leaves the
 * machine. Cache key = sha256 of (adapter + promptVersion + canonical
 * context). When the same project hasn't changed, re-publish becomes
 * a disk read instead of an LLM round-trip.
 *
 * Files live at:
 *   $AGENT_CV_DATA_DIR/llm-cache/<first-2-chars>/<hash>.json
 *
 * TTL: 30 days. Stale entries are deleted on read.
 *
 *   ┌────────────────┐    sha256       ┌─────────────┐
 *   │ ProjectContext │  ───────────▶   │ cache key   │
 *   │ + adapter      │                 │             │
 *   │ + promptVersion│                 └──────┬──────┘
 *   └────────────────┘                        │
 *                                             ▼
 *                                  ┌─────────────────────┐
 *                                  │ ~/.agent-cv/        │
 *                                  │  llm-cache/ab/abcd…│
 *                                  └─────────────────────┘
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../data-dir.ts";
import type { ProjectAnalysis } from "../types.ts";
import type { ProjectContext } from "../types.ts";

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface CacheEntry {
  result: ProjectAnalysis;
  storedAt: number;
}

/** Build the canonical input string the hash is computed from. */
function canonicalKey(
  context: ProjectContext,
  adapter: string,
  promptVersion: string
): string {
  // Only include fields that actually affect the LLM output. Skip path /
  // displayName so two clones of the same repo hit the same cache entry.
  const parts = [
    `adapter:${adapter}`,
    `prompt:${promptVersion}`,
    `readme:${context.readme}`,
    `deps:${context.dependencies}`,
    `tree:${context.directoryTree}`,
    `shortlog:${context.gitShortlog}`,
    `commits:${context.recentCommits}`,
    `prev:${JSON.stringify(context.previousAnalysis ?? null)}`,
    `owner:${context.isOwner ?? false}`,
    `authorCommits:${context.authorCommitCount ?? 0}`,
    `commits#:${context.commitCount ?? 0}`,
  ];
  return parts.join("\n");
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function pathFor(hash: string): string {
  return join(getDataDir(), "llm-cache", hash.slice(0, 2), `${hash}.json`);
}

/** Look up a cached analysis. Returns null on miss / stale / read error. */
export async function getCachedAnalysis(
  context: ProjectContext,
  adapter: string,
  promptVersion: string
): Promise<ProjectAnalysis | null> {
  if (process.env.AGENT_CV_NO_CACHE === "1") return null;

  const hash = hashKey(canonicalKey(context, adapter, promptVersion));
  const file = pathFor(hash);

  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return null;
  }

  let entry: CacheEntry;
  try {
    entry = JSON.parse(raw);
  } catch {
    // Corrupt entry — drop it.
    void unlink(file).catch(() => {});
    return null;
  }

  if (!entry?.result || typeof entry.storedAt !== "number") return null;
  if (Date.now() - entry.storedAt > TTL_MS) {
    void unlink(file).catch(() => {});
    return null;
  }

  return entry.result;
}

/** Persist an analysis under its content hash. Best-effort; never throws. */
export async function setCachedAnalysis(
  context: ProjectContext,
  adapter: string,
  promptVersion: string,
  result: ProjectAnalysis
): Promise<void> {
  if (process.env.AGENT_CV_NO_CACHE === "1") return;

  const hash = hashKey(canonicalKey(context, adapter, promptVersion));
  const file = pathFor(hash);
  const entry: CacheEntry = { result, storedAt: Date.now() };

  try {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(entry), "utf-8");
  } catch {
    // Cache write is best-effort; never fail an analysis because we
    // couldn't write to disk.
  }
}
