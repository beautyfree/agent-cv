# Changelog

## [0.1.0.0] - 2026-04-03 — First Light

Scan your local project directories, let AI understand what each project is, and generate a technical CV as a starting draft. The tool that captures the 80% of your work history that GitHub never sees.

### Added

- **`llm-cv scan <directory>`** — Discover projects by filesystem markers (package.json, Cargo.toml, go.mod, and 15 others). Extracts dates from git history, detects language and frameworks, identifies TypeScript/React/Express/Vue/Angular automatically. Skips node_modules, .git, dist, and other noise directories.
- **`llm-cv analyze <project-path>`** — Delegate project analysis to Claude Code via stdin piping (no shell history leak). Parses structured JSON response with summary, tech stack, and key contributions. Validates non-empty output, retries on malformed responses.
- **`llm-cv generate <directory>`** — Full flow: scan, select projects, analyze each with AI, render markdown CV. Supports `--dry-run` to preview what would be sent to the LLM without spending tokens. Supports `--output` for file output.
- **Privacy audit** — Before any LLM analysis, scans for .env files, API keys, private keys, and hardcoded secrets. Excluded files never reach the AI. Warning printed with count.
- **Persistent inventory** — Project data saved to `~/.llm-cv/inventory.json`. Re-runs pick up where they left off (cached analyses survive between sessions). Atomic writes via temp file + rename prevent corruption on Ctrl+C.
- **Nested project dedup** — Monorepos with multiple package.json files at different depths are detected once at the shallowest marker. No double-counting.
- **Plugin architecture** — AgentAdapter and OutputRenderer interfaces defined. Claude Code adapter and markdown renderer are the v0a implementations. Ready for Codex, API fallback, and JSON Resume renderers.
- **6 tests** covering scanner (happy path, empty dir, missing dir, multiple projects, Python detection, secrets detection).
