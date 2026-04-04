import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { readInventory, writeInventory } from "../src/lib/inventory/store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpHome: string;
const originalHome = process.env.HOME;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "agent-cv-test-"));
  process.env.HOME = tmpHome;
});

afterAll(() => {
  process.env.HOME = originalHome;
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
