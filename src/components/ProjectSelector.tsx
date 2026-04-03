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

/**
 * Interactive project selector with directory grouping.
 * Projects are grouped by their parent directory relative to scanRoot.
 * Space on a group header toggles all projects in that group.
 * Space on a project toggles that project.
 */
export function ProjectSelector({ projects, scanRoot, onSubmit }: Props) {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(projects.map((p) => p.id))
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Group projects by parent directory
  const groups = useMemo(() => {
    const map = new Map<string, Array<{ project: Project; relPath: string }>>();

    for (const project of projects) {
      const rel = relative(scanRoot, project.path);
      const parent = dirname(rel);
      // "." means project is directly in scanRoot
      const groupKey = parent === "." ? "." : parent;

      if (!map.has(groupKey)) map.set(groupKey, []);
      map.get(groupKey)!.push({ project, relPath: rel });
    }

    // Sort groups: root (".") first, then alphabetically
    const sorted = [...map.entries()].sort(([a], [b]) => {
      if (a === ".") return -1;
      if (b === ".") return 1;
      return a.localeCompare(b);
    });

    return sorted;
  }, [projects, scanRoot]);

  // Build flat row list for navigation (respecting collapsed state)
  const rows = useMemo((): Row[] => {
    const result: Row[] = [];
    for (const [groupPath, items] of groups) {
      const selectedCount = items.filter((i) =>
        selected.has(i.project.id)
      ).length;

      result.push({
        kind: "group",
        path: groupPath,
        count: items.length,
        selectedCount,
      });

      if (!collapsed.has(groupPath)) {
        for (const item of items) {
          result.push({
            kind: "project",
            project: item.project,
            relPath: item.relPath,
          });
        }
      }
    }
    return result;
  }, [groups, collapsed, selected]);

  // Visible window
  const windowSize = Math.min(20, rows.length);
  const halfWindow = Math.floor(windowSize / 2);
  let start = Math.max(0, cursor - halfWindow);
  const end = Math.min(rows.length, start + windowSize);
  if (end === rows.length) start = Math.max(0, end - windowSize);
  const visible = rows.slice(start, end);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : rows.length - 1));
    } else if (key.downArrow) {
      setCursor((c) => (c < rows.length - 1 ? c + 1 : 0));
    } else if (input === " ") {
      const row = rows[cursor];
      if (!row) return;

      if (row.kind === "group") {
        // Toggle all projects in this group
        const groupItems = groups.find(([p]) => p === row.path)?.[1];
        if (!groupItems) return;
        const groupIds = groupItems.map((i) => i.project.id);
        const allSelected = groupIds.every((id) => selected.has(id));

        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of groupIds) {
            if (allSelected) next.delete(id);
            else next.add(id);
          }
          return next;
        });
      } else {
        // Toggle single project
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(row.project.id)) next.delete(row.project.id);
          else next.add(row.project.id);
          return next;
        });
      }
    } else if (key.return) {
      const row = rows[cursor];
      // Enter on a group header collapses/expands it
      if (row?.kind === "group") {
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(row.path)) next.delete(row.path);
          else next.add(row.path);
          return next;
        });
        return;
      }
      // Enter elsewhere submits
      const result = projects.filter((p) => selected.has(p.id));
      onSubmit(result);
    } else if (input === "a") {
      if (selected.size === projects.length) {
        setSelected(new Set());
      } else {
        setSelected(new Set(projects.map((p) => p.id)));
      }
    } else if (input === "s") {
      // Submit (alternative to Enter, unambiguous)
      const result = projects.filter((p) => selected.has(p.id));
      onSubmit(result);
    } else if (input === "q" || key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text bold>
          Select projects for CV ({selected.size}/{projects.length})
        </Text>
        <Text dimColor>
          [Space] toggle  [Enter] expand/collapse group  [s] submit  [a] all  [q] quit
        </Text>
      </Box>

      {visible.map((row, i) => {
        const globalIndex = start + i;
        const isCursor = globalIndex === cursor;

        if (row.kind === "group") {
          const isCollapsed = collapsed.has(row.path);
          const arrow = isCollapsed ? "▸" : "▾";
          const label = row.path === "." ? "(root)" : row.path + "/";
          const countLabel = `[${row.selectedCount}/${row.count}]`;

          return (
            <Box key={`g-${row.path}`} gap={1}>
              <Text
                color={isCursor ? "cyan" : "white"}
                bold
                inverse={isCursor}
              >
                {arrow} {label}
              </Text>
              <Text
                color={
                  row.selectedCount === row.count
                    ? "green"
                    : row.selectedCount > 0
                      ? "yellow"
                      : "gray"
                }
              >
                {countLabel}
              </Text>
            </Box>
          );
        }

        // Project row
        const isSelected = selected.has(row.project.id);
        const checkbox = isSelected ? "[x]" : "[ ]";
        const dateStr = row.project.dateRange.start
          ? `${row.project.dateRange.approximate ? "~" : ""}${row.project.dateRange.start}`
          : "?";
        const secrets =
          row.project.privacyAudit?.secretsFound ?? 0;

        return (
          <Box key={row.project.id} gap={1}>
            <Text color={isCursor ? "cyan" : undefined} inverse={isCursor}>
              {"    "}{checkbox} {row.project.displayName}
            </Text>
            <Text dimColor>
              {row.project.language}
              {row.project.commitCount > 0
                ? ` (${row.project.commitCount})`
                : ""}
              {" "}
              {dateStr}
            </Text>
            {secrets > 0 && <Text color="yellow">!</Text>}
          </Box>
        );
      })}

      {rows.length > windowSize && (
        <Text dimColor>
          {"\n"}
          {start + 1}-{end} of {rows.length} rows
        </Text>
      )}
    </Box>
  );
}
