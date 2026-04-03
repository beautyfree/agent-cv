import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrivacyAuditResult } from "../types.ts";

/**
 * Files that likely contain secrets.
 */
const SECRET_FILE_PATTERNS = [
  /^\.env$/,
  /^\.env\..+$/,
  /^credentials\.json$/,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /\.p12$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
];

/**
 * Patterns in source code that suggest hardcoded secrets.
 */
const SECRET_CONTENT_PATTERNS = [
  /API_KEY\s*[=:]/,
  /SECRET\s*[=:]/,
  /PASSWORD\s*[=:]/,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /glpat-[A-Za-z0-9\-]{20}/,
  /PRIVATE.KEY/,
];

/**
 * File extensions to check for secret patterns in source code.
 */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".js",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".yaml",
  ".yml",
  ".toml",
  ".cfg",
  ".ini",
  ".conf",
  ".json",
  ".sh",
]);

/**
 * Scan a project directory for potential secrets.
 * Returns list of files that should be excluded from LLM context.
 */
export async function scanForSecrets(dir: string): Promise<PrivacyAuditResult> {
  const excludedFiles: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      // Check filename patterns
      const isSecretFile = SECRET_FILE_PATTERNS.some((p) =>
        p.test(entry.name)
      );
      if (isSecretFile) {
        excludedFiles.push(entry.name);
        continue;
      }

      // Check source file contents for hardcoded secrets (top-level only)
      const ext = "." + entry.name.split(".").pop();
      if (SOURCE_EXTENSIONS.has(ext)) {
        try {
          const content = await readFile(join(dir, entry.name), "utf-8");
          // Only check first 5KB to keep it fast
          const snippet = content.slice(0, 5000);
          const hasSecret = SECRET_CONTENT_PATTERNS.some((p) =>
            p.test(snippet)
          );
          if (hasSecret) {
            excludedFiles.push(entry.name);
          }
        } catch {
          // Can't read file, skip
        }
      }
    }
  } catch {
    // Can't read directory, return empty result
  }

  return {
    secretsFound: excludedFiles.length,
    excludedFiles,
    auditedAt: new Date().toISOString(),
  };
}
