import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { relative } from "node:path";
import type { Project } from "../lib/types.ts";

interface Props {
  projects: Project[];
  scanRoot: string;
  onSubmit: (selected: Project[]) => void;
}

/**
 * Interactive multi-select for choosing which projects to include in CV.
 * Shows relative path from scan root so users can distinguish
 * archive/my-app from active/my-app.
 *
 * Arrow keys to navigate, Space to toggle, Enter to confirm,
 * 'a' to toggle all, 'q' to quit.
 */
export function ProjectSelector({ projects, scanRoot, onSubmit }: Props) {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(projects.map((p) => p.id))
  );

  // Visible window (show 15 items at a time)
  const windowSize = Math.min(15, projects.length);
  const halfWindow = Math.floor(windowSize / 2);
  let start = Math.max(0, cursor - halfWindow);
  const end = Math.min(projects.length, start + windowSize);
  if (end === projects.length) start = Math.max(0, end - windowSize);

  const visible = projects.slice(start, end);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : projects.length - 1));
    } else if (key.downArrow) {
      setCursor((c) => (c < projects.length - 1 ? c + 1 : 0));
    } else if (input === " ") {
      const id = projects[cursor]?.id;
      if (!id) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else if (input === "a") {
      if (selected.size === projects.length) {
        setSelected(new Set());
      } else {
        setSelected(new Set(projects.map((p) => p.id)));
      }
    } else if (key.return) {
      const result = projects.filter((p) => selected.has(p.id));
      onSubmit(result);
    } else if (input === "q" || key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          Select projects for CV ({selected.size}/{projects.length})
        </Text>
        <Text dimColor>
          {"  "}[Space] toggle, [a] all, [Enter] confirm, [q] quit
        </Text>
      </Box>

      {visible.map((project, i) => {
        const globalIndex = start + i;
        const isSelected = selected.has(project.id);
        const isCursor = globalIndex === cursor;
        const checkbox = isSelected ? "[x]" : "[ ]";

        // Show relative path from scan root
        const relPath = relative(scanRoot, project.path);
        // If the project is directly in the scan root, just show the name
        // If nested, show the full relative path (e.g. "archive/old-app")
        const displayPath = relPath || project.displayName;

        const dateStr = project.dateRange.start
          ? `${project.dateRange.approximate ? "~" : ""}${project.dateRange.start}`
          : "?";

        return (
          <Box key={project.id} gap={1}>
            <Text
              color={isCursor ? "cyan" : undefined}
              bold={isCursor}
              inverse={isCursor}
            >
              {checkbox} {displayPath}
            </Text>
            <Text dimColor>
              {project.language}
              {project.commitCount > 0 ? ` (${project.commitCount})` : ""}
              {" "}
              {dateStr}
            </Text>
            {project.privacyAudit && project.privacyAudit.secretsFound > 0 && (
              <Text color="yellow">!</Text>
            )}
          </Box>
        );
      })}

      {projects.length > windowSize && (
        <Text dimColor>
          {"\n"}Showing {start + 1}-{end} of {projects.length}
        </Text>
      )}
    </Box>
  );
}
