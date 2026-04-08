import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptParams } from "../pi-embedded-runner/run/types.js";
import {
  queueEmbeddedPiMessage,
  abortEmbeddedPiRun,
  __testing as runsTesting,
} from "../pi-embedded-runner/runs.js";
import { runCodexAppServerAttempt, __testing } from "./run-attempt.js";

let tempDir: string;

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "openai-codex",
    modelId: "gpt-5.4-codex",
    model: {
      id: "gpt-5.4-codex",
      name: "gpt-5.4-codex",
      provider: "openai-codex",
      api: "openai-codex-responses",
      input: ["text"],
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_000,
    } as Model<Api>,
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

describe("runCodexAppServerAttempt", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-run-"));
  });

  afterEach(async () => {
    __testing.resetCodexAppServerClientFactoryForTests();
    runsTesting.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("forwards queued user input and aborts the active app-server turn", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "thread-1" }, model: "gpt-5.4-codex", modelProvider: "openai" };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: () => () => undefined,
          addRequestHandler: () => () => undefined,
        }) as never,
    );

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await vi.waitFor(() =>
      expect(requests.some((entry) => entry.method === "turn/start")).toBe(true),
    );

    expect(queueEmbeddedPiMessage("session-1", "more context")).toBe(true);
    await vi.waitFor(() =>
      expect(requests.some((entry) => entry.method === "turn/steer")).toBe(true),
    );
    expect(abortEmbeddedPiRun("session-1")).toBe(true);
    await vi.waitFor(() =>
      expect(requests.some((entry) => entry.method === "turn/interrupt")).toBe(true),
    );

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          method: "turn/steer",
          params: {
            threadId: "thread-1",
            expectedTurnId: "turn-1",
            input: [{ type: "text", text: "more context" }],
          },
        },
        {
          method: "turn/interrupt",
          params: { threadId: "thread-1", turnId: "turn-1" },
        },
      ]),
    );
  });
});
