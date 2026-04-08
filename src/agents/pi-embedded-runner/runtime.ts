export type EmbeddedAgentRuntime = "pi" | "codex-app-server" | "auto";

export function resolveEmbeddedAgentRuntime(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddedAgentRuntime {
  const raw = env.OPENCLAW_AGENT_RUNTIME?.trim();
  if (!raw) {
    return "auto";
  }
  if (raw === "pi") {
    return "pi";
  }
  if (raw === "codex-app-server" || raw === "codex" || raw === "app-server") {
    return "codex-app-server";
  }
  if (raw === "auto") {
    return "auto";
  }
  return "pi";
}
