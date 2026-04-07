import React, { useState, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { relative, dirname, resolve, basename } from "node:path";
import type { Project } from "../lib/types.ts";
import { PROMPT_VERSION } from "../lib/types.ts";

interface Props {
  projects: Project[];
  scanRoot: string;
  onSubmit: (selected: Project[]) => void;
}

type Row =
  | { kind: "group"; path: string; count: number; selectedCount: number; depth: number }
  | { kind: "project"; project: Project; relPath: string; depth: number }
  | { kind: "other-header"; count: number; selectedCount: number };

export function ProjectSelector({ projects, scanRoot, onSubmit }: Props) {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);

  // Split projects into scanned (from current directory) and other (from inventory)
  const absScanRoot = useMemo(() => resolve(scanRoot), [scanRoot]);
  const { scannedProjects, otherProjects } = useMemo(() => {
    const scanned: Project[] = [];
    const other: Project[] = [];
    for (const p of projects) {
      if (p.path && p.path.startsWith(absScanRoot)) {
        scanned.push(p);
      } else {
        other.push(p);
      }
    }
    return { scannedProjects: scanned, otherProjects: other };
  }, [projects, absScanRoot]);

  // Selection logic: scanned projects use saved state or heuristic.
  // "Other" projects (outside current scan path) are NOT pre-selected —
  // they're from a different scan and the user should opt-in explicitly.
  const hasSavedSelection = scannedProjects.some((p) => p.included === false);
  const initialSelection = useMemo(() => {
    const ids = new Set<string>();
    // Scanned projects: use saved state or author-commit heuristic
    for (const p of scannedProjects) {
      if (hasSavedSelection) {
        if (p.included) ids.add(p.id);
      } else {
        if (p.authorCommitCount > 0 || !p.hasGit || p.commitCount === 0 || p.hasUncommittedChanges) {
          ids.add(p.id);
        }
      }
    }
    // Other projects: NOT pre-selected. User is focusing on current scan path.
    // They can expand "Other" and toggle individual projects if needed.
    return ids;
  }, [scannedProjects, otherProjects, hasSavedSelection]);

  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelection));
  const [undoStack, setUndoStack] = useState<Set<string>[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [otherCollapsed, setOtherCollapsed] = useState(true);
  const [search, setSearch] = useState("");

  function pushUndo() {
    setUndoStack((stack) => [...stack.slice(-20), new Set(selected)]);
  }

  // Reserved keys that do NOT type into search
  const RESERVED = new Set([" ", "a", "q", "u", "r", "f", "F"]);
  const [forceReanalyze, setForceReanalyze] = useState<Set<string>>(new Set());

  // Group projects by parent directory (scanned projects only)
  const groups = useMemo(() => {
    const map = new Map<string, Array<{ project: Project; relPath: string }>>();
    for (const project of scannedProjects) {
      const rel = relative(scanRoot, project.path);
      const parent = dirname(rel);
      const groupKey = parent === "." ? "." : parent;
      if (!map.has(groupKey)) map.set(groupKey, []);
      map.get(groupKey)!.push({ project, relPath: rel });
    }

    // Create intermediate parent groups only where needed.
    // If all ancestors are empty (no direct projects), don't create
    // them — the group will show its full relative path instead.
    // Only create an ancestor if it already has direct projects.
    const allPaths = [...map.keys()];
    for (const path of allPaths) {
      if (path === ".") continue;
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join("/");
        if (!map.has(ancestor)) {
          map.set(ancestor, []);
        }
      }
    }

    // Collapse chains of empty groups into their first non-empty descendant.
    // learn/ (empty) → learn/buildspace/ (empty) → learn/buildspace/solana-core/ (has projects)
    // becomes: learn/buildspace/solana-core/ shown with full path label
    const emptyGroups = new Set<string>();
    for (const [path, items] of map) {
      if (items.length === 0) emptyGroups.add(path);
    }
    // An empty group is collapsible if ALL its children are either
    // empty or it has exactly one child group (linear chain)
    for (const emptyPath of emptyGroups) {
      const children = [...map.keys()].filter(
        (k) => k !== emptyPath && k.startsWith(emptyPath + "/") &&
        k.split("/").length === emptyPath.split("/").length + 1
      );
      // Only collapse if this empty group has exactly one child
      // (otherwise it's a branching point and should stay)
      if (children.length === 1) {
        map.delete(emptyPath);
      }
    }

    return [...map.entries()].sort(([a], [b]) => {
      if (a === ".") return -1;
      if (b === ".") return 1;
      return a.localeCompare(b);
    });
  }, [projects, scanRoot]);

  // Filter groups by search
  const filteredGroups = useMemo(() => {
    if (!search) return groups;
    const q = search.toLowerCase();
    const result: typeof groups = [];
    for (const [groupPath, items] of groups) {
      if (groupPath.toLowerCase().includes(q)) {
        result.push([groupPath, items]);
        continue;
      }
      const matched = items.filter(
        (i) =>
          i.project.displayName.toLowerCase().includes(q) ||
          i.project.language.toLowerCase().includes(q) ||
          i.relPath.toLowerCase().includes(q)
      );
      if (matched.length > 0) result.push([groupPath, matched]);
    }
    return result;
  }, [groups, search]);

  // Build flat row list (respecting parent collapse)
  const rows = useMemo((): Row[] => {
    const result: Row[] = [];

    // Check if any ancestor group is collapsed
    function isHiddenByParent(groupPath: string): boolean {
      for (const collapsedPath of collapsed) {
        if (collapsedPath === groupPath) continue;
        // Root "." is parent of everything
        if (collapsedPath === "." && groupPath !== ".") return true;
        const prefix = collapsedPath + "/";
        if (groupPath.startsWith(prefix)) return true;
      }
      return false;
    }

    // Count items in this group + all nested subgroups
    function countNested(groupPath: string): { total: number; selected: number } {
      let total = 0;
      let sel = 0;
      for (const [gp, items] of filteredGroups) {
        // Root "." contains everything
        const isMatch = gp === groupPath
          || (groupPath === "." && gp !== ".")
          || gp.startsWith(groupPath + "/");
        if (isMatch) {
          total += items.length;
          sel += items.filter((i) => selected.has(i.project.id)).length;
        }
      }
      return { total, selected: sel };
    }

    // Build set of visible group paths for depth calculation
    const visiblePaths = new Set<string>();
    for (const [groupPath] of filteredGroups) {
      if (!isHiddenByParent(groupPath)) visiblePaths.add(groupPath);
    }

    // Calculate depth as number of visible ancestors (not path segments)
    function getDepth(groupPath: string): number {
      if (groupPath === ".") return 0;
      // All non-root groups are children of root "." — add 1 if root is visible
      let depth = visiblePaths.has(".") ? 1 : 0;
      const parts = groupPath.split("/");
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join("/");
        if (visiblePaths.has(ancestor)) depth++;
      }
      return depth;
    }

    for (const [groupPath, items] of filteredGroups) {
      if (isHiddenByParent(groupPath)) continue;

      const depth = getDepth(groupPath);
      const { total, selected: sel } = countNested(groupPath);
      result.push({ kind: "group", path: groupPath, count: total, selectedCount: sel, depth });

      if (!collapsed.has(groupPath)) {
        for (const item of items) {
          result.push({ kind: "project", project: item.project, relPath: item.relPath, depth: depth + 1 });
        }
      }
    }

    // "Other projects" tier — from inventory but outside current scan path
    const filteredOther = search
      ? otherProjects.filter((p) => {
          const q = search.toLowerCase();
          return p.displayName.toLowerCase().includes(q) || p.language.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
        })
      : otherProjects;

    if (filteredOther.length > 0) {
      const otherSel = filteredOther.filter((p) => selected.has(p.id)).length;
      result.push({ kind: "other-header", count: filteredOther.length, selectedCount: otherSel });

      if (!otherCollapsed) {
        for (const p of filteredOther) {
          // Use basename of parent dir as relPath for display
          const parentDir = dirname(p.path);
          const label = parentDir.replace(process.env.HOME || "~", "~");
          result.push({ kind: "project", project: p, relPath: label, depth: 1 });
        }
      }
    }

    return result;
  }, [filteredGroups, collapsed, selected, otherProjects, otherCollapsed, search]);

  // Windowed scrolling
  const windowSize = Math.min(20, rows.length);
  const halfWindow = Math.floor(windowSize / 2);
  let start = Math.max(0, cursor - halfWindow);
  const end = Math.min(rows.length, start + windowSize);
  if (end === rows.length) start = Math.max(0, end - windowSize);
  const visible = rows.slice(start, end);

  // Reset cursor on search change
  useMemo(() => { setCursor(0); }, [search]);

  useInput((input, key) => {
    // Navigation
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : rows.length - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c < rows.length - 1 ? c + 1 : 0));
      return;
    }

    // Backspace: delete search char
    if (key.backspace || key.delete) {
      if (search) setSearch((s) => s.slice(0, -1));
      return;
    }

    // Escape: clear search or quit
    if (key.escape) {
      if (search) { setSearch(""); return; }
      exit();
      return;
    }

    // Space: toggle selection
    if (input === " ") { toggleCurrent(); return; }

    // Tab / Right / Left: collapse/expand group
    if (key.tab || key.rightArrow || key.leftArrow) {
      const row = rows[cursor];
      if (row?.kind === "other-header") {
        const shouldCollapse = key.leftArrow ? true : key.rightArrow ? false : undefined;
        setOtherCollapsed(shouldCollapse ?? !otherCollapsed);
      } else if (row?.kind === "group") {
        const shouldCollapse = key.leftArrow ? true : key.rightArrow ? false : undefined;
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (shouldCollapse === true || (!shouldCollapse && !next.has(row.path))) {
            next.add(row.path);
          } else {
            next.delete(row.path);
            const prefix = row.path === "." ? "" : row.path + "/";
            if (prefix) {
              for (const key of next) {
                if (key.startsWith(prefix)) next.delete(key);
              }
            }
          }
          return next;
        });
      }
      return;
    }

    // Enter: submit (only if something selected)
    if (key.return) {
      if (selected.size === 0) return;
      const result = projects.filter((p) => selected.has(p.id));
      onSubmit(result);
      return;
    }

    // Reserved single-char commands (only when not searching)
    if (!search && input && RESERVED.has(input)) {
      if (input === "a") {
        pushUndo();
        // Toggle all scanned projects (not other)
        const scannedIds = new Set(scannedProjects.map((p) => p.id));
        const allScannedSelected = scannedProjects.every((p) => selected.has(p.id));
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of scannedIds) {
            if (allScannedSelected) next.delete(id); else next.add(id);
          }
          return next;
        });
      } else if (input === "q") {
        exit();
      } else if (input === "u") {
        setUndoStack((stack) => {
          if (stack.length === 0) return stack;
          const prev = stack[stack.length - 1]!;
          setSelected(prev);
          return stack.slice(0, -1);
        });
      } else if (input === "r") {
        pushUndo();
        setSelected(new Set(initialSelection));
      } else if (input === "f") {
        // Mark current project for forced re-analysis
        const row = rows[cursor];
        if (row?.kind === "project") {
          setForceReanalyze((prev) => {
            const next = new Set(prev);
            if (next.has(row.project.id)) next.delete(row.project.id);
            else {
              next.add(row.project.id);
              row.project.analysis = undefined as any;
            }
            return next;
          });
        }
      } else if (input === "F") {
        // Toggle re-analyze ALL selected projects
        const selectedProjects = projects.filter((p) => selected.has(p.id));
        const allForced = selectedProjects.every((p) => forceReanalyze.has(p.id));
        setForceReanalyze(() => {
          if (allForced) return new Set();
          const next = new Set<string>();
          for (const p of selectedProjects) {
            next.add(p.id);
            p.analysis = undefined as any;
          }
          return next;
        });
      }
      return;
    }

    // Any other printable char: type into search
    if (input && !key.ctrl && !key.meta) {
      setSearch((s) => s + input);
    }
  });

  function toggleCurrent() {
    const row = rows[cursor];
    if (!row) return;
    pushUndo();
    if (row.kind === "other-header") {
      // Toggle all other projects
      const otherIds = otherProjects.map((p) => p.id);
      const allSelected = otherIds.every((id) => selected.has(id));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of otherIds) { if (allSelected) next.delete(id); else next.add(id); }
        return next;
      });
      return;
    }
    if (row.kind === "group") {
      // Collect ALL projects in this group AND nested subgroups
      const allIds: string[] = [];
      for (const [groupPath, items] of filteredGroups) {
        const isMatch = groupPath === row.path
          || (row.path === "." && groupPath !== ".")
          || groupPath.startsWith(row.path + "/");
        if (isMatch) {
          for (const item of items) allIds.push(item.project.id);
        }
      }
      if (allIds.length === 0) return;
      const allSelected = allIds.every((id) => selected.has(id));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of allIds) { if (allSelected) next.delete(id); else next.add(id); }
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(row.project.id)) next.delete(row.project.id);
        else next.add(row.project.id);
        return next;
      });
    }
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text bold>
          Select projects for CV ({selected.size}/{scannedProjects.length}{otherProjects.length > 0 ? ` + ${otherProjects.filter(p => selected.has(p.id)).length} other` : ""})
          {search && <Text color="cyan"> — {filteredGroups.reduce((n, [, items]) => n + items.length, 0)} matches</Text>}
          {!search && projects.some((p) => p.tags.includes("new")) && (
            <Text color="blue"> — {projects.filter((p) => p.tags.includes("new")).length} new</Text>
          )}
        </Text>
        <Text dimColor>
          [Space] toggle  [Tab] expand/collapse  [Enter] submit  [a] all  [u] undo  [r] reset  [f/F] re-analyze one/all  Type to search
        </Text>
        <Text dimColor>
          <Text color="green">★</Text> = your commits  <Text color="yellow">!</Text> = secrets excluded  <Text color="gray">gray</Text> = not yours
        </Text>
        {otherProjects.length > 0 && (
          <Text dimColor>
            Scanned {scanRoot.replace(process.env.HOME || "~", "~")} — {scannedProjects.length} project{scannedProjects.length !== 1 ? "s" : ""}
            {scannedProjects.filter((p) => p.tags.includes("new")).length > 0 && <Text color="blue"> ({scannedProjects.filter((p) => p.tags.includes("new")).length} new)</Text>}
            . {otherProjects.length} other{otherProjects.length !== 1 ? "s" : ""} in inventory.
          </Text>
        )}
        {(() => {
          const sel = projects.filter((p) => selected.has(p.id));
          const needsAnalysis = sel.filter((p) => {
            if (!p.analysis) return true;
            if (!p.analysis.analyzedAtCommit) return true;
            if (p.lastCommit && p.lastCommit !== p.analysis.analyzedAtCommit) return true;
            if (p.analysis.promptVersion !== PROMPT_VERSION) return true;
            return false;
          });
          const cached = sel.length - needsAnalysis.length;
          const mins = Math.max(1, Math.ceil(needsAnalysis.length * 15 / 60));
          return (
            <Text dimColor>
              {cached > 0 && <Text color="green">{cached} cached</Text>}
              {cached > 0 && needsAnalysis.length > 0 && ", "}
              {needsAnalysis.length > 0 && <Text color="yellow">{needsAnalysis.length} to analyze (~{mins} min)</Text>}
              {needsAnalysis.length === 0 && cached > 0 && <Text> — all cached, no LLM calls needed</Text>}
            </Text>
          );
        })()}
      </Box>

      {search && (
        <Box marginBottom={1}>
          <Text dimColor>search: </Text>
          <Text color="cyan" bold>{search}</Text>
        </Box>
      )}

      {visible.map((row, i) => {
        const globalIndex = start + i;
        const isCursor = globalIndex === cursor;

        if (row.kind === "other-header") {
          const arrow = otherCollapsed ? "▸" : "▾";
          const allChecked = row.selectedCount === row.count && row.count > 0;
          const someChecked = row.selectedCount > 0;
          const checkbox = allChecked ? "[x]" : someChecked ? "[-]" : "[ ]";
          return (
            <Box key="other-header" gap={1} marginTop={1}>
              <Text color={isCursor ? "cyan" : "yellow"} bold inverse={isCursor}>
                {arrow} {checkbox} Other projects in inventory
              </Text>
              <Text color={allChecked ? "green" : someChecked ? "yellow" : "gray"}>
                {row.selectedCount}/{row.count}
              </Text>
            </Box>
          );
        }

        if (row.kind === "group") {
          const isCollapsed = collapsed.has(row.path);
          const arrow = isCollapsed ? "▸" : "▾";
          // Show path relative to nearest visible parent group
          // If parent was collapsed (removed), show full remaining path
          const visibleGroupPaths = filteredGroups.map(([p]) => p).filter((p) => p !== row.path);
          let label: string;
          if (row.path === ".") {
            label = basename(scanRoot) + "/";
          } else {
            // Find the closest ancestor that exists as a visible group
            const parts = row.path.split("/");
            let parentPath = "";
            for (let i = parts.length - 1; i >= 1; i--) {
              const candidate = parts.slice(0, i).join("/");
              if (visibleGroupPaths.includes(candidate)) {
                parentPath = candidate;
                break;
              }
            }
            // Label is the path relative to the parent, or full path if no parent
            label = parentPath
              ? row.path.slice(parentPath.length + 1) + "/"
              : row.path + "/";
          }
          const allChecked = row.selectedCount === row.count;
          const someChecked = row.selectedCount > 0;
          const checkbox = allChecked ? "[x]" : someChecked ? "[-]" : "[ ]";
          const indent = "   ".repeat(row.depth);
          return (
            <Box key={`g-${row.path}`} gap={1}>
              <Text color={isCursor ? "cyan" : "white"} bold inverse={isCursor}>
                {indent}{arrow} {checkbox} {label}
              </Text>
              <Text color={allChecked ? "green" : someChecked ? "yellow" : "gray"}>
                {row.selectedCount}/{row.count}
              </Text>
            </Box>
          );
        }

        const p = row.project;
        const isSelected = selected.has(p.id);
        const isForced = forceReanalyze.has(p.id);
        const checkbox = isForced ? "[↻]" : isSelected ? "[x]" : "[ ]";
        const dateStr = p.dateRange.start ? `${p.dateRange.approximate ? "~" : ""}${p.dateRange.start}` : "?";
        const secrets = p.privacyAudit?.secretsFound ?? 0;
        const hasMyCommits = p.authorCommitCount > 0;
        const isMyProject = hasMyCommits || !p.hasGit || p.commitCount === 0 || p.hasUncommittedChanges;
        const nameColor = isCursor ? "cyan" : isMyProject ? undefined : "gray";
        const indent = "   ".repeat(row.depth);

        const name = p.displayName.length > 30 ? p.displayName.slice(0, 28) + ".." : p.displayName;
        const meta: string[] = [];
        if (hasMyCommits) meta.push(`★${p.authorCommitCount}/${p.commitCount}`);
        if (p.tags.includes("forgotten-gem")) meta.push("💎");
        if (p.tags.includes("new")) meta.push("NEW");
        if (!p.hasGit) meta.push("no git");
        if (p.hasUncommittedChanges && !hasMyCommits) meta.push("uncommitted");
        meta.push(p.language);
        meta.push(dateStr);
        if (secrets > 0) meta.push("!");

        return (
          <Box key={p.id}>
            <Text color={isForced ? "magenta" : nameColor} inverse={isCursor}>
              {indent}  {checkbox} {name}
            </Text>
            <Text> </Text>
            <Text dimColor>{meta.join(" · ")}</Text>
          </Box>
        );
      })}

      {rows.length > windowSize && (
        <Text dimColor>{"\n"}{start + 1}-{end} of {rows.length} rows</Text>
      )}
      {rows.length === 0 && search && (
        <Text dimColor>No matches for "{search}"</Text>
      )}
    </Box>
  );
}
