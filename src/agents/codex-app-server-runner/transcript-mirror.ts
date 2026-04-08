import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";

export async function mirrorCodexAppServerTranscript(params: {
  sessionFile: string;
  sessionKey?: string;
  messages: AgentMessage[];
}): Promise<void> {
  const messages = params.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (messages.length === 0) {
    return;
  }

  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const lock = await acquireSessionWriteLock({
    sessionFile: params.sessionFile,
    timeoutMs: 10_000,
  });
  try {
    const sessionManager = SessionManager.open(params.sessionFile);
    for (const message of messages) {
      sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
    }
  } finally {
    await lock.release();
  }

  if (params.sessionKey) {
    emitSessionTranscriptUpdate({ sessionFile: params.sessionFile, sessionKey: params.sessionKey });
  } else {
    emitSessionTranscriptUpdate(params.sessionFile);
  }
}
