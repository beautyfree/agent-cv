import { defineSchema } from "bettersync";

/**
 * Shared sync schema for agent-cv.
 *
 * Models:
 *  - project:  one row per user project (CLI writes, web reads)
 *  - profile:  one row per user — identity + LLM-generated insights (CLI writes)
 *  - override: one row per user — web-side edits that win over `project`/`profile` at render
 *
 * All models scoped by userId (GitHub login).
 *
 * Local-only state (lastScan, scanPaths, lastAgent, emailsConfirmed) lives
 * outside sync — in `~/.agent-cv/state.json` on the CLI side.
 */
export const syncSchema = defineSchema({
  project: {
    fields: {
      id: { type: "string", primaryKey: true },
      userId: { type: "string" },

      path: { type: "string" },
      displayName: { type: "string" },
      suggestedName: { type: "string", required: false },

      type: { type: "string" },
      language: { type: "string" },
      frameworks: { type: "json" },
      markers: { type: "json" },

      dateRange: { type: "json" },
      size: { type: "json" },

      hasGit: { type: "boolean" },
      commitCount: { type: "number" },
      authorCommitCount: { type: "number" },
      hasUncommittedChanges: { type: "boolean" },
      lastCommit: { type: "string", required: false },

      description: { type: "string", required: false },
      topics: { type: "json", required: false },
      license: { type: "string", required: false },

      analysis: { type: "json", required: false },
      tags: { type: "json" },
      included: { type: "boolean" },

      remoteUrl: { type: "string", required: false },
      isPublic: { type: "boolean", required: false },
      stars: { type: "number", required: false },

      significance: { type: "number", required: false },
      tier: { type: "string", required: false },

      projectGroup: { type: "string", required: false },
      isOwner: { type: "boolean", required: false },
      isFork: { type: "boolean", required: false },
      githubParentFullName: { type: "string", required: false },
      upstreamPrCount: { type: "number", required: false },
      source: { type: "string", required: false },

      changed: { type: "string" },
    },
    scope: (ctx: { userId: string }) => ({ userId: ctx.userId }),
    clientCanCreate: true,
    clientCanUpdate: true,
    clientCanDelete: true,
  },

  profile: {
    fields: {
      userId: { type: "string", primaryKey: true },

      name: { type: "string", required: false },
      emailPublic: { type: "boolean", required: false },
      contactEmail: { type: "string", required: false },
      socials: { type: "json", required: false },
      avatarUrl: { type: "string", required: false },

      bio: { type: "string", required: false },
      narrative: { type: "string", required: false },
      strongestSkills: { type: "json", required: false },
      uniqueTraits: { type: "json", required: false },
      highlights: { type: "json", required: false },
      highlightsByYear: { type: "json", required: false },
      yearlyThemes: { type: "json", required: false },
      yearlyInsights: { type: "json", required: false },

      githubExtras: { type: "json", required: false },
      publishedPackages: { type: "json", required: false },

      changed: { type: "string" },
    },
    scope: (ctx: { userId: string }) => ({ userId: ctx.userId }),
    clientCanCreate: true,
    clientCanUpdate: true,
    clientCanDelete: false,
  },

  override: {
    fields: {
      userId: { type: "string", primaryKey: true },

      bio: { type: "string", required: false },
      headline: { type: "string", required: false },
      featuredProject: { type: "string", required: false },
      hiddenProjects: { type: "json", required: false },
      projectOrder: { type: "json", required: false },
      socialLinks: { type: "json", required: false },

      changed: { type: "string" },
    },
    scope: (ctx: { userId: string }) => ({ userId: ctx.userId }),
    clientCanCreate: true,
    clientCanUpdate: true,
    clientCanDelete: true,
  },
});

export type SyncContext = { userId: string };
