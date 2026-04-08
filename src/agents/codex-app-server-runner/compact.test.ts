import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeCompactCodexAppServerSession, __testing } from "./compact.js";
import { writeCodexAppServerBinding } from "./session-binding.js";

const OLD_RUNTIME = process.env.OPENCLAW_AGENT_RUNTIME;

let tempDir: string;

describe("maybeCompactCodexAppServerSession", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-compact-"));
    process.env.OPENCLAW_AGENT_RUNTIME = "codex-app-server";
  });

  afterEach(async () => {
    __testing.resetCodexAppServerClientFactoryForTests();
    if (OLD_RUNTIME === undefined) {
      delete process.env.OPENCLAW_AGENT_RUNTIME;
    } else {
      process.env.OPENCLAW_AGENT_RUNTIME = OLD_RUNTIME;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("starts app-server compaction for a bound session", async () => {
    const request = vi.fn(async () => ({}));
    __testing.setCodexAppServerClientFactoryForTests(async () => ({ request }) as never);
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
      currentTokenCount: 123,
    });

    expect(request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    expect(result).toMatchObject({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 123,
        details: { backend: "codex-app-server", threadId: "thread-1" },
      },
    });
  });
});
