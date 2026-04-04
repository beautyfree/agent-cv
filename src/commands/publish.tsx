import React, { useState, useEffect, useCallback } from "react";
import { Box, Text } from "ink";
import { readInventory, writeInventory } from "../lib/inventory/store.ts";
import { resolveAdapter } from "../lib/analysis/resolve-adapter.ts";
import { writeConfig } from "../lib/config.ts";
import { ProjectSelector } from "../components/ProjectSelector.tsx";
import { EmailPicker } from "../components/EmailPicker.tsx";
import { AgentPicker } from "../components/AgentPicker.tsx";
import {
  scanAndMerge,
  collectEmails,
  recountAndTag,
  analyzeProjects,
  countUnanalyzed,
} from "../lib/pipeline.ts";
import {
  readAuthToken,
  startDeviceFlow,
  pollForToken,
  publishToApi,
  PendingError,
  SlowDownError,
} from "../lib/auth.ts";
import type { Inventory, Project, AgentAdapter } from "../lib/types.ts";
import { exec } from "node:child_process";

type Phase =
  | "checking-auth" | "auth" | "polling"
  | "scanning" | "picking-emails" | "recounting" | "selecting"
  | "picking-agent" | "analyzing"
  | "checking-public" | "publishing" | "done" | "error";

interface Props {
  args?: string[];
  options: { bio?: string; noOpen?: boolean; all?: boolean; agent?: string; email?: string };
}

export default function Publish({ args, options }: Props) {
  const dir = args?.[0];
  const [phase, setPhase] = useState<Phase>("checking-auth");
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [error, setError] = useState("");
  const [publicCount, setPublicCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [scanCount, setScanCount] = useState(0);
  const [lastFound, setLastFound] = useState("");
  const [scanDir, setScanDir] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [current, setCurrent] = useState("");

  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Project[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [resolvedAdapter, setResolvedAdapter] = useState<AgentAdapter | null>(null);
  const [emailCounts, setEmailCounts] = useState<Map<string, number>>(new Map());
  const [gitConfigEmails, setGitConfigEmails] = useState<Set<string>>(new Set());
  const [confirmedEmails, setConfirmedEmails] = useState<string[]>([]);
  const [analyzedCount, setAnalyzedCount] = useState(0);
  const [jwt, setJwt] = useState("");

  // Step 1: Auth
  useEffect(() => {
    async function auth() {
      try {
        let authData = await readAuthToken();
        if (authData?.jwt) {
          setJwt(authData.jwt);
          startScanPhase();
          return;
        }
        setPhase("auth");
        const flow = await startDeviceFlow();
        setUserCode(flow.userCode);
        setVerificationUri(flow.verificationUri);
        try { exec(`open ${flow.verificationUri}`); } catch {}

        setPhase("polling");
        let interval = flow.interval;
        while (true) {
          await sleep(interval * 1000);
          try {
            authData = await pollForToken(flow.deviceCode);
            setJwt(authData.jwt);
            startScanPhase();
            return;
          } catch (e) {
            if (e instanceof PendingError) continue;
            if (e instanceof SlowDownError) { interval += 2; continue; }
            throw e;
          }
        }
      } catch (e: any) { setError(e.message); setPhase("error"); }
    }
    auth();
  }, []);

  function startScanPhase() {
    if (dir) {
      setPhase("scanning");
    } else {
      // No dir — use existing inventory
      readInventory().then((inv) => {
        if (inv.projects.length === 0) {
          setError("No projects found. Provide a directory: `agent-cv publish ~/Projects`");
          setPhase("error");
          return;
        }
        setInventory(inv);
        const projects = inv.projects.filter((p) => !p.tags.includes("removed"));
        setAllProjects(projects);
        checkIfNeedsAnalysis(inv, projects);
      });
    }
  }

  // Step 2: Scan (if dir provided)
  useEffect(() => {
    if (phase !== "scanning" || !dir) return;
    async function scan() {
      try {
        const result = await scanAndMerge(dir!, {
          onProjectFound: (p, total) => { setScanCount(total); setLastFound(p.displayName); },
          onDirectoryEnter: (d) => { setScanDir(d.replace(dir!, "").replace(/^\//, "") || "."); },
        });
        if (result.projects.length === 0) {
          setError(`No projects found in ${dir}`);
          setPhase("error");
          return;
        }
        setInventory(result.inventory);
        setAllProjects(result.projects);
        checkIfNeedsAnalysis(result.inventory, result.projects);
      } catch (e: any) { setError(e.message); setPhase("error"); }
    }
    scan();
  }, [phase, dir]);

  function checkIfNeedsAnalysis(inv: Inventory, projects: Project[]) {
    const unanalyzed = countUnanalyzed(projects);
    if (unanalyzed === 0) {
      // All analyzed — skip to publish
      setSelectedProjects(projects.filter((p) => p.included !== false));
      setPhase("checking-public");
    } else if (options.email) {
      setConfirmedEmails(options.email.split(",").map((e) => e.trim()));
      setPhase("recounting");
    } else {
      // Need analysis — start email picker flow
      collectEmails(projects).then((emails) => {
        setEmailCounts(emails.emailCounts);
        setGitConfigEmails(emails.preSelected);
        if (emails.emailCounts.size === 0) {
          setConfirmedEmails([]);
          setPhase("selecting");
        } else {
          setPhase("picking-emails");
        }
      });
    }
  }

  const handleEmailPick = useCallback(async (selected: string[], save: boolean) => {
    setConfirmedEmails(selected);
    if (save) await writeConfig({ emails: selected, emailsConfirmed: true });
    setPhase("recounting");
  }, []);

  // Step 3: Recount
  useEffect(() => {
    if (phase !== "recounting") return;
    async function recount() {
      try {
        const updated = await recountAndTag(allProjects, confirmedEmails);
        setAllProjects(updated);
        if (inventory) await writeInventory(inventory);
        if (options.all) { setSelectedProjects(updated); setPhase("picking-agent"); }
        else setPhase("selecting");
      } catch (e: any) { setError(e.message); setPhase("error"); }
    }
    recount();
  }, [phase]);

  const handleSelection = useCallback(async (selected: Project[]) => {
    if (selected.length === 0) { setError("No projects selected."); setPhase("error"); return; }
    setSelectedProjects(selected);
    const agentOpt = options.agent || "auto";
    if (agentOpt !== "auto") {
      try {
        const { adapter } = await resolveAdapter(agentOpt);
        setResolvedAdapter(adapter);
        setPhase("analyzing");
      } catch (e: any) { setError(e.message); setPhase("error"); }
      return;
    }
    setPhase("picking-agent");
  }, [options.agent]);

  const handleAgentPick = useCallback((adapter: AgentAdapter) => {
    setResolvedAdapter(adapter);
    setPhase("analyzing");
  }, []);

  // Step 4: Analyze
  useEffect(() => {
    if (phase !== "analyzing" || !resolvedAdapter) return;
    async function run() {
      try {
        await analyzeProjects(selectedProjects, resolvedAdapter!, inventory!, {
          onProgress: (done, total, cur) => { setProgress({ done, total }); setCurrent(cur); },
        });
        if (inventory) await writeInventory(inventory);
        setPhase("checking-public");
      } catch (e: any) { setError(e.message); setPhase("error"); }
    }
    run();
  }, [phase, resolvedAdapter]);

  // Step 5: Check public + publish
  useEffect(() => {
    if (phase !== "checking-public") return;
    async function pub() {
      try {
        const included = (inventory?.projects || selectedProjects).filter((p) => p.included !== false);
        setTotalCount(included.length);
        setAnalyzedCount(included.filter((p) => p.analysis).length);

        const publicFlags = await checkPublicRepos(included);
        setPublicCount(Object.values(publicFlags).filter(Boolean).length);

        setPhase("publishing");
        const payload = sanitizeForPublish(inventory!, publicFlags, options.bio);

        const result = await publishToApi(jwt, payload);
        setResultUrl(result.url);
        setPhase("done");
        if (!options.noOpen) { try { exec(`open ${result.url}`); } catch {} }
      } catch (e: any) {
        if (e.message === "AUTH_EXPIRED") {
          const { writeAuthToken } = await import("../lib/auth.ts");
          await writeAuthToken({ jwt: "", username: "", obtainedAt: "" });
          setError("Session expired. Run `agent-cv publish` again.");
          setPhase("error");
        } else { setError(e.message); setPhase("error"); }
      }
    }
    pub();
  }, [phase]);

  // Render
  if (phase === "error") return <Text color="red">Error: {error}</Text>;
  if (phase === "checking-auth") return <Text color="gray">Checking authentication...</Text>;
  if (phase === "auth") return (
    <Box flexDirection="column" gap={1}>
      <Text>Open this URL in your browser:</Text>
      <Text bold color="cyan">{verificationUri}</Text>
      <Text>Enter code: <Text bold color="yellow">{userCode}</Text></Text>
    </Box>
  );
  if (phase === "polling") return (
    <Box flexDirection="column" gap={1}>
      <Text color="gray">Waiting for authorization...</Text>
      <Text>Enter code: <Text bold color="yellow">{userCode}</Text></Text>
    </Box>
  );
  if (phase === "scanning") return (
    <Box flexDirection="column">
      <Text color="yellow">Scanning {dir}...</Text>
      {scanCount > 0 && <Text color="green">Found {scanCount} project{scanCount !== 1 ? "s" : ""}{lastFound ? ` — ${lastFound}` : ""}</Text>}
      {scanDir && <Text dimColor>{scanDir}</Text>}
    </Box>
  );
  if (phase === "picking-emails") return <EmailPicker emailCounts={emailCounts} preSelected={gitConfigEmails} onSubmit={handleEmailPick} />;
  if (phase === "recounting") return <Text color="yellow">Identifying your projects...</Text>;
  if (phase === "selecting") return <ProjectSelector projects={allProjects} scanRoot={dir || "~"} onSubmit={handleSelection} />;
  if (phase === "picking-agent") return <AgentPicker onSubmit={handleAgentPick} />;
  if (phase === "analyzing") return (
    <Box flexDirection="column">
      <Text color="yellow">Analyzing [{progress.done}/{progress.total}]: {current}</Text>
    </Box>
  );
  if (phase === "checking-public") return <Text color="gray">Checking repos...</Text>;
  if (phase === "publishing") return <Text color="gray">Publishing to agent-cv.dev...</Text>;

  return (
    <Box flexDirection="column" gap={1}>
      <Text> </Text>
      <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1} flexDirection="column" alignItems="center">
        <Text bold>Your portfolio is live at</Text>
        <Text bold color="cyan">{resultUrl}</Text>
      </Box>
      <Text color="gray">{totalCount} projects ({analyzedCount} with AI analysis) · {publicCount} public, {totalCount - publicCount} private</Text>
      <Text> </Text>
    </Box>
  );
}

async function checkPublicRepos(projects: Project[]): Promise<Record<string, boolean>> {
  const flags: Record<string, boolean> = {};
  const toCheck = projects.filter((p) => p.remoteUrl?.includes("github.com"));
  for (let i = 0; i < toCheck.length; i += 10) {
    const batch = toCheck.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (p) => {
      try {
        const match = p.remoteUrl!.match(/github\.com\/([^/]+\/[^/]+)/);
        if (!match) return { id: p.id, isPublic: false };
        const res = await fetch(`https://api.github.com/repos/${match[1]}`, { redirect: "follow", headers: { "User-Agent": "agent-cv" } });
        if (res.status === 200) { const data = await res.json(); return { id: p.id, isPublic: !data.private }; }
        return { id: p.id, isPublic: false };
      } catch { return { id: p.id, isPublic: false }; }
    }));
    for (const r of results) flags[r.id] = r.isPublic;
  }
  for (const p of projects) { if (!(p.id in flags)) flags[p.id] = false; }
  return flags;
}

function sanitizeForPublish(inventory: Inventory, publicFlags: Record<string, boolean>, bio?: string) {
  const projects = inventory.projects.filter((p) => p.included !== false).map((p: Project) => {
    const isPublic = publicFlags[p.id] ?? false;
    return {
      id: p.id, displayName: p.displayName, type: p.type, language: p.language,
      frameworks: p.frameworks, dateRange: p.dateRange, hasGit: p.hasGit,
      commitCount: p.commitCount, authorCommitCount: p.authorCommitCount,
      hasUncommittedChanges: p.hasUncommittedChanges, lastCommit: p.lastCommit,
      analysis: p.analysis, tags: p.tags, included: true,
      remoteUrl: isPublic ? p.remoteUrl : null, isPublic,
    };
  });
  return { inventory: { version: inventory.version, projects }, bio };
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
