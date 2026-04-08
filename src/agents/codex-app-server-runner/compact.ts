import type { CompactEmbeddedPiSessionParams } from "../pi-embedded-runner/compact.js";
import { log } from "../pi-embedded-runner/logger.js";
import { resolveEmbeddedAgentRuntime } from "../pi-embedded-runner/runtime.js";
import type { EmbeddedPiCompactResult } from "../pi-embedded-runner/types.js";
import { getSharedCodexAppServerClient, type CodexAppServerClient } from "./client.js";
import { readCodexAppServerBinding } from "./session-binding.js";

type CodexAppServerClientFactory = () => Promise<CodexAppServerClient>;

let clientFactory: CodexAppServerClientFactory = getSharedCodexAppServerClient;

export async function maybeCompactCodexAppServerSession(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult | undefined> {
  const runtime = resolveEmbeddedAgentRuntime();
  const shouldUseCodex =
    runtime === "codex-app-server" || (runtime === "auto" && params.provider === "openai-codex");
  if (!shouldUseCodex) {
    return undefined;
  }

  const binding = await readCodexAppServerBinding(params.sessionFile);
  if (!binding?.threadId) {
    if (runtime === "codex-app-server") {
      return { ok: false, compacted: false, reason: "no codex app-server thread binding" };
    }
    return undefined;
  }

  const client = await clientFactory();
  await client.request("thread/compact/start", {
    threadId: binding.threadId,
  });
  log.info("started codex app-server compaction", {
    sessionId: params.sessionId,
    threadId: binding.threadId,
  });
  return {
    ok: true,
    compacted: true,
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: params.currentTokenCount ?? 0,
      details: {
        backend: "codex-app-server",
        threadId: binding.threadId,
      },
    },
  };
}

export const __testing = {
  setCodexAppServerClientFactoryForTests(factory: CodexAppServerClientFactory): void {
    clientFactory = factory;
  },
  resetCodexAppServerClientFactoryForTests(): void {
    clientFactory = getSharedCodexAppServerClient;
  },
} as const;
