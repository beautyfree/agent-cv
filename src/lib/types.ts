/**
 * Core types for agent-cv.
 * These are framework-agnostic — no React/Ink imports here.
 */

export interface Project {
  id: string;
  path: string;
  displayName: string;
  suggestedName?: string;
  nameSource?: "directory" | "llm";
  type: string;
  language: string;
  frameworks: string[];
  dateRange: {
    start: string;
    end: string;
    approximate: boolean;
  };
  hasGit: boolean;
  commitCount: number;
  authorCommitCount: number;
  hasUncommittedChanges: boolean;
  lastCommit?: string;
  markers: string[];
  size: { files: number; lines: number };
  description?: string;
  topics?: string[];
  license?: string;
  analysis?: ProjectAnalysis;
  privacyAudit?: PrivacyAuditResult;
  tags: string[];
  included: boolean;
  remoteUrl?: string;
  isPublic?: boolean;
  stars?: number;
  authorEmail?: string;
}

export interface ProjectAnalysis {
  summary: string;
  techStack: string[];
  contributions: string[];
  analyzedAt: string;
  analyzedBy: string;
  /** Last commit hash or date when analysis was done. Used for cache invalidation. */
  analyzedAtCommit?: string;
  /** Hash of the prompt template used. If it changes, cached analysis is stale. */
  promptVersion?: string;
}

/**
 * Current prompt version. Bump this when the prompt template or
 * expected output schema changes. Cached analyses with a different
 * version will be re-analyzed.
 */
export const PROMPT_VERSION = "1";

export interface PrivacyAuditResult {
  secretsFound: number;
  excludedFiles: string[];
  auditedAt: string;
}

export interface Socials {
  github?: string;
  linkedin?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface ProfileInsights {
  bio?: string;
  highlights?: string[];
  narrative?: string;
  strongestSkills?: string[];
  uniqueTraits?: string[];
  /** MD5 hash of analyzed projects. Triggers regeneration when changed. */
  _fingerprint?: string;
}

export interface InventoryProfile {
  name?: string;
  emails: string[];
  emailsConfirmed: boolean;
  emailPublic?: boolean;
  socials?: Socials;
}

export interface Inventory {
  version: string;
  lastScan: string;
  scanPaths: string[];
  projects: Project[];
  profile: InventoryProfile;
  insights: ProfileInsights;
  /** Last used AI agent name (claude, codex, cursor, api) */
  lastAgent?: string;
}

export interface AgentAdapter {
  name: string;
  isAvailable(): Promise<boolean>;
  analyze(context: ProjectContext): Promise<ProjectAnalysis>;
}

export interface ProjectContext {
  path: string;
  readme: string;
  dependencies: string;
  directoryTree: string;
  gitShortlog: string;
  /** When set, adapters should use this as the full prompt without wrapping. */
  rawPrompt?: string;
  recentCommits: string;
  /** Previous analysis result, if this is a re-analysis */
  previousAnalysis?: ProjectAnalysis;
}

export interface OutputRenderer {
  name: string;
  render(inventory: Inventory, selectedIds: string[]): string;
}


export const INVENTORY_VERSION = "1.0";
