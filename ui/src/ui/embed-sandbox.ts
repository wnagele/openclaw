import type { ControlUiEmbedSandboxMode } from "../../../src/gateway/control-ui-contract.js";

export type EmbedSandboxMode = ControlUiEmbedSandboxMode;

export function resolveEmbedSandbox(mode: EmbedSandboxMode | null | undefined): string {
  return mode === "isolated" ? "allow-scripts" : "allow-scripts allow-same-origin";
}
