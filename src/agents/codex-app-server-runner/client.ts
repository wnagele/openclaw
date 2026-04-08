import { spawn } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { log } from "../pi-embedded-runner/logger.js";
import {
  coerceJsonObject,
  isRpcResponse,
  type CodexServerNotification,
  type JsonObject,
  type JsonValue,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.js";

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CodexAppServerTransport = {
  stdin: { write: (data: string) => unknown };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  killed?: boolean;
  kill?: () => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export type CodexServerRequestHandler = (
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
) => Promise<JsonValue | undefined> | JsonValue | undefined;

export type CodexServerNotificationHandler = (
  notification: CodexServerNotification,
) => Promise<void> | void;

export class CodexAppServerClient {
  private readonly child: CodexAppServerTransport;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly requestHandlers = new Set<CodexServerRequestHandler>();
  private readonly notificationHandlers = new Set<CodexServerNotificationHandler>();
  private nextId = 1;
  private initialized = false;
  private closed = false;

  private constructor(child: CodexAppServerTransport) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        log.debug(`codex app-server stderr: ${text}`);
      }
    });
    child.once("error", (error) =>
      this.closeWithError(error instanceof Error ? error : new Error(String(error))),
    );
    child.once("exit", (code, signal) => {
      this.closeWithError(
        new Error(
          `codex app-server exited: code=${formatExitValue(code)} signal=${formatExitValue(signal)}`,
        ),
      );
    });
  }

  static start(): CodexAppServerClient {
    const bin = process.env.OPENCLAW_CODEX_APP_SERVER_BIN?.trim() || "codex";
    const extraArgs = splitShellWords(process.env.OPENCLAW_CODEX_APP_SERVER_ARGS ?? "");
    const args = extraArgs.length > 0 ? extraArgs : ["app-server", "--listen", "stdio://"];
    const child = spawn(bin, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new CodexAppServerClient(child);
  }

  static fromTransportForTests(child: CodexAppServerTransport): CodexAppServerClient {
    return new CodexAppServerClient(child);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.request("initialize", {
      clientInfo: {
        name: "openclaw",
        title: "OpenClaw",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  request<T = JsonValue | undefined>(method: string, params?: JsonValue): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server client is closed"));
    }
    const id = this.nextId++;
    const message: RpcRequest = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.writeMessage(message);
    });
  }

  notify(method: string, params?: JsonValue): void {
    this.writeMessage({ method, params });
  }

  addRequestHandler(handler: CodexServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  addNotificationHandler(handler: CodexServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.lines.close();
    if (!this.child.killed) {
      this.child.kill?.();
    }
  }

  private writeMessage(message: RpcRequest | RpcResponse): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      log.warn("failed to parse codex app-server message", { error });
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const message = parsed as RpcMessage;
    if (isRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (!("method" in message)) {
      return;
    }
    if ("id" in message && message.id !== undefined) {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }
    this.handleNotification({
      method: message.method,
      params: message.params,
    });
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message || `${pending.method} failed`));
      return;
    }
    pending.resolve(response.result);
  }

  private async handleServerRequest(
    request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
  ): Promise<void> {
    try {
      for (const handler of this.requestHandlers) {
        const result = await handler(request);
        if (result !== undefined) {
          this.writeMessage({ id: request.id, result });
          return;
        }
      }
      this.writeMessage({ id: request.id, result: defaultServerRequestResponse(request) });
    } catch (error) {
      this.writeMessage({
        id: request.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private handleNotification(notification: CodexServerNotification): void {
    for (const handler of this.notificationHandlers) {
      Promise.resolve(handler(notification)).catch((error: unknown) => {
        log.warn("codex app-server notification handler failed", { error });
      });
    }
  }

  private closeWithError(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

let sharedClientPromise: Promise<CodexAppServerClient> | undefined;

export async function getSharedCodexAppServerClient(): Promise<CodexAppServerClient> {
  sharedClientPromise ??= (async () => {
    const client = CodexAppServerClient.start();
    await client.initialize();
    return client;
  })();
  try {
    return await sharedClientPromise;
  } catch (error) {
    sharedClientPromise = undefined;
    throw error;
  }
}

export function resetSharedCodexAppServerClientForTests(): void {
  sharedClientPromise = undefined;
}

function defaultServerRequestResponse(
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
): JsonValue {
  if (request.method === "item/tool/call") {
    return {
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw did not register a handler for this app-server tool call.",
        },
      ],
      success: false,
    };
  }
  if (request.method.includes("requestApproval") || request.method.includes("Approval")) {
    return {
      decision: "deny",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    };
  }
  if (request.method === "item/tool/requestUserInput") {
    return {
      answers: {},
    };
  }
  if (request.method === "mcpServer/elicitation/request") {
    return {
      action: "decline",
    };
  }
  return {};
}

function splitShellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    words.push(current);
  }
  return words;
}

function formatExitValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return "unknown";
}

export function jsonObjectFromUnknown(value: unknown): JsonObject | undefined {
  return coerceJsonObject(value);
}
