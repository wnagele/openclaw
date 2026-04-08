import { describe, expect, it } from "vitest";
import { resolveEmbeddedAgentRuntime } from "../runtime.js";

describe("resolveEmbeddedAgentRuntime", () => {
  it("uses auto mode by default", () => {
    expect(resolveEmbeddedAgentRuntime({})).toBe("auto");
  });

  it("accepts the PI kill switch", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "pi" })).toBe("pi");
  });

  it("accepts codex app-server aliases", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "codex-app-server" })).toBe(
      "codex-app-server",
    );
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "codex" })).toBe(
      "codex-app-server",
    );
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "app-server" })).toBe(
      "codex-app-server",
    );
  });

  it("accepts auto mode", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "auto" })).toBe("auto");
  });
});
