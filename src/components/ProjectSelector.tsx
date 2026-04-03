import React, { useState, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { relative, dirname } from "node:path";
import type { Project } from "../lib/types.ts";

interface Props {
  projects: Project[];
  scanRoot: string;
  onSubmit: (selected: Project[]) => void;
}

type Row =
  | { kind: "group"; path: string; count: number; selectedCount: number }
  | { kind: "project"; project: Project; relPath: string };

export function ProjectSelector({ projects, scanRoot, onSubmit }: Props) {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(
      projects
        .filter((p) => p.authorCommitCount > 0 || !p.hasGit)
        .map((p) => p.id)
    )
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  // Reserved keys that do NOT type into search
  const RESERVED = new Set([" ", "a", "s", "q"]);

  // Group projects by parent directory
  const groups = useMemo(() => {
    const map = new Map<string, Array<{ project: Project; relPath: string }>>();
    for (const project of projects) {
      const rel = relative(scanRoot, project.path);
      const parent = dirname(rel);
      const groupKey = parent === "." ? "." : parent;
      if (!map.has(groupKey)) map.set(groupKey, []);
      map.get(groupKey)!.push({ project, relPath: rel });
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

  // Build flat row list
  const rows = useMemo((): Row[] => {
    const result: Row[] = [];
    for (const [groupPath, items] of filteredGroups) {
      const selectedCount = items.filter((i) => selected.has(i.project.id)).length;
      result.push({ kind: "group", path: groupPath, count: items.length, selectedCount });
      if (!collapsed.has(groupPath)) {
        for (const item of items) {
          result.push({ kind: "project", project: item.project, relPath: item.relPath });
        }
      }
    }
    return result;
  }, [filteredGroups, collapsed, selected]);

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

    // Space: toggle
    if (input === " ") { toggleCurrent(); return; }

    // Enter: collapse group or submit
    if (key.return) {
      const row = rows[cursor];
      if (row?.kind === "group") {
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(row.path)) next.delete(row.path);
          else next.add(row.path);
          return next;
        });
        return;
      }
      const result = projects.filter((p) => selected.has(p.id));
      onSubmit(result);
      return;
    }

    // Reserved single-char commands (only when not searching)
    if (!search && input && RESERVED.has(input)) {
      if (input === "a") {
        if (selected.size === projects.length) setSelected(new Set());
        else setSelected(new Set(projects.map((p) => p.id)));
      } else if (input === "s") {
        onSubmit(projects.filter((p) => selected.has(p.id)));
      } else if (input === "q") {
        exit();
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
    if (row.kind === "group") {
      const groupItems = filteredGroups.find(([p]) => p === row.path)?.[1];
      if (!groupItems) return;
      const groupIds = groupItems.map((i) => i.project.id);
      const allSelected = groupIds.every((id) => selected.has(id));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of groupIds) { if (allSelected) next.delete(id); else next.add(id); }
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
          Select projects for CV ({selected.size}/{projects.length})
          {search && <Text color="cyan"> — {filteredGroups.reduce((n, [, items]) => n + items.length, 0)} matches</Text>}
        </Text>
        <Text dimColor>
          [Space] toggle  [Enter] expand/collapse  [s] submit  [a] all  [Esc] clear  Type to search
        </Text>
        <Text dimColor>
          <Text color="green">★</Text> = your commits  <Text color="yellow">!</Text> = secrets excluded  <Text color="gray">gray</Text> = not yours
        </Text>
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

        if (row.kind === "group") {
          const isCollapsed = collapsed.has(row.path);
          const arrow = isCollapsed ? "▸" : "▾";
          const label = row.path === "." ? "(root)" : row.path + "/";
          const countLabel = `selected ${row.selectedCount} of ${row.count}`;
          return (
            <Box key={`g-${row.path}`} gap={1}>
              <Text color={isCursor ? "cyan" : "white"} bold inverse={isCursor}>
                {arrow} {label}
              </Text>
              <Text color={row.selectedCount === row.count ? "green" : row.selectedCount > 0 ? "yellow" : "gray"}>
                {countLabel}
              </Text>
            </Box>
          );
        }

        const p = row.project;
        const isSelected = selected.has(p.id);
        const checkbox = isSelected ? "[x]" : "[ ]";
        const dateStr = p.dateRange.start ? `${p.dateRange.approximate ? "~" : ""}${p.dateRange.start}` : "?";
        const secrets = p.privacyAudit?.secretsFound ?? 0;
        const hasMyCommits = p.authorCommitCount > 0;
        const isMyProject = hasMyCommits || !p.hasGit;
        const nameColor = isCursor ? "cyan" : isMyProject ? undefined : "gray";

        return (
          <Box key={p.id} gap={1}>
            <Text color={nameColor} inverse={isCursor}>
              {"    "}{checkbox} {p.displayName}
            </Text>
            {hasMyCommits && <Text color="green">★ {p.authorCommitCount} my / {p.commitCount} total</Text>}
            {!p.hasGit && <Text dimColor>no git</Text>}
            <Text dimColor>{p.language} {dateStr}</Text>
            {secrets > 0 && <Text color="yellow">!</Text>}
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
