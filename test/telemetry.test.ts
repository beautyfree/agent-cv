import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

beforeEach(async () => {
  process.env.AGENT_CV_DATA_DIR = await mkdtemp(join(tmpdir(), "agent-cv-tel-"));
});

afterAll(() => {
  delete process.env.AGENT_CV_DATA_DIR;
});

describe("telemetry", () => {
  test("disabled by env var", async () => {
    process.env.AGENT_CV_TELEMETRY = "off";
    const { isTelemetryEnabled } = await import("../src/lib/telemetry.ts");
    expect(await isTelemetryEnabled()).toBe(false);
    delete process.env.AGENT_CV_TELEMETRY;
  });

  test("enabled by default when no state file", async () => {
    const { isTelemetryEnabled } = await import("../src/lib/telemetry.ts");
    expect(await isTelemetryEnabled()).toBe(true);
  });

  test("markNoticeSeen returns false first time, true after", async () => {
    const { markNoticeSeen } = await import("../src/lib/telemetry.ts");
    const first = await markNoticeSeen();
    expect(first).toBe(false);
    const second = await markNoticeSeen();
    expect(second).toBe(true);
  });

  test("setTelemetryEnabled persists", async () => {
    const { setTelemetryEnabled, isTelemetryEnabled } = await import("../src/lib/telemetry.ts");
    await setTelemetryEnabled(false);
    expect(await isTelemetryEnabled()).toBe(false);
    await setTelemetryEnabled(true);
    expect(await isTelemetryEnabled()).toBe(true);
  });

  test("track is no-op when disabled", async () => {
    const { setTelemetryEnabled, track } = await import("../src/lib/telemetry.ts");
    await setTelemetryEnabled(false);
    // Should not throw
    await track("test_event", { foo: "bar" });
  });
});
