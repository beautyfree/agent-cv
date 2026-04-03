/**
 * Core types for llm-cv.
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
  lastCommit?: string;
  markers: string[];
  size: { files: number; lines: number };
  analysis?: ProjectAnalysis;
  privacyAudit?: PrivacyAuditResult;
  tags: string[];
  included: boolean;
}

export interface ProjectAnalysis {
  summary: string;
  techStack: string[];
  contributions: string[];
  analyzedAt: string;
  analyzedBy: string;
}

export interface PrivacyAuditResult {
  secretsFound: number;
  excludedFiles: string[];
  auditedAt: string;
}

export interface Inventory {
  version: string;
  lastScan: string;
  scanPaths: string[];
  projects: Project[];
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
  recentCommits: string;
}

export interface OutputRenderer {
  name: string;
  render(inventory: Inventory, selectedIds: string[]): string;
}

export const INVENTORY_VERSION = "1.0";
