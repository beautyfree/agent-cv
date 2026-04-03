import React, { useEffect, useState } from "react";
import { Text, Box } from "ink";
import { z } from "zod/v4";
import { readInventory } from "../lib/inventory/store.ts";
import type { Inventory } from "../lib/types.ts";

export const options = z.object({});

type Props = {
  options: z.infer<typeof options>;
};

export default function Stats({}: Props) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const inv = await readInventory();
        if (inv.projects.length === 0) {
          setError("No projects in inventory. Run 'llm-cv scan' first.");
          return;
        }
        setInventory(inv);
      } catch (err: any) {
        setError(err.message);
      }
    }
    load();
  }, []);

  if (error) return <Text color="red">Error: {error}</Text>;
  if (!inventory) return <Text color="yellow">Loading inventory...</Text>;

  const projects = inventory.projects.filter((p) => !p.tags.includes("removed"));

  // Group by year and primary language
  const byYear = new Map<string, Map<string, number>>();
  for (const p of projects) {
    const year = (p.dateRange.end || p.dateRange.start || "").split("-")[0] || "Unknown";
    if (!byYear.has(year)) byYear.set(year, new Map());
    const langs = byYear.get(year)!;
    langs.set(p.language, (langs.get(p.language) || 0) + 1);
  }

  // Sort years
  const years = [...byYear.keys()].sort();

  // Overall language counts
  const langTotals = new Map<string, number>();
  for (const p of projects) {
    langTotals.set(p.language, (langTotals.get(p.language) || 0) + 1);
  }
  const sortedLangs = [...langTotals.entries()].sort((a, b) => b[1] - a[1]);
  const totalProjects = projects.length;

  // Framework counts
  const fwCounts = new Map<string, number>();
  for (const p of projects) {
    for (const fw of p.frameworks) {
      fwCounts.set(fw, (fwCounts.get(fw) || 0) + 1);
    }
  }
  const sortedFw = [...fwCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // My projects vs forks
  const myProjects = projects.filter(
    (p) => p.authorCommitCount > 0 || !p.hasGit || p.commitCount === 0 || p.hasUncommittedChanges
  ).length;

  return (
    <Box flexDirection="column">
      <Text bold>Tech Evolution</Text>
      <Text> </Text>
      {years.map((year) => {
        const langs = byYear.get(year)!;
        const sorted = [...langs.entries()].sort((a, b) => b[1] - a[1]);
        const parts = sorted.map(([lang, count]) => `${lang} (${count})`).join(", ");
        return (
          <Box key={year} gap={1}>
            <Text color="cyan" bold>{year}:</Text>
            <Text>{parts}</Text>
          </Box>
        );
      })}

      <Text> </Text>
      <Text bold>Languages</Text>
      <Text> </Text>
      {sortedLangs.map(([lang, count]) => {
        const pct = Math.round((count / totalProjects) * 100);
        const bar = "█".repeat(Math.max(1, Math.round(pct / 3)));
        return (
          <Box key={lang} gap={1}>
            <Text>{lang.padEnd(12)}</Text>
            <Text color="green">{bar}</Text>
            <Text dimColor> {pct}% ({count})</Text>
          </Box>
        );
      })}

      {sortedFw.length > 0 && (
        <>
          <Text> </Text>
          <Text bold>Top Frameworks</Text>
          <Text> </Text>
          {sortedFw.map(([fw, count]) => (
            <Box key={fw} gap={1}>
              <Text>{fw.padEnd(12)}</Text>
              <Text dimColor>{count} {count === 1 ? "project" : "projects"}</Text>
            </Box>
          ))}
        </>
      )}

      <Text> </Text>
      <Text bold>Summary</Text>
      <Text>
        {totalProjects} projects | {myProjects} yours | {totalProjects - myProjects} forks/clones | {sortedLangs.length} languages | {years[0]} — {years[years.length - 1]}
      </Text>
    </Box>
  );
}

export const description = "Show tech stack evolution timeline and language breakdown";
