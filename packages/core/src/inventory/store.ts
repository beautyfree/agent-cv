import { readFile, writeFile, rename, mkdir, copyFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Inventory, Project, InventoryProfile, ProfileInsights } from "../types.ts";
import { INVENTORY_VERSION } from "../types.ts";
import { normalizeGitUrl } from "../discovery/git-metadata.ts";
import { getDataDir } from "../data-dir.ts";
import { parseInventoryJson } from "./inventory-schema.ts";
import { ZodError } from "zod";

const INVENTORY_FILE = "inventory.json";
const OLD_CONFIG_FILE = "config.json";

function getBaseDir(): string {
  return getDataDir();
}

function getInventoryPath(): string {
  return join(getBaseDir(), INVENTORY_FILE);
}

function defaultProfile(): InventoryProfile {
  return { emails: [], emailsConfirmed: false, emailPublic: false };
}

function emptyInventory(): Inventory {
  return {
    version: INVENTORY_VERSION,
    lastScan: new Date().toISOString(),
    scanPaths: [],
    projects: [],
    profile: defaultProfile(),
    insights: {},
  };
}

/**
 * Base inventory for a --fresh scan: no projects or prior insights, but keep profile from disk
 * (name, emails) so a rescan does not reset identity. Merge then behaves like a first run for
 * this tree without reusing analysis or other paths' projects.
 */
export async function readInventoryForFreshScan(): Promise<Inventory> {
  const disk = await readInventory();
  return {
    ...emptyInventory(),
    profile: { ...disk.profile },
  };
}

/**
 * Migrate old config.json into inventory if it exists.
 */
async function migrateOldConfig(inventory: Inventory): Promise<boolean> {
  const configPath = join(getBaseDir(), OLD_CONFIG_FILE);
  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content);

    // Merge profile fields
    inventory.profile = {
      name: config.name || inventory.profile.name,
      emails: config.emails || inventory.profile.emails,
      emailsConfirmed: config.emailsConfirmed ?? inventory.profile.emailsConfirmed,
      emailPublic: config.emailPublic ?? inventory.profile.emailPublic,
      socials: config.socials || inventory.profile.socials,
    };

    // Merge insights
    inventory.insights = {
      bio: config.bio || inventory.insights.bio,
      highlights: config.highlights || inventory.insights.highlights,
      narrative: config.narrative || inventory.insights.narrative,
      strongestSkills: config.strongestSkills || inventory.insights.strongestSkills,
      uniqueTraits: config.uniqueTraits || inventory.insights.uniqueTraits,
    };

    // Remove old config file
    await unlink(configPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the inventory from disk.
 * Returns empty inventory if file doesn't exist or is corrupted.
 * On first run, migrates old config.json if present.
 */
export async function readInventory(): Promise<Inventory> {
  const path = getInventoryPath();

  let inventory: Inventory;

  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content) as unknown;

    // Ensure new fields exist (upgrade from older inventory format) before Zod
    const raw = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    if (raw) {
      if (!raw.profile) raw.profile = defaultProfile();
      if (!raw.insights) raw.insights = {};
    }

    inventory = parseInventoryJson(raw ?? parsed);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      inventory = emptyInventory();
    } else if (err instanceof ZodError) {
      console.error(`Warning: Inventory failed validation (${err.message}). Creating fresh inventory.`);
      try {
        const backupPath = path + ".backup." + Date.now();
        await copyFile(path, backupPath);
        console.error(`  Backup saved to: ${backupPath}`);
      } catch {
        // Can't backup, just continue
      }
      inventory = emptyInventory();
    } else {
      console.error(`Warning: Inventory corrupted (${err.message}). Creating fresh inventory.`);
      try {
        const backupPath = path + ".backup." + Date.now();
        await copyFile(path, backupPath);
        console.error(`  Backup saved to: ${backupPath}`);
      } catch {
        // Can't backup, just continue
      }
      inventory = emptyInventory();
    }
  }

  // Migrate old config.json if it exists
  const migrated = await migrateOldConfig(inventory);

  // Auto-detect name from git config if not set
  if (!inventory.profile.name) {
    try {
      const { execSync } = await import("node:child_process");
      const gitName = execSync("git config --global user.name", { encoding: "utf-8" }).trim();
      if (gitName) {
        inventory.profile.name = gitName;
      }
    } catch {
      /* git not available or no name configured */
    }
  }

  if (migrated || !inventory.profile.name) {
    await writeInventory(inventory);
  }

  return inventory;
}

/**
 * Write inventory to disk using atomic write (temp file + rename).
 * Prevents corruption on crash or Ctrl+C.
 */
export async function writeInventory(inventory: Inventory): Promise<void> {
  const path = getInventoryPath();
  const dir = dirname(path);

  // Ensure directory exists
  await mkdir(dir, { recursive: true });

  // Atomic write: write to temp file, then rename
  const tmpPath = join(dir, `.inventory.tmp.${randomBytes(4).toString("hex")}`);

  try {
    const json = JSON.stringify(inventory, null, 2);
    await writeFile(tmpPath, json, "utf-8");
    await rename(tmpPath, path);
  } catch (err: any) {
    // Clean up temp file on failure
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }

    if (err.code === "ENOSPC") {
      console.error("Warning: Disk full. Inventory not saved.");
      return;
    }
    throw err;
  }
}

/**
 * Merge freshly scanned projects into existing inventory.
 * - New projects are added
 * - Existing projects have metadata updated (but keep analysis if path unchanged)
 * - Missing projects are marked as removed
 */
export function mergeInventory(existing: Inventory, scanned: Project[], scanPath: string): Inventory {
  const scannedById = new Map(scanned.map((p) => [p.id, p]));
  const existingById = new Map(existing.projects.map((p) => [p.id, p]));

  const merged: Project[] = [];

  // Update or keep existing projects
  for (const project of existing.projects) {
    const updated = scannedById.get(project.id);
    if (updated) {
      // Project still exists — update metadata, preserve analysis
      merged.push({
        ...updated,
        analysis: project.analysis, // keep cached analysis
        privacyAudit: updated.privacyAudit, // use fresh audit
        tags: project.tags, // keep user tags
        included: project.included, // keep user selection
        significance: project.significance, // keep score
        tier: project.tier, // keep tier
        stars: project.stars, // keep GitHub data until enrich refreshes
        isPublic: project.isPublic,
        isFork: project.isFork,
        githubParentFullName: project.githubParentFullName ?? updated.githubParentFullName,
        upstreamPrCount: project.upstreamPrCount ?? updated.upstreamPrCount,
        projectGroup: updated.projectGroup, // from fresh scan (path-based)
      });
      scannedById.delete(project.id);
    } else {
      // Project was in inventory but not in scan
      // Cloud projects (source !== "local") are never removed by local scan path checks
      if (project.source && project.source !== "local") {
        merged.push(project);
      } else if (project.path.startsWith(scanPath)) {
        // Mark as removed (don't delete, user might want to see it)
        merged.push({ ...project, tags: [...project.tags, "removed"] });
      } else {
        merged.push(project);
      }
    }
  }

  // Add new projects (tag as "new" if this isn't the first scan)
  const isFirstScan = existing.projects.length === 0;
  for (const project of scannedById.values()) {
    if (!isFirstScan && !project.tags.includes("new")) {
      project.tags.push("new");
    }
    merged.push(project);
  }

  return {
    version: INVENTORY_VERSION,
    lastScan: new Date().toISOString(),
    scanPaths: [...new Set([...existing.scanPaths, scanPath])],
    projects: merged,
    profile: existing.profile || defaultProfile(),
    insights: existing.insights || {},
    lastAgent: existing.lastAgent,
    githubExtras: existing.githubExtras,
    publishedPackages: existing.publishedPackages,
  };
}

/**
 * Merge cloud-scanned projects into existing inventory.
 * Dedup via normalized remoteUrl: if a local project has the same remote,
 * merge (prefer local data, supplement with cloud metadata).
 * Cloud-only projects are added as new entries.
 */
export function mergeCloudProjects(inventory: Inventory, cloudProjects: Project[]): Inventory {
  // Build a map of normalized remoteUrl → existing project for dedup
  const localByRemote = new Map<string, Project>();
  for (const p of inventory.projects) {
    if (p.remoteUrl) {
      const normalized = normalizeGitUrl(p.remoteUrl).toLowerCase();
      localByRemote.set(normalized, p);
    }
  }

  const updatedProjects = [...inventory.projects];

  for (const cloud of cloudProjects) {
    if (!cloud.remoteUrl) {
      updatedProjects.push(cloud);
      continue;
    }

    const normalizedUrl = normalizeGitUrl(cloud.remoteUrl).toLowerCase();
    const existing = localByRemote.get(normalizedUrl);

    if (existing) {
      // Dedup: local project exists with same remote. Merge cloud metadata.
      existing.stars = cloud.stars ?? existing.stars;
      existing.isPublic = cloud.isPublic ?? existing.isPublic;
      existing.isFork = cloud.isFork ?? existing.isFork;
      existing.githubParentFullName = cloud.githubParentFullName ?? existing.githubParentFullName;
      existing.upstreamPrCount = cloud.upstreamPrCount ?? existing.upstreamPrCount;
      existing.description = existing.description || cloud.description;
      existing.topics = existing.topics || cloud.topics;
      // Don't overwrite local analysis, path, source, etc.
    } else {
      // Cloud-only project: add it
      updatedProjects.push(cloud);
    }
  }

  return {
    ...inventory,
    projects: updatedProjects,
  };
}
