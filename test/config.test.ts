import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { readInventory, writeInventory } from "../src/lib/inventory/store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

beforeEach(async () => {
  process.env.AGENT_CV_DATA_DIR = await mkdtemp(join(tmpdir(), "agent-cv-test-"));
});

afterAll(() => {
  delete process.env.AGENT_CV_DATA_DIR;
});

describe("inventory profile (was config)", () => {
  test("readInventory returns default profile when no file", async () => {
    const inv = await readInventory();
    expect(inv.profile.emails).toEqual([]);
    expect(inv.profile.emailsConfirmed).toBe(false);
    expect(inv.insights).toEqual({});
  });

  test("writeInventory and readInventory roundtrip profile", async () => {
    const inv = await readInventory();
    inv.profile.emails = ["test@example.com", "work@company.com"];
    inv.profile.emailsConfirmed = true;
    await writeInventory(inv);
    const read = await readInventory();
    expect(read.profile.emails).toEqual(["test@example.com", "work@company.com"]);
    expect(read.profile.emailsConfirmed).toBe(true);
  });

  test("insights persist through roundtrip", async () => {
    const inv = await readInventory();
    inv.insights = {
      bio: "Full-stack developer with 10 years of experience.",
      highlights: ["project-a"],
      narrative: "Started with frontend, evolved to full-stack.",
      strongestSkills: ["TypeScript", "System Design"],
      uniqueTraits: ["Fast learner"],
    };
    await writeInventory(inv);
    const read = await readInventory();
    expect(read.insights.bio).toBe("Full-stack developer with 10 years of experience.");
    expect(read.insights.highlights).toEqual(["project-a"]);
    expect(read.insights.strongestSkills).toEqual(["TypeScript", "System Design"]);
  });
});
