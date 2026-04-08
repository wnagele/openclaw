import { runCodexAppServerAttempt } from "../../codex-app-server-runner/run-attempt.js";
import { log } from "../logger.js";
import { resolveEmbeddedAgentRuntime } from "../runtime.js";
import { runEmbeddedAttempt } from "./attempt.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

export async function runEmbeddedAttemptWithBackend(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const runtime = resolveEmbeddedAgentRuntime();
  const shouldUseCodexAppServer =
    runtime === "codex-app-server" || (runtime === "auto" && params.provider === "openai-codex");
  if (!shouldUseCodexAppServer) {
    return runEmbeddedAttempt(params);
  }
  try {
    return await runCodexAppServerAttempt(params);
  } catch (error) {
    if (runtime === "codex-app-server") {
      throw error;
    }
    log.warn("codex app-server backend failed; falling back to embedded PI backend", { error });
    return runEmbeddedAttempt(params);
  }
}
