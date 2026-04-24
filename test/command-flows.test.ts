import { describe, it, expect } from "bun:test";
import { createActor } from "xstate";
import { loginFlowMachine } from "../src/commands/login/login.machine.ts";
import { unpublishFlowMachine } from "../src/commands/unpublish/unpublish.machine.ts";
import { publishFlowMachine } from "../src/commands/publish/publish.machine.ts";
import { generateFlowMachine } from "../src/commands/generate/generate.machine.ts";
import { diffFlowMachine } from "../src/commands/diff/diff.machine.ts";
import { statsFlowMachine } from "../src/commands/stats/stats.machine.ts";
import { configFlowMachine } from "../src/commands/config/config.machine.ts";

const token = { jwt: "jwt", username: "u", obtainedAt: "2020-01-01T00:00:00.000Z" };

describe("loginFlowMachine", () => {
  it("goes to failed on AUTH_FAIL", () => {
    const actor = createActor(loginFlowMachine, { input: {} });
    actor.start();
    actor.send({ type: "AUTH_FAIL", message: "nope" });
    expect(actor.getSnapshot().matches("failed")).toBe(true);
    expect(actor.getSnapshot().context.error).toBe("nope");
  });

  it("reaches done on AUTH_OK", () => {
    const actor = createActor(loginFlowMachine, { input: {} });
    actor.start();
    actor.send({ type: "AUTH_OK", token });
    expect(actor.getSnapshot().matches("done")).toBe(true);
  });
});

describe("unpublishFlowMachine", () => {
  it("moves from awaitingAuth to deleting on AUTH_OK", () => {
    const actor = createActor(unpublishFlowMachine, { input: {} });
    actor.start();
    expect(actor.getSnapshot().matches("awaitingAuth")).toBe(true);
    actor.send({ type: "AUTH_OK", token });
    expect(actor.getSnapshot().matches("deleting")).toBe(true);
    expect(actor.getSnapshot().context.jwt).toBe("jwt");
  });
});

describe("publishFlowMachine", () => {
  it("requires AUTH_OK before pipeline; jwt is set on context", () => {
    const actor = createActor(publishFlowMachine, {
      input: { directory: "/tmp", options: { yes: true } },
    });
    actor.start();
    expect(actor.getSnapshot().matches("awaitingAuth")).toBe(true);
    expect(actor.getSnapshot().context.jwt).toBe("");
    actor.send({ type: "AUTH_OK", token });
    const snap = actor.getSnapshot();
    expect(snap.matches("runningPipeline")).toBe(true);
    expect(snap.context.jwt).toBe("jwt");
  });

  it("PIPELINE_ERROR from runningPipeline reaches failed with message (onError contract)", () => {
    const actor = createActor(publishFlowMachine, {
      input: { directory: "/tmp", options: { yes: true } },
    });
    actor.start();
    actor.send({ type: "AUTH_OK", token });
    expect(actor.getSnapshot().matches("runningPipeline")).toBe(true);
    actor.send({ type: "PIPELINE_ERROR", message: "scan failed" });
    const snap = actor.getSnapshot();
    expect(snap.matches("failed")).toBe(true);
    expect(snap.context.error).toBe("scan failed");
  });

  it("does not enter publishing without AUTH_OK (stays in awaitingAuth on irrelevant events)", () => {
    const actor = createActor(publishFlowMachine, {
      input: { directory: "/tmp", options: { yes: true } },
    });
    actor.start();
    actor.send({
      type: "PIPELINE_ERROR",
      message: "should not apply",
    } as never);
    expect(actor.getSnapshot().matches("awaitingAuth")).toBe(true);
  });

  it("routes to resolving when --fresh and no directory (full rescan instead of cache)", () => {
    const actor = createActor(publishFlowMachine, {
      input: { directory: undefined, options: { fresh: true, yes: true } },
    });
    actor.start();
    actor.send({ type: "AUTH_OK", token });
    expect(actor.getSnapshot().matches("resolving")).toBe(true);
  });
});

describe("generateFlowMachine", () => {
  it("PIPELINE_ERROR from runningPipeline reaches failed with message", () => {
    const actor = createActor(generateFlowMachine, {
      input: { directory: "/projects", options: {} },
    });
    actor.start();
    actor.send({ type: "AUTH_SKIPPED" });
    expect(actor.getSnapshot().matches("runningPipeline")).toBe(true);
    actor.send({ type: "PIPELINE_ERROR", message: "pipeline boom" });
    const snap = actor.getSnapshot();
    expect(snap.matches("failed")).toBe(true);
    expect(snap.context.error).toBe("pipeline boom");
  });
});

describe("diffFlowMachine / statsFlowMachine", () => {
  it("diffFlowMachine starts in running", () => {
    const actor = createActor(diffFlowMachine, { input: { directory: "/tmp" } });
    actor.start();
    expect(actor.getSnapshot().matches("running")).toBe(true);
  });

  it("statsFlowMachine starts in running", () => {
    const actor = createActor(statsFlowMachine, { input: {} });
    actor.start();
    expect(actor.getSnapshot().matches("running")).toBe(true);
  });
});

describe("configFlowMachine", () => {
  it("starts in loading", () => {
    const actor = createActor(configFlowMachine, { input: {} });
    actor.start();
    expect(actor.getSnapshot().matches("loading")).toBe(true);
  });
});
