import { readFile, writeFile, rename, mkdir, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Inventory, Project } from "../types.ts";
import { INVENTORY_VERSION } from "../types.ts";

const DEFAULT_DIR = join(process.env.HOME || "~", ".llm-cv");
const INVENTORY_FILE = "inventory.json";

function getInventoryPath(): string {
  return join(DEFAULT_DIR, INVENTORY_FILE);
}

function emptyInventory(): Inventory {
  return {
    version: INVENTORY_VERSION,
    lastScan: new Date().toISOString(),
    scanPaths: [],
    projects: [],
  };
}

/**
 * Read the inventory from disk.
 * Returns empty inventory if file doesn't exist or is corrupted.
 */
export async function readInventory(): Promise<Inventory> {
  const path = getInventoryPath();

  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content);

    // Basic validation
    if (!parsed.version || !Array.isArray(parsed.projects)) {
      throw new Error("Invalid inventory structure");
    }

    return parsed as Inventory;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      // First run, no inventory yet
      return emptyInventory();
    }

    // Corrupted file — backup and start fresh
    console.error(
      `Warning: Inventory corrupted (${err.message}). Creating fresh inventory.`
    );
    try {
      const backupPath = path + ".backup." + Date.now();
      await copyFile(path, backupPath);
      console.error(`  Backup saved to: ${backupPath}`);
    } catch {
      // Can't backup, just continue
    }

    return emptyInventory();
  }
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
  const tmpPath = join(
    dir,
    `.inventory.tmp.${randomBytes(4).toString("hex")}`
  );

  try {
    const json = JSON.stringify(inventory, null, 2);
    await writeFile(tmpPath, json, "utf-8");
    await rename(tmpPath, path);
  } catch (err: any) {
    // Clean up temp file on failure
    try {
      const { unlink } = await import("node:fs/promises");
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
export function mergeInventory(
  existing: Inventory,
  scanned: Project[],
  scanPath: string
): Inventory {
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
      });
      scannedById.delete(project.id);
    } else {
      // Project was in inventory but not in scan
      // Only remove if it was from this scan path
      if (project.path.startsWith(scanPath)) {
        // Mark as removed (don't delete, user might want to see it)
        merged.push({ ...project, tags: [...project.tags, "removed"] });
      } else {
        merged.push(project);
      }
    }
  }

  // Add new projects
  for (const project of scannedById.values()) {
    merged.push(project);
  }

  return {
    version: INVENTORY_VERSION,
    lastScan: new Date().toISOString(),
    scanPaths: [...new Set([...existing.scanPaths, scanPath])],
    projects: merged,
  };
}
