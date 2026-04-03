# llm-cv

Generate a technical CV from your local project directories using AI.

Your real project history lives on your filesystem, not on GitHub. Pet projects that never got pushed, corporate work behind VPNs, weekend experiments in obscure frameworks. `llm-cv` scans your directories, delegates analysis to AI, and generates a structured CV that captures work you'd otherwise forget.

## Quick start

```bash
# Install
bun install -g llm-cv

# Scan your projects
llm-cv scan ~/Projects

# Generate a CV (interactive: pick emails, pick projects)
llm-cv generate ~/Projects --output cv.md

# See your tech evolution
llm-cv stats

# What changed since last scan
llm-cv diff ~/Projects
```

## How it works

```
llm-cv generate ~/Projects
  │
  ├── Scan: walks directories, detects projects by markers
  │   (package.json, Cargo.toml, go.mod, pyproject.toml, ...)
  │
  ├── Email picker: shows all git emails found, you confirm yours
  │   (saved for next time, supports multiple identities)
  │
  ├── Project selector: grouped by folder, searchable
  │   ★ = your commits, 💎 = forgotten gem, gray = not yours
  │
  ├── Analyze: each project sent to AI for description
  │   (Claude Code, Codex, OpenRouter, or any OpenAI-compatible API)
  │
  └── Render: structured markdown CV grouped by year
```

## Features

**Discovery**
- Detects 15+ project types (Node, Rust, Go, Python, Ruby, Java, Swift, Elixir, PHP, Docker...)
- Skips noise directories (node_modules, .git, dist, build, vendor, __pycache__)
- Nested project dedup (monorepo with sub-packages counted once)
- Parallel git operations (10 repos at a time)

**Identity**
- Multiple git email support (work, personal, old addresses)
- Auto-discovers emails from git config (global + per-repo)
- Interactive email picker with search on every run
- `--email` flag for generating someone else's CV

**Project selection**
- Grouped by directory with group-level toggle
- Instant search (just start typing)
- Pre-selects your projects, grays out forks/clones
- Detects uncommitted changes as sign of your work
- Forgotten gems: flags old projects with real work you probably forgot

**Analysis**
- Auto-detects available AI: Claude Code → Codex → API
- Claude Code gets full file access (richer analysis)
- API mode: OpenRouter, Anthropic, OpenAI, Ollama (any OpenAI-compatible endpoint)
- Privacy audit: .env files and hardcoded secrets excluded before AI sees anything
- `--dry-run` to preview what would be sent

**Output**
- Markdown CV grouped by year
- Duplicate project names disambiguated with parent path
- Persistent JSON inventory at `~/.llm-cv/inventory.json`
- Cached analysis survives between runs

## Commands

| Command | Description |
|---------|-------------|
| `llm-cv scan <dir>` | Discover projects, save to inventory |
| `llm-cv analyze <path>` | Analyze a single project with AI |
| `llm-cv generate <dir>` | Full flow: scan → pick emails → pick projects → analyze → CV |
| `llm-cv diff <dir>` | Show new/updated/removed projects since last scan |
| `llm-cv stats` | Tech evolution timeline, language breakdown, framework ranking |

## Flags

```
generate:
  --output <file>    Write to file instead of stdout
  --agent <name>     Force agent: claude, codex, api, auto (default: auto)
  --dry-run          Preview what would be sent to AI, no actual calls
  --no-cache         Force fresh analysis, ignore cached results
  --all              Skip project picker, include everything
  --email <emails>   Override emails (comma-separated), for someone else's CV

scan:
  --verbose          Show scan progress details
  --json             Output raw JSON
  --email <emails>   Additional emails to recognize as yours

analyze:
  --agent <name>     Force agent: claude, codex, api, auto
```

## AI setup

`llm-cv` auto-detects what you have. In priority order:

| Agent | How to set up |
|-------|--------------|
| Claude Code | [Install Claude Code](https://claude.ai/claude-code). Best results (reads files directly). |
| Codex CLI | `npm install -g @openai/codex` |
| OpenRouter | `export OPENROUTER_API_KEY=...` (one key, all models) |
| Anthropic | `export ANTHROPIC_API_KEY=...` |
| OpenAI | `export OPENAI_API_KEY=...` |
| Ollama | `export LLM_CV_BASE_URL=http://localhost:11434/v1` (no key needed) |

## Tech stack

Built with [Bun](https://bun.sh), [Ink](https://github.com/vadimdemedes/ink) (React for terminal), [Pastel](https://github.com/vadimdemedes/pastel) (file-based CLI routing), [Zod](https://zod.dev), and [simple-git](https://github.com/steveukx/git-js).

## License

MIT
