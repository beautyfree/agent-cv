# CLI reference

Command-line flags and AI setup for **agent-cv**. For product overview, quick start, and the command cheat sheet, see [README.md](../README.md).

## Flags by command

### `generate`

| Flag | Purpose |
|------|---------|
| `--output <file>` | Write markdown to a file instead of stdout. |
| `--agent <name>` | `auto` (default), `claude`, `codex`, `cursor`, `api`. |
| `--dry-run` | Show what would be sent to the model without sending. |
| `--no-cache` | Ignore cached analysis. |
| `--all` | Skip project picker; include everything. |
| `--email <emails>` | Comma-separated emails to attribute work (e.g. another person’s tree). |
| `--github <user>` | Enrich with GitHub repos for that user (`GITHUB_TOKEN` or saved `credentials.githubToken`). |
| `--include-forks` | Include forked repos in the GitHub pass. |
| `-i, --interactive` | Force pickers even when saved choices exist. |
| `--fresh` | Scan as if the first time: do not merge into saved projects (name/emails from profile are kept). |
| `-y, --yes` | When you are already logged in, auto-accept the publish offer after generate. |

**Argument:** `[directory]` — folder to scan; if omitted, known paths from inventory are reused where applicable.

### `publish`

| Flag | Purpose |
|------|---------|
| `--all`, `--agent`, `--email`, `--github`, `--include-forks` | Same meanings as in `generate`. |
| `-i, --interactive` | Force pickers (emails, projects, agent) even when data would otherwise skip them. |
| `--fresh` | Full rescan: merge this run without old projects/analysis (profile kept). Without `[directory]`, reuses the last saved scan path (same as `generate`). |
| `-y, --yes` | Skip confirmation prompt. |

**Argument:** `[directory]` — optional. Without it, `publish` normally loads the saved inventory only; with `--fresh`, a full pipeline runs (path from `[directory]`, or last scan path, or error if none).

### `diff`

| Item | Notes |
|------|--------|
| `<directory>` | **Required.** Directory to scan and compare against the last inventory. |

No additional flags in the current CLI.

### `stats`

| Item | Notes |
|------|--------|
| `[directory]` | Optional. If omitted, uses existing inventory paths where applicable. |

No additional flags in the current CLI.

### `login`, `unpublish`, `config`

These commands take no extra flags beyond what `agent-cv --help` shows for the root program.

---

## AI setup

agent-cv picks the best available backend in a sensible order. You do not have to install everything.

| Backend | Setup |
|---------|--------|
| Claude Code | [Install Claude Code](https://claude.ai/claude-code) — richest file-aware analysis. |
| Codex CLI | `npm install -g @openai/codex` |
| Cursor | [Install Cursor](https://cursor.com) — headless agent mode. |
| OpenRouter | `export OPENROUTER_API_KEY=...` |
| Anthropic | `export ANTHROPIC_API_KEY=...` |
| OpenAI | `export OPENAI_API_KEY=...` |
| Ollama | `export AGENT_CV_BASE_URL=http://localhost:11434/v1` |

Telemetry is documented in-app and in config; set `AGENT_CV_TELEMETRY=off` if you want it disabled from the environment.
