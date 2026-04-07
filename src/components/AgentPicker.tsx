import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { ClaudeAdapter } from "../lib/analysis/claude-adapter.ts";
import { CodexAdapter } from "../lib/analysis/codex-adapter.ts";
import { CursorAdapter } from "../lib/analysis/cursor-adapter.ts";
import { OpenCodeAdapter } from "../lib/analysis/opencode-adapter.ts";
import { OllamaAdapter } from "../lib/analysis/ollama-adapter.ts";

const RECOMMENDED_MODEL = "qwen2.5-coder:3b";
import { APIAdapter } from "../lib/analysis/api-adapter.ts";
import { writeCredentials, type SavedCredentials } from "../lib/credentials.ts";
import type { AgentAdapter } from "../lib/types.ts";

interface AgentOption {
  name: string;
  label: string;
  adapter: AgentAdapter;
  available: boolean;
  detail: string;
}

interface Props {
  onSubmit: (adapter: AgentAdapter, name: string) => void;
  onBack?: () => void;
  defaultAgent?: string;
}

type PickerPhase = "list" | "provider" | "key-input" | "ollama-model" | "pulling-model";

const PROVIDERS = [
  { id: "openrouter" as const, label: "OpenRouter", detail: "multi-provider gateway, recommended", hint: "Get key: openrouter.ai/keys" },
  { id: "anthropic" as const, label: "Anthropic", detail: "Claude models directly", hint: "Get key: console.anthropic.com/settings/keys" },
  { id: "openai" as const, label: "OpenAI", detail: "GPT-4o and other models", hint: "Get key: platform.openai.com/api-keys" },
];

export function AgentPicker({ onSubmit, onBack, defaultAgent }: Props) {
  const { exit } = useApp();
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<PickerPhase>("list");
  const [providerCursor, setProviderCursor] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<typeof PROVIDERS[0] | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [pullStatus, setPullStatus] = useState("");
  const [pullPercent, setPullPercent] = useState(0);
  const [ollamaModels, setOllamaModels] = useState<Array<{ name: string; size: number; isRecommended?: boolean; needsDownload?: boolean }>>([]);
  const [modelCursor, setModelCursor] = useState(0);

  useEffect(() => {
    async function detect() {
      const options: AgentOption[] = [
        {
          name: "ollama",
          label: "Ollama (local)",
          adapter: new OllamaAdapter(),
          available: false,
          detail: "free, private, runs on your machine",
        },
        {
          name: "claude",
          label: "Claude Code",
          adapter: new ClaudeAdapter(),
          available: false,
          detail: "reads files directly, best analysis quality",
        },
        {
          name: "codex",
          label: "Codex CLI",
          adapter: new CodexAdapter(),
          available: false,
          detail: "OpenAI codex agent",
        },
        {
          name: "cursor",
          label: "Cursor Agent",
          adapter: new CursorAdapter(),
          available: false,
          detail: "headless mode, runs in project directory",
        },
        {
          name: "opencode",
          label: "OpenCode",
          adapter: new OpenCodeAdapter(),
          available: false,
          detail: "open-source AI coding agent",
        },
        {
          name: "api",
          label: "API (OpenRouter / Anthropic / OpenAI)",
          adapter: new APIAdapter(),
          available: false,
          detail: "uses saved or env API key",
        },
      ];

      await Promise.all(
        options.map(async (opt) => {
          opt.available = await opt.adapter.isAvailable();
          if (opt.name === "ollama") {
            const ollama = opt.adapter as OllamaAdapter;
            if (opt.available) {
              // Show which model will be used
              opt.detail = `free, private — using ${ollama.getModel()}`;
            } else {
              // Check if Ollama is running but has no suitable model
              try {
                const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
                if (res.ok) {
                  opt.available = true;
                  opt.detail = `press Enter to download ${RECOMMENDED_MODEL} (1.9 GB)`;
                }
              } catch { /* Ollama not running */ }
            }
          }
        })
      );

      setAgents(options);
      const savedIdx = defaultAgent ? options.findIndex((o) => o.name === defaultAgent && o.available) : -1;
      const firstAvailable = savedIdx >= 0 ? savedIdx : options.findIndex((o) => o.available);
      if (firstAvailable >= 0) setCursor(firstAvailable);
      setLoading(false);
    }
    detect();
  }, []);

  // Handle key input for API key entry
  useInput((input, key) => {
    if (loading || saving) return;

    if (phase === "list") {
      if (key.upArrow) {
        setCursor((c) => (c > 0 ? c - 1 : agents.length - 1));
      } else if (key.downArrow) {
        setCursor((c) => (c < agents.length - 1 ? c + 1 : 0));
      } else if (key.return) {
        const selected = agents[cursor];
        if (!selected) return;
        if (selected.name === "api" && !selected.available) {
          // API not configured — open key entry flow
          setPhase("provider");
          setProviderCursor(0);
          return;
        }
        if (selected.name === "ollama" && selected.available) {
          const ollama = selected.adapter as OllamaAdapter;
          (async () => {
            const models = await ollama.getModels();
            const hasRecommended = models.some(m => m.name === RECOMMENDED_MODEL);
            // Build list: recommended download first (if not installed), then installed models
            const list: Array<{ name: string; size: number; isRecommended?: boolean }> = [];
            if (!hasRecommended) {
              list.push({ name: RECOMMENDED_MODEL, size: 1.9e9, isRecommended: true, needsDownload: true });
            }
            for (const m of models) {
              list.push({ ...m, isRecommended: m.name === RECOMMENDED_MODEL });
            }
            setOllamaModels(list);
            // Pre-select: recommended if in list, otherwise current model
            const currentModel = ollama.getModel();
            const recIdx = list.findIndex(m => m.isRecommended);
            const curIdx = list.findIndex(m => m.name === currentModel);
            setModelCursor(recIdx >= 0 ? recIdx : curIdx >= 0 ? curIdx : 0);
            setPhase("ollama-model");
          })();
          return;
        }
        if (selected.available) {
          onSubmit(selected.adapter, selected.name);
        }
      } else if (key.escape) {
        if (onBack) onBack();
        else exit();
      } else if (input === "q") {
        exit();
      }
    } else if (phase === "ollama-model") {
      if (key.upArrow) {
        setModelCursor((c) => (c > 0 ? c - 1 : ollamaModels.length - 1));
      } else if (key.downArrow) {
        setModelCursor((c) => (c < ollamaModels.length - 1 ? c + 1 : 0));
      } else if (key.return) {
        const chosen = ollamaModels[modelCursor];
        if (!chosen) return;
        const ollama = agents.find(a => a.name === "ollama")?.adapter as OllamaAdapter;
        if (!ollama) return;

        if (chosen.needsDownload) {
          setPhase("pulling-model");
          (async () => {
            const ok = await ollama.pullModel(chosen.name, (status, percent) => {
              setPullStatus(status);
              setPullPercent(percent);
            });
            if (ok) {
              process.env.AGENT_CV_MODEL = chosen.name;
              await ollama.isAvailable();
              onSubmit(ollama, "ollama");
            } else {
              setPhase("ollama-model");
            }
          })();
        } else {
          process.env.AGENT_CV_MODEL = chosen.name;
          onSubmit(ollama, "ollama");
        }
      } else if (key.escape) {
        setPhase("list");
      }
    } else if (phase === "provider") {
      if (key.upArrow) {
        setProviderCursor((c) => (c > 0 ? c - 1 : PROVIDERS.length - 1));
      } else if (key.downArrow) {
        setProviderCursor((c) => (c < PROVIDERS.length - 1 ? c + 1 : 0));
      } else if (key.return) {
        setSelectedProvider(PROVIDERS[providerCursor]!);
        setKeyInput("");
        setPhase("key-input");
      } else if (key.escape) {
        setPhase("list");
      }
    } else if (phase === "key-input") {
      if (key.escape) {
        setPhase("provider");
        setKeyInput("");
        return;
      }
      if (key.return && keyInput.length > 0) {
        handleSaveKey();
        return;
      }
      if (key.backspace || key.delete) {
        setKeyInput((k) => k.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setKeyInput((k) => k + input);
      }
    }
  });

  async function handleSaveKey() {
    if (!selectedProvider || !keyInput) return;
    setSaving(true);
    try {
      const creds: SavedCredentials = {
        apiKey: keyInput.trim(),
        provider: selectedProvider.id,
      };
      await writeCredentials(creds);
      // Create a fresh APIAdapter that will pick up saved credentials
      const adapter = new APIAdapter();
      onSubmit(adapter, "api");
    } catch (err: any) {
      setSaving(false);
    }
  }

  if (loading) {
    return <Text color="yellow">Detecting available AI agents...</Text>;
  }

  if (saving) {
    return <Text color="yellow">Saving API key and starting analysis...</Text>;
  }

  if (phase === "ollama-model") {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text bold>Choose Ollama model</Text>
          <Text dimColor>[Enter] select  [Esc] back</Text>
        </Box>

        {ollamaModels.map((m, i) => {
          const isCur = i === modelCursor;
          const radio = isCur ? "◉" : "○";
          const sizeStr = m.size >= 1e9 ? `${(m.size / 1e9).toFixed(1)} GB` : `${Math.round(m.size / 1e6)} MB`;
          return (
            <Box key={m.name} gap={1}>
              <Text color={isCur ? "cyan" : undefined} bold={isCur}>
                {radio} {m.name}
              </Text>
              <Text dimColor>{sizeStr}</Text>
              {m.isRecommended && <Text color="green">recommended</Text>}
              {m.needsDownload && <Text color="yellow">download</Text>}
            </Box>
          );
        })}
      </Box>
    );
  }

  if (phase === "pulling-model") {
    const barWidth = 25;
    const filled = Math.round((pullPercent / 100) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
    return (
      <Box flexDirection="column">
        <Text bold>Downloading {RECOMMENDED_MODEL}...</Text>
        <Text>
          <Text color="yellow">{bar}</Text>
          <Text> {pullPercent}%</Text>
        </Text>
        <Text dimColor>{pullStatus}</Text>
      </Box>
    );
  }

  // Provider selection screen
  if (phase === "provider") {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text bold>Choose API provider</Text>
          <Text dimColor>[Enter] select  [Esc] back</Text>
        </Box>

        {PROVIDERS.map((provider, i) => {
          const isCursor = i === providerCursor;
          const radio = isCursor ? "◉" : "○";
          return (
            <Box key={provider.id} gap={1}>
              <Text color={isCursor ? "cyan" : undefined} bold={isCursor}>
                {radio} {provider.label}
              </Text>
              <Text dimColor>{provider.detail}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  // API key input screen
  if (phase === "key-input" && selectedProvider) {
    const masked = keyInput.length > 8
      ? keyInput.slice(0, 4) + "•".repeat(keyInput.length - 8) + keyInput.slice(-4)
      : "•".repeat(keyInput.length);

    return (
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text bold>Enter {selectedProvider.label} API key</Text>
          <Text dimColor>{selectedProvider.hint}</Text>
          <Text dimColor>Key is saved to ~/.agent-cv/credentials.json</Text>
        </Box>

        <Box>
          <Text color="cyan">Key: </Text>
          <Text>{masked || <Text dimColor>paste your key here...</Text>}</Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>[Enter] save  [Esc] back</Text>
        </Box>
      </Box>
    );
  }

  // Main agent list
  const anyAvailable = agents.some((a) => a.available);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Choose AI agent for analysis</Text>
        <Text dimColor>[Enter] select  [Esc] back  [q] quit</Text>
      </Box>

      {agents.map((agent, i) => {
        const isCursor = i === cursor;
        const radio = isCursor ? "◉" : "○";

        if (!agent.available) {
          // API and Ollama get special treatment — selectable even when not configured
          if (agent.name === "api") {
            return (
              <Box key={agent.name} gap={1}>
                <Text color={isCursor ? "cyan" : undefined} bold={isCursor}>
                  {radio} {agent.label}
                </Text>
                <Text dimColor>— press Enter to configure</Text>
              </Box>
            );
          }
          return (
            <Box key={agent.name} gap={1}>
              <Text color="gray">
                {radio} {agent.label}
              </Text>
              <Text color="gray">— not found</Text>
            </Box>
          );
        }

        // Ollama highlighted in yellow as recommended free option
        if (agent.name === "ollama") {
          return (
            <Box key={agent.name} gap={1}>
              <Text color={isCursor ? "cyan" : "yellow"} bold={isCursor}>
                {radio} {agent.label}
              </Text>
              <Text dimColor>{agent.detail}</Text>
            </Box>
          );
        }

        return (
          <Box key={agent.name} gap={1}>
            <Text color={isCursor ? "cyan" : undefined} bold={isCursor}>
              {radio} {agent.label}
            </Text>
            <Text dimColor>{agent.detail}</Text>
          </Box>
        );
      })}

      {!anyAvailable && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">No AI agents detected.</Text>
          <Text dimColor>
            Select API to enter a key, or install Claude Code, Codex, Cursor, or Ollama.
          </Text>
        </Box>
      )}
    </Box>
  );
}
