#!/usr/bin/env bun
import { Command } from "commander";
import { render } from "ink";
import React from "react";

const program = new Command()
  .name("agent-cv")
  .version("0.1.0")
  .description("Generate technical CVs from your local project directories using AI");

// generate
program
  .command("generate")
  .description("Full flow: scan directory, analyze projects with AI, generate markdown CV")
  .argument("[directory]", "Directory to scan (re-scans known paths if omitted)")
  .option("--output <file>", "Output file path (default: stdout)")
  .option("--agent <name>", "Agent to use: auto, claude, codex, cursor, api", "auto")
  .option("--no-cache", "Force fresh analysis, ignore cache")
  .option("--dry-run", "Show what would be sent to the LLM without sending", false)
  .option("--all", "Skip interactive selection, analyze all projects", false)
  .option("--email <emails>", "Email(s) to filter by, for generating someone else's CV (comma-separated)")
  .option("--github <username>", "Scan GitHub repos for this user (requires GITHUB_TOKEN env var)")
  .option("--include-forks", "Include forked repos when scanning GitHub", false)
  .option("-i, --interactive", "Force all interactive pickers (email, projects, agent)", false)
  .option("-y, --yes", "Auto-confirm publish offer", false)
  .action(async (directory: string | undefined, opts: any) => {
    const options = {
      ...opts,
      noCache: opts.cache === false,
      dryRun: opts.dryRun || false,
    };
    const { default: Generate } = await import("./commands/generate.tsx");
    render(React.createElement(Generate, { args: [directory || ""], options }));
  });

// publish
program
  .command("publish")
  .description("Scan, analyze, and publish your portfolio to agent-cv.dev")
  .argument("[directory]", "Directory to scan (uses existing inventory if omitted)")
  .option("--bio <text>", "Custom bio/headline for your portfolio")
  .option("--no-open", "Don't open browser after publishing")
  .option("--all", "Skip project picker, include everything", false)
  .option("--agent <name>", "Agent to use: auto, claude, codex, cursor, api", "auto")
  .option("--email <emails>", "Email(s) to filter by (comma-separated)")
  .option("--github <username>", "Scan GitHub repos for this user (requires GITHUB_TOKEN env var)")
  .option("--include-forks", "Include forked repos when scanning GitHub", false)
  .option("-y, --yes", "Skip confirmation prompt", false)
  .action(async (directory: string | undefined, opts: any) => {
    const { default: Publish } = await import("./commands/publish.tsx");
    render(React.createElement(Publish, { args: directory ? [directory] : [], options: opts }));
  });

// unpublish
program
  .command("unpublish")
  .description("Remove your portfolio from agent-cv.dev")
  .action(async () => {
    const { default: Unpublish } = await import("./commands/unpublish.tsx");
    render(React.createElement(Unpublish, {}));
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
  .argument("[directory]", "Directory to scan (uses existing inventory if omitted)")
  .action(async (directory: string | undefined, opts: any) => {
    const { default: Stats } = await import("./commands/stats.tsx");
    render(React.createElement(Stats, { args: directory ? [directory] : [], options: opts }));
  });

// config
program
  .command("config")
  .description("Edit your profile: name, bio, socials, email privacy")
  .action(async (opts: any) => {
    const { default: ConfigCmd } = await import("./commands/config.tsx");
    render(React.createElement(ConfigCmd, { options: opts }));
  });

await program.parseAsync();
