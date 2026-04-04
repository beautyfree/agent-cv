#!/usr/bin/env bun
import { Command } from "commander";
import { render } from "ink";
import React from "react";

const program = new Command()
  .name("agent-cv")
  .version("0.1.0")
  .description("Generate technical CVs from your local project directories using AI");

// scan
program
  .command("scan")
  .description("Scan a directory tree for software projects")
  .argument("<directory>", "Directory to scan for projects")
  .option("--verbose", "Show detailed scan progress", false)
  .option("--json", "Output raw JSON instead of formatted text", false)
  .option("--email <emails>", "Additional git email to recognize as yours (comma-separated)")
  .action(async (directory: string, opts: any) => {
    const { default: Scan } = await import("./commands/scan.tsx");
    render(React.createElement(Scan, { args: [directory], options: opts }));
  });

// analyze
program
  .command("analyze")
  .description("Analyze a single project using an AI agent")
  .argument("<path>", "Path to the project to analyze")
  .option("--agent <name>", "Agent to use: auto, claude, codex, cursor, api", "auto")
  .action(async (path: string, opts: any) => {
    const { default: Analyze } = await import("./commands/analyze.tsx");
    render(React.createElement(Analyze, { args: [path], options: opts }));
  });

// generate
program
  .command("generate")
  .description("Full flow: scan directory, analyze projects with AI, generate markdown CV")
  .argument("<directory>", "Directory to scan for projects")
  .option("--output <file>", "Output file path (default: stdout)")
  .option("--agent <name>", "Agent to use: auto, claude, codex, cursor, api", "auto")
  .option("--no-cache", "Force fresh analysis, ignore cache")
  .option("--dry-run", "Show what would be sent to the LLM without sending", false)
  .option("--all", "Skip interactive selection, analyze all projects", false)
  .option("--email <emails>", "Email(s) to filter by, for generating someone else's CV (comma-separated)")
  .action(async (directory: string, opts: any) => {
    // Commander uses --no-cache → opts.cache = false
    const options = {
      ...opts,
      noCache: opts.cache === false,
      dryRun: opts.dryRun || false,
    };
    const { default: Generate } = await import("./commands/generate.tsx");
    render(React.createElement(Generate, { args: [directory], options }));
  });

// diff
program
  .command("diff")
  .description("Show what changed since last scan")
  .argument("<directory>", "Directory to scan and compare against last inventory")
  .action(async (directory: string, opts: any) => {
    const { default: Diff } = await import("./commands/diff.tsx");
    render(React.createElement(Diff, { args: [directory], options: opts }));
  });

// stats
program
  .command("stats")
  .description("Show tech stack evolution timeline and language breakdown")
  .action(async (opts: any) => {
    const { default: Stats } = await import("./commands/stats.tsx");
    render(React.createElement(Stats, { options: opts }));
  });

// publish
program
  .command("publish")
  .description("Publish your portfolio to agent-cv.dev")
  .option("--bio <text>", "Custom bio/headline for your portfolio")
  .action(async (opts: any) => {
    const { default: Publish } = await import("./commands/publish.tsx");
    render(React.createElement(Publish, { options: opts }));
  });

// unpublish
program
  .command("unpublish")
  .description("Remove your portfolio from agent-cv.dev")
  .action(async () => {
    const { default: Unpublish } = await import("./commands/unpublish.tsx");
    render(React.createElement(Unpublish, {}));
  });

await program.parseAsync();
