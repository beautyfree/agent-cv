# Architecture

## Pipeline Flow

```
agent-cv generate ~/Projects
  │
  ├─ Telemetry notice (first run only, non-blocking)
  │
  ├─ Scan: walk directories, detect projects by markers
  │  (package.json, Cargo.toml, go.mod, pyproject.toml, ...)
  │  Progress: "Found 150/357 projects — orgs/beautyfree/publora"
  │
  ├─ Email picker: show all git emails, user confirms theirs
  │  Skipped if emails already confirmed from previous run
  │  Saved to inventory.profile.emails
  │
  ├─ Recount: authorCommitCount per project using confirmed emails
  │  Tags "forgotten-gem" on old projects with real work
  │
  ├─ Project selector: grouped tree view with tiers
  │  Persisted: included=true/false saved to inventory
  │  New projects tagged "new" on subsequent scans
  │
  ├─ Agent picker: Claude Code / Codex / Cursor / API
  │  Saved: inventory.lastAgent for next run default
  │
  ├─ Analyze: batch of 3, per-project LLM call
  │  Returns: summary, techStack, contributions, impactScore
  │  Cache: analyzedAtCommit + promptVersion based invalidation
  │
  ├─ GitHub enrich: stars + isPublic from GitHub API
  │  Batches of 10, same API call for both fields
  │
  ├─ Significance scoring + tier assignment (per year)
  │
  ├─ Profile insights (2 LLM calls):
  │  1. Yearly themes: what the developer focused on each year
  │  2. Final profile: bio, highlights, narrative, skills, traits
  │  Fingerprinted: regenerates only when analyzed projects change
  │
  └─ Render / Publish
```

## Data Model

Everything lives in one file: `~/.agent-cv/inventory.json`

```
Inventory
├── version: "1.0"
├── lastScan: ISO timestamp
├── scanPaths: string[]
├── lastAgent: "claude" | "codex" | "cursor" | "api"
├── profile
│   ├── name, emails, emailsConfirmed, emailPublic
│   └── socials: { github, linkedin, twitter, telegram, website }
├── insights
│   ├── bio, highlights[], narrative
│   ├── strongestSkills[], uniqueTraits[]
│   ├── yearlyThemes[]: { year, focus, topProjects[] }
│   └── _fingerprint: MD5 for cache invalidation
└── projects[]: Project
    ├── id, path, displayName, type, language, frameworks
    ├── dateRange: { start, end, approximate }
    ├── hasGit, commitCount, authorCommitCount
    ├── hasUncommittedChanges, lastCommit
    ├── size: { files, lines }
    ├── remoteUrl, isPublic, stars
    ├── significance, tier: "primary" | "secondary" | "minor"
    ├── analysis?: { summary, techStack, contributions, impactScore }
    ├── tags: string[] ("removed", "forgotten-gem", "new")
    └── included: boolean
```

## Significance Score

Projects are scored to determine visibility tier on the portfolio page.
Tiers are assigned per year, not globally.

```
Signal              Weight        Source
─────────────────────────────────────────────────
LLM impactScore     5-50 pts     CTO assessment (1-10 × 5)
Author commits      0.5/ea       Git history, capped at 50 pts
GitHub stars        10/ea         GitHub API
Code size           1-5 pts      <500=0, <3K=1, <10K=3, 10K+=5
Duration            1-5 pts      <1mo=0, <3mo=1, <12mo=3, 12mo+=5
Main author         +5 pts       >50% of commits
Tech diversity      1-3 pts      techStack + frameworks count
Active project      +2 pts       hasUncommittedChanges
Clone penalty       ×0.1         0 author commits, no uncommitted

Per-year tiers:
  primary    top 20%    Full expandable card
  secondary  next 30%   Compact row, click to expand
  minor      rest       Hidden behind "+ N more", 50% opacity
```

## Date Detection

```
Situation                    start                  end              approximate
─────────────────────────────────────────────────────────────────────────────
My commits exist             first author commit    last author      false
Clone, 0 my commits          .git/HEAD birthtime    last commit      true
git init, 0 commits          min file birthtime     max file mtime   true
No git                       min file birthtime     max file mtime   true
```

## Profile Insights (2-step generation)

```
Step 1: Yearly Themes
  Input:  projects grouped by year, primary/secondary only
  Output: [{ year, focus, topProjects[] }]
  Example: "2023: shifted from Web3 to AI tooling"

Step 2: Final Profile
  Input:  top 50 projects by significance + yearly themes
  Output: { bio, highlights, narrative, strongestSkills, uniqueTraits }
  
  Regeneration trigger: MD5 fingerprint of (project.id + analyzedAt)
  changes when projects are added, removed, or re-analyzed
```

## Adapter Architecture

```
AgentAdapter interface
├── claude:  claude -p --output-format json (stdin pipe, cwd=project)
├── codex:   codex exec <prompt> -C <path> -s read-only
├── cursor:  agent --trust -p <prompt> (cwd=project)
└── api:     OpenAI-compatible HTTP (OpenRouter, Anthropic, Ollama)

rawPrompt mode: when context.rawPrompt is set, adapters bypass
their buildPrompt template and pass the prompt directly to LLM.
Used for profile insights generation (not project analysis).
cwd is undefined in rawPrompt mode to prevent agents reading files.
```

## Web Architecture

```
CLI publishes to:  POST /api/publish on agent-cv.dev
  ├── inventory → data.json (projects with tiers, stars, analysis)
  ├── profile  → profile.json (bio, skills, yearlyThemes)
  └── meta     → meta.json (username, avatar, timestamps)

Page rendering:
  inventory + overrides + profile → applyOverrides() → MergedPortfolio
  
  Tier display:
    primary   → ProjectRow (full card, expandable on hover/tap)
    secondary → ExpandableCompactRow (one-line, click to expand)
    minor     → hidden behind "+ N more", 50% opacity, sticky collapse
```
