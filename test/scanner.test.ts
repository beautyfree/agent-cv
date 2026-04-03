import { describe, test, expect, beforeAll } from "bun:test";
import { scanDirectory } from "../src/lib/discovery/scanner.ts";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures");

beforeAll(async () => {
  // Create fixture: node project
  const nodeDir = join(FIXTURES, "sample-node-project");
  await mkdir(nodeDir, { recursive: true });
  await writeFile(
    join(nodeDir, "package.json"),
    JSON.stringify({ name: "sample", dependencies: { react: "^18" } })
  );
  await writeFile(join(nodeDir, "index.ts"), "console.log('hello')");

  // Create fixture: python project
  const pyDir = join(FIXTURES, "sample-python-project");
  await mkdir(pyDir, { recursive: true });
  await writeFile(join(pyDir, "requirements.txt"), "flask==3.0\nrequests==2.31");

  // Create fixture: project with secrets
  const secretDir = join(FIXTURES, "project-with-secrets");
  await mkdir(secretDir, { recursive: true });
  await writeFile(
    join(secretDir, "package.json"),
    JSON.stringify({ name: "secrets-test" })
  );
  await writeFile(join(secretDir, ".env"), "API_KEY=sk-1234567890");
  await writeFile(join(secretDir, "config.ts"), 'const key = "sk-abcdef1234567890abcdef"');

  // Create fixture: empty dir
  await mkdir(join(FIXTURES, "empty-dir"), { recursive: true });
});

describe("scanDirectory", () => {
  test("finds node project by package.json", async () => {
    const result = await scanDirectory(join(FIXTURES, "sample-node-project"));
    expect(result.projects.length).toBe(1);
    expect(result.projects[0]!.type).toBe("node");
    expect(result.projects[0]!.language).toBe("JavaScript");
  });

  test("finds python project by requirements.txt", async () => {
    const result = await scanDirectory(join(FIXTURES, "sample-python-project"));
    expect(result.projects.length).toBe(1);
    expect(result.projects[0]!.type).toBe("python");
    expect(result.projects[0]!.language).toBe("Python");
  });

  test("returns empty for empty directory", async () => {
    const result = await scanDirectory(join(FIXTURES, "empty-dir"));
    expect(result.projects.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("returns error for non-existent directory", async () => {
    const result = await scanDirectory(join(FIXTURES, "does-not-exist"));
    expect(result.projects.length).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("finds multiple projects in parent directory", async () => {
    const result = await scanDirectory(FIXTURES);
    expect(result.projects.length).toBeGreaterThanOrEqual(3);
  });

  test("detects secrets in privacy audit", async () => {
    const result = await scanDirectory(join(FIXTURES, "project-with-secrets"));
    expect(result.projects.length).toBe(1);
    const project = result.projects[0]!;
    expect(project.privacyAudit).toBeDefined();
    expect(project.privacyAudit!.secretsFound).toBeGreaterThan(0);
    expect(project.privacyAudit!.excludedFiles).toContain(".env");
  });
});
