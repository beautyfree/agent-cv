import { buildCloudProjectContext } from "../analysis/cloud-context-builder.ts";
import { buildProjectContext } from "../analysis/context-builder.ts";
import { getCachedAnalysis, setCachedAnalysis } from "../analysis/cache.ts";
import { writeInventory } from "../inventory/store.ts";
import { PROMPT_VERSION } from "../types.ts";
import type { Project, Inventory, AgentAdapter } from "../types.ts";
import { GitHubClient } from "../discovery/github-client.ts";

/**
 * Transient error patterns that are worth retrying (rate limits, network, server errors).
 */
const TRANSIENT_PATTERNS = [
  "429",
  "rate limit",
  "timeout",
  "timed out",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "AbortError",
  "abort",
  "500",
  "502",
  "503",
  "504",
  "fetch failed",
  "network",
];

function isTransientError(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Analysis cancelled", "AbortError");
  }
}

/** Rejects when `signal` is aborted so in-flight work can be torn down with the Ink tree (e.g. Ctrl+C). */
function abortRace<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Analysis cancelled", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Analysis cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

/**
 * Retry a function with exponential backoff. Only retries transient errors.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelay?: number;
    onRetry?: (attempt: number, error: string) => void;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelay = 2000, onRetry, signal } = opts;

  const sleepWithAbort = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      throwIfAborted(signal);
      const id = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("Analysis cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (err: any) {
      if (signal?.aborted) throw err;
      const message = err.message || String(err);
      if (attempt === maxAttempts || !isTransientError(message)) {
        throw err;
      }
      const delay = baseDelay * Math.pow(2, attempt - 1);
      onRetry?.(attempt, message);
      await sleepWithAbort(delay);
    }
  }
  throw new Error("retryWithBackoff: unreachable");
}

/**
 * Step 4: Analyze projects with AI agent.
 */
export interface AnalysisResult {
  analyzed: number;
  failed: Array<{ project: Project; error: string }>;
  skipped: number;
  /** Wall-clock ms for the full analyzeProjects run (including inventory writes). */
  durationMs: number;
}

export type ProjectStatus = "queued" | "analyzing" | "done" | "failed" | "cached";

export async function analyzeProjects(
  projects: Project[],
  adapter: AgentAdapter,
  inventory: Inventory,
  options: {
    noCache?: boolean;
    dryRun?: boolean;
    onProgress?: (done: number, total: number, current: string) => void;
    onProjectStatus?: (projectId: string, status: ProjectStatus, detail?: string) => void;
    /** When aborted (e.g. Ink unmount on Ctrl+C), stops between projects and rejects in-flight adapter work. */
    signal?: AbortSignal;
    /** Override LLM concurrency. Defaults to AGENT_CV_CONCURRENCY env or 8. */
    concurrency?: number;
  } = {}
): Promise<AnalysisResult> {
  const analyzeStarted = Date.now();
  const { noCache = false, dryRun = false, onProgress, onProjectStatus, signal, concurrency } = options;

  const needsAnalysis = (p: Project) => {
    if (!p.analysis) return true;
    if (p.analysis.promptVersion !== PROMPT_VERSION) return true;
    if (p.lastCommit) {
      // Git project: re-analyze if new commits
      return p.analysis.analyzedAtCommit !== p.lastCommit;
    }
    // Non-git project: re-analyze if files changed (count or dates)
    const fingerprint = `files:${p.size?.files || 0}:${p.dateRange.end}`;
    return p.analysis.analyzedAtCommit !== fingerprint;
  };

  const toAnalyze = noCache ? projects : projects.filter(needsAnalysis);
  const cachedProjects = projects.filter((p) => !needsAnalysis(p));
  const skipped = cachedProjects.length;

  // Report cached projects
  for (const p of cachedProjects) {
    onProjectStatus?.(p.id, "cached");
  }
  // Report queued projects
  for (const p of toAnalyze) {
    onProjectStatus?.(p.id, "queued");
  }
  // Concurrency: option > AGENT_CV_CONCURRENCY env > 8 default.
  const BATCH_SIZE = (() => {
    if (concurrency && concurrency > 0) return concurrency;
    const env = Number(process.env.AGENT_CV_CONCURRENCY);
    return Number.isFinite(env) && env > 0 ? env : 8;
  })();
  const CIRCUIT_BREAKER_THRESHOLD = 3; // consecutive failures to trigger
  let completed = 0;
  let analyzedOk = 0;
  const failed: Array<{ project: Project; error: string }> = [];
  let consecutiveFailures = 0;
  let lastFailureMessage = "";
  let circuitBroken = false;

  throwIfAborted(signal);
  const cloudGhClient = toAnalyze.some((p) => p.source === "github") ? await GitHubClient.create() : undefined;

  for (let i = 0; i < toAnalyze.length; i += BATCH_SIZE) {
    throwIfAborted(signal);
    // Circuit breaker: if adapter is consistently failing, stop early
    if (circuitBroken) {
      const remaining = toAnalyze.slice(i);
      for (const project of remaining) {
        failed.push({ project, error: lastFailureMessage });
        onProjectStatus?.(project.id, "failed", `skipped: ${lastFailureMessage.slice(0, 40)}`);
      }
      completed += remaining.length;
      break;
    }

    const batch = toAnalyze.slice(i, i + BATCH_SIZE);
    onProgress?.(completed, toAnalyze.length, batch.map((p) => p.displayName).join(", "));

    if (dryRun) {
      for (const project of batch) {
        throwIfAborted(signal);
        const context = await buildProjectContext(project);
        const totalChars =
          context.readme.length +
          context.dependencies.length +
          context.directoryTree.length +
          context.gitShortlog.length +
          context.recentCommits.length;
        console.error(
          `\n--- DRY RUN: ${project.displayName} ---\nContext size: ~${Math.round(totalChars / 4)} tokens\n`
        );
      }
      completed += batch.length;
      continue;
    }

    let batchSuccesses = 0;
    await Promise.all(
      batch.map(async (project) => {
        onProjectStatus?.(project.id, "analyzing");
        try {
          let context;
          try {
            if (project.source === "github") {
              if (!cloudGhClient) {
                throw new Error("GitHub client not initialized for cloud project");
              }
              context = await buildCloudProjectContext(project, cloudGhClient);
            } else {
              context = await buildProjectContext(project);
            }
          } catch (ctxErr: any) {
            failed.push({ project, error: `context build failed: ${ctxErr.message}` });
            onProjectStatus?.(project.id, "failed", `context: ${ctxErr.message}`.slice(0, 60));
            return;
          }

          // Check the local content-hash cache first. Hits short-circuit
          // the LLM call entirely. Cache stays on disk; nothing leaves the box.
          let analysis = noCache ? null : await getCachedAnalysis(context, adapter.name, PROMPT_VERSION);
          let fromCache = !!analysis;

          if (!analysis) {
            analysis = await retryWithBackoff(() => abortRace(adapter.analyze(context), signal), {
              signal,
              onRetry: (attempt, error) => {
                onProjectStatus?.(project.id, "analyzing", `retry ${attempt + 1}/3... ${error.slice(0, 40)}`);
              },
            });
            // Cache the fresh result for next time.
            void setCachedAnalysis(context, adapter.name, PROMPT_VERSION, analysis);
          }

          // For git projects: last commit hash. For non-git: file fingerprint.
          analysis.analyzedAtCommit =
            project.lastCommit || `files:${project.size?.files || 0}:${project.dateRange.end}`;
          analysis.promptVersion = PROMPT_VERSION;
          project.analysis = analysis;
          analyzedOk++;
          batchSuccesses++;
          onProjectStatus?.(project.id, "done", (fromCache ? "[cached] " : "") + (analysis.summary?.slice(0, 60) ?? ""));
        } catch (err: any) {
          if (signal?.aborted) {
            throw err;
          }
          failed.push({ project, error: err.message });
          onProjectStatus?.(project.id, "failed", err.message.slice(0, 60));
          lastFailureMessage = err.message;
        }
      })
    );

    // Track consecutive batch failures for circuit breaker
    if (batchSuccesses === 0) {
      consecutiveFailures++;
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitBroken = true;
        onProgress?.(
          completed + batch.length,
          toAnalyze.length,
          `Agent broken — ${consecutiveFailures} batches failed: ${lastFailureMessage.slice(0, 60)}`
        );
      }
    } else {
      consecutiveFailures = 0;
    }

    completed += batch.length;
    onProgress?.(completed, toAnalyze.length, "");
    await writeInventory(inventory);
    throwIfAborted(signal);
  }

  const durationMs = Date.now() - analyzeStarted;
  return { analyzed: analyzedOk, failed, skipped, durationMs };
}

/**
 * Check how many projects need analysis.
 */
export function countUnanalyzed(projects: Project[]): number {
  return projects.filter((p) => p.included !== false && !p.analysis).length;
}
