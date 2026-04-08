import fs from "node:fs/promises";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { resolveModelAuthMode } from "../model-auth.js";
import { supportsModelTools } from "../model-tool-support.js";
import { log } from "../pi-embedded-runner/logger.js";
import { resolveAttemptSpawnWorkspaceDir } from "../pi-embedded-runner/run/attempt.thread-helpers.js";
import { buildEmbeddedAttemptToolRunContext } from "../pi-embedded-runner/run/attempt.tool-run-context.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../pi-embedded-runner/runs.js";
import { normalizeProviderToolSchemas } from "../pi-embedded-runner/tool-schema-runtime.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import { resolveSandboxContext } from "../sandbox.js";
import { getSharedCodexAppServerClient, type CodexAppServerClient } from "./client.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  isJsonObject,
  type CodexDynamicToolCallParams,
  type CodexThreadResumeResponse,
  type CodexThreadStartResponse,
  type CodexTurnStartResponse,
  type CodexUserInput,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { mirrorCodexAppServerTranscript } from "./transcript-mirror.js";

type CodexAppServerClientFactory = () => Promise<CodexAppServerClient>;

let clientFactory: CodexAppServerClientFactory = getSharedCodexAppServerClient;

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await fs.mkdir(resolvedWorkspace, { recursive: true });
  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });

  const runAbortController = new AbortController();
  params.abortSignal?.addEventListener(
    "abort",
    () => {
      runAbortController.abort(params.abortSignal?.reason ?? "upstream_abort");
    },
    { once: true },
  );

  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const tools = await buildDynamicTools({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    sandboxSessionKey,
    sandbox,
    runAbortController,
    sessionAgentId,
  });
  const toolBridge = createCodexDynamicToolBridge({
    tools,
    signal: runAbortController.signal,
  });
  const client = await clientFactory();
  const thread = await startOrResumeThread({
    client,
    params,
    cwd: effectiveWorkspace,
    dynamicTools: toolBridge.specs,
  });

  const turn = await client.request<CodexTurnStartResponse>("turn/start", {
    threadId: thread.threadId,
    input: buildUserInput(params),
    cwd: effectiveWorkspace,
    approvalPolicy: resolveAppServerApprovalPolicy(),
    approvalsReviewer: resolveApprovalsReviewer(),
    model: params.modelId,
    effort: resolveReasoningEffort(params.thinkLevel),
  });
  const turnId = turn.turn.id;
  const projector = new CodexAppServerEventProjector(params, thread.threadId, turnId);
  let completed = false;
  let timedOut = false;

  const notificationCleanup = client.addNotificationHandler(async (notification) => {
    await projector.handleNotification(notification);
    if (
      notification.method === "turn/completed" &&
      isTurnNotification(notification.params, turnId)
    ) {
      completed = true;
      resolveCompletion?.();
    }
  });
  const requestCleanup = client.addRequestHandler(async (request) => {
    if (request.method !== "item/tool/call") {
      return undefined;
    }
    const call = readDynamicToolCallParams(request.params);
    if (!call || call.threadId !== thread.threadId || call.turnId !== turnId) {
      return undefined;
    }
    return toolBridge.handleToolCall(call) as Promise<JsonValue>;
  });

  const handle = {
    kind: "embedded" as const,
    queueMessage: async (text: string) => {
      await client.request("turn/steer", {
        threadId: thread.threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text }],
      });
    },
    isStreaming: () => !completed,
    isCompacting: () => false,
    cancel: () => runAbortController.abort("cancelled"),
    abort: () => runAbortController.abort("aborted"),
  };
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);

  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const timeout = setTimeout(
    () => {
      timedOut = true;
      projector.markTimedOut();
      runAbortController.abort("timeout");
    },
    Math.max(100, params.timeoutMs),
  );

  const abortListener = () => {
    void client.request("turn/interrupt", {
      threadId: thread.threadId,
      turnId,
    });
    resolveCompletion?.();
  };
  runAbortController.signal.addEventListener("abort", abortListener, { once: true });

  try {
    await completion;
    const result = projector.buildResult(toolBridge.telemetry);
    await mirrorTranscriptBestEffort({
      params,
      result,
    });
    return {
      ...result,
      timedOut,
      aborted: result.aborted || runAbortController.signal.aborted,
      promptError: timedOut ? "codex app-server attempt timed out" : result.promptError,
      promptErrorSource: timedOut ? "prompt" : result.promptErrorSource,
    };
  } finally {
    clearTimeout(timeout);
    notificationCleanup();
    requestCleanup();
    runAbortController.signal.removeEventListener("abort", abortListener);
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  }
}

type DynamicToolBuildParams = {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  sandboxSessionKey: string;
  sandbox: Awaited<ReturnType<typeof resolveSandboxContext>>;
  runAbortController: AbortController;
  sessionAgentId: string | undefined;
};

async function buildDynamicTools(input: DynamicToolBuildParams) {
  const { params } = input;
  if (params.disableTools || !supportsModelTools(params.model)) {
    return [];
  }
  const modelHasVision = params.model.input?.includes("image") ?? false;
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  const allTools = createOpenClawCodingTools({
    agentId: input.sessionAgentId,
    ...buildEmbeddedAttemptToolRunContext(params),
    exec: {
      ...params.execOverrides,
      elevated: params.bashElevated,
    },
    sandbox: input.sandbox,
    messageProvider: params.messageChannel ?? params.messageProvider,
    agentAccountId: params.agentAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    sessionKey: input.sandboxSessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    agentDir,
    workspaceDir: input.effectiveWorkspace,
    spawnWorkspaceDir: resolveAttemptSpawnWorkspaceDir({
      sandbox: input.sandbox,
      resolvedWorkspace: input.resolvedWorkspace,
    }),
    config: params.config,
    abortSignal: input.runAbortController.signal,
    modelProvider: params.model.provider,
    modelId: params.modelId,
    modelCompat: params.model.compat,
    modelApi: params.model.api,
    modelContextWindowTokens: params.model.contextWindow,
    modelAuthMode: resolveModelAuthMode(params.model.provider, params.config),
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    modelHasVision,
    requireExplicitMessageTarget:
      params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
    disableMessageTool: params.disableMessageTool,
    onYield: (message) => {
      params.onAgentEvent?.({
        stream: "codex_app_server.tool",
        data: { name: "sessions_yield", message },
      });
      input.runAbortController.abort("sessions_yield");
    },
  });
  const filteredTools =
    params.toolsAllow && params.toolsAllow.length > 0
      ? allTools.filter((tool) => params.toolsAllow?.includes(tool.name))
      : allTools;
  return normalizeProviderToolSchemas({
    tools: filteredTools,
    provider: params.provider,
    config: params.config,
    workspaceDir: input.effectiveWorkspace,
    env: process.env,
    modelId: params.modelId,
    modelApi: params.model.api,
    model: params.model,
  });
}

async function startOrResumeThread(params: {
  client: CodexAppServerClient;
  params: EmbeddedRunAttemptParams;
  cwd: string;
  dynamicTools: JsonValue[];
}): Promise<CodexAppServerThreadBinding> {
  const binding = await readCodexAppServerBinding(params.params.sessionFile);
  if (binding?.threadId) {
    try {
      const response = await params.client.request<CodexThreadResumeResponse>("thread/resume", {
        threadId: binding.threadId,
      });
      await writeCodexAppServerBinding(params.params.sessionFile, {
        threadId: response.thread.id,
        cwd: params.cwd,
        model: params.params.modelId,
        modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
        createdAt: binding.createdAt,
      });
      return {
        ...binding,
        threadId: response.thread.id,
        cwd: params.cwd,
        model: params.params.modelId,
        modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
      };
    } catch (error) {
      log.warn("codex app-server thread resume failed; starting a new thread", { error });
      await clearCodexAppServerBinding(params.params.sessionFile);
    }
  }

  const response = await params.client.request<CodexThreadStartResponse>("thread/start", {
    model: params.params.modelId,
    modelProvider: normalizeModelProvider(params.params.provider),
    cwd: params.cwd,
    approvalPolicy: resolveAppServerApprovalPolicy(),
    approvalsReviewer: resolveApprovalsReviewer(),
    sandbox: resolveAppServerSandbox(),
    serviceName: "OpenClaw",
    developerInstructions: buildDeveloperInstructions(params.params),
    dynamicTools: params.dynamicTools,
    experimentalRawEvents: true,
    persistExtendedHistory: true,
  });
  const createdAt = new Date().toISOString();
  await writeCodexAppServerBinding(params.params.sessionFile, {
    threadId: response.thread.id,
    cwd: params.cwd,
    model: response.model ?? params.params.modelId,
    modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
    createdAt,
  });
  return {
    schemaVersion: 1,
    threadId: response.thread.id,
    sessionFile: params.params.sessionFile,
    cwd: params.cwd,
    model: response.model ?? params.params.modelId,
    modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
    createdAt,
    updatedAt: createdAt,
  };
}

function buildDeveloperInstructions(params: EmbeddedRunAttemptParams): string {
  const sections = [
    "You are running inside OpenClaw. Use OpenClaw dynamic tools for messaging, cron, sessions, and host actions when available.",
    "Preserve the user's existing channel/session context. If sending a channel reply, use the OpenClaw messaging tool instead of describing that you would reply.",
    params.extraSystemPrompt,
    params.skillsSnapshot?.prompt,
  ];
  return sections.filter((section) => typeof section === "string" && section.trim()).join("\n\n");
}

function buildUserInput(params: EmbeddedRunAttemptParams): CodexUserInput[] {
  return [
    { type: "text", text: params.prompt },
    ...(params.images ?? []).map(
      (image): CodexUserInput => ({
        type: "image",
        url: `data:${image.mimeType};base64,${image.data}`,
      }),
    ),
  ];
}

function normalizeModelProvider(provider: string): string {
  return provider === "openai-codex" ? "openai" : provider;
}

function resolveAppServerApprovalPolicy(): "never" | "on-request" | "on-failure" | "untrusted" {
  const raw = process.env.OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY?.trim();
  if (raw === "on-request" || raw === "on-failure" || raw === "untrusted") {
    return raw;
  }
  return "never";
}

function resolveAppServerSandbox(): "read-only" | "workspace-write" | "danger-full-access" {
  const raw = process.env.OPENCLAW_CODEX_APP_SERVER_SANDBOX?.trim();
  if (raw === "read-only" || raw === "danger-full-access") {
    return raw;
  }
  return "workspace-write";
}

function resolveApprovalsReviewer(): "user" | "guardian_subagent" {
  return process.env.OPENCLAW_CODEX_APP_SERVER_GUARDIAN === "1" ? "guardian_subagent" : "user";
}

function resolveReasoningEffort(
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"],
): "minimal" | "low" | "medium" | "high" | "xhigh" | null {
  if (
    thinkLevel === "minimal" ||
    thinkLevel === "low" ||
    thinkLevel === "medium" ||
    thinkLevel === "high" ||
    thinkLevel === "xhigh"
  ) {
    return thinkLevel;
  }
  return null;
}

function readDynamicToolCallParams(
  value: JsonValue | undefined,
): CodexDynamicToolCallParams | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const threadId = readString(value, "threadId");
  const turnId = readString(value, "turnId");
  const callId = readString(value, "callId");
  const tool = readString(value, "tool");
  if (!threadId || !turnId || !callId || !tool) {
    return undefined;
  }
  return {
    threadId,
    turnId,
    callId,
    tool,
    arguments: value.arguments,
  };
}

function isTurnNotification(value: JsonValue | undefined, turnId: string): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  const directTurnId = readString(value, "turnId");
  if (directTurnId === turnId) {
    return true;
  }
  const turn = isJsonObject(value.turn) ? value.turn : undefined;
  return readString(turn ?? {}, "id") === turnId;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

async function mirrorTranscriptBestEffort(params: {
  params: EmbeddedRunAttemptParams;
  result: EmbeddedRunAttemptResult;
}): Promise<void> {
  try {
    await mirrorCodexAppServerTranscript({
      sessionFile: params.params.sessionFile,
      sessionKey: params.params.sessionKey,
      messages: params.result.messagesSnapshot,
    });
  } catch (error) {
    log.warn("failed to mirror codex app-server transcript", { error });
  }
}

export const __testing = {
  setCodexAppServerClientFactoryForTests(factory: CodexAppServerClientFactory): void {
    clientFactory = factory;
  },
  resetCodexAppServerClientFactoryForTests(): void {
    clientFactory = getSharedCodexAppServerClient;
  },
} as const;
