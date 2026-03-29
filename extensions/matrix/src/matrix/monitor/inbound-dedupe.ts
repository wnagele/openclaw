import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { createAsyncLock } from "../async-lock.js";
import { resolveMatrixStateFilePath } from "../client/storage.js";
import type { MatrixAuth } from "../client/types.js";
import { LogService } from "../sdk/logger.js";

const INBOUND_DEDUPE_FILENAME = "inbound-dedupe.json";
const STORE_VERSION = 2;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_ROOM_WATERMARKS = 4_096;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FUTURE_EVENT_TS_SKEW_MS = 10 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 250;

type StoredMatrixInboundDedupeEntry = {
  key: string;
  ts: number;
};

type StoredMatrixInboundDedupeState = {
  version: number;
  entries: StoredMatrixInboundDedupeEntry[];
  roomWatermarks?: StoredMatrixInboundRoomWatermark[];
};

type StoredMatrixInboundRoomWatermark = {
  roomId: string;
  eventTs: number;
  eventId?: string;
};

type MatrixInboundRoomWatermark = {
  eventTs: number;
  eventId?: string;
};

export type MatrixInboundEventDeduper = {
  claimEvent: (params: { roomId: string; eventId: string }) => boolean;
  commitEvent: (params: { roomId: string; eventId: string; eventTs?: number }) => Promise<void>;
  releaseEvent: (params: { roomId: string; eventId: string }) => void;
  isOlderThanCommittedWatermark: (params: { roomId: string; eventTs: number }) => boolean;
  flush: () => Promise<void>;
  stop: () => Promise<void>;
};

function normalizeEventPart(value: string): string {
  return value.trim();
}

function normalizeRoomId(value: string): string {
  return value.trim();
}

function buildEventKey(params: { roomId: string; eventId: string }): string {
  const roomId = normalizeEventPart(params.roomId);
  const eventId = normalizeEventPart(params.eventId);
  return roomId && eventId ? `${roomId}|${eventId}` : "";
}

function resolveInboundDedupeStatePath(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): string {
  return resolveMatrixStateFilePath({
    auth: params.auth,
    env: params.env,
    stateDir: params.stateDir,
    filename: INBOUND_DEDUPE_FILENAME,
  });
}

function normalizeTimestamp(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(0, Math.floor(raw));
}

function normalizeEventTimestamp(raw: unknown): number | null {
  return normalizeTimestamp(raw);
}

function normalizeTrustedEventTimestamp(params: {
  raw: unknown;
  nowMs: number;
  maxFutureSkewMs: number;
}): number | null {
  const eventTs = normalizeEventTimestamp(params.raw);
  if (eventTs === null) {
    return null;
  }
  const maxFutureSkewMs = Math.max(0, Math.floor(params.maxFutureSkewMs));
  // Matrix event timestamps are homeserver-supplied, so do not let implausibly
  // future values advance the durable replay watermark.
  if (eventTs > params.nowMs + maxFutureSkewMs) {
    return null;
  }
  return eventTs;
}

function normalizeOptionalEventId(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = normalizeEventPart(raw);
  return value || undefined;
}

function pruneTimestampedEntries<K, V>(params: {
  entries: Map<K, V>;
  ttlMs: number;
  maxEntries: number;
  nowMs: number;
  getTimestamp: (value: V) => number;
}) {
  const { entries, ttlMs, maxEntries, nowMs, getTimestamp } = params;
  if (ttlMs > 0) {
    const cutoff = nowMs - ttlMs;
    for (const [key, value] of entries) {
      if (getTimestamp(value) < cutoff) {
        entries.delete(key);
      }
    }
  }
  const max = Math.max(0, Math.floor(maxEntries));
  if (max <= 0) {
    entries.clear();
    return;
  }
  const overflow = entries.size - max;
  if (overflow <= 0) {
    return;
  }
  const oldestKeys = Array.from(entries.entries())
    .toSorted(([, left], [, right]) => getTimestamp(left) - getTimestamp(right))
    .slice(0, overflow)
    .map(([key]) => key);
  for (const key of oldestKeys) {
    entries.delete(key);
  }
}

function pruneSeenEvents(params: {
  seen: Map<string, number>;
  ttlMs: number;
  maxEntries: number;
  nowMs: number;
}) {
  pruneTimestampedEntries({
    entries: params.seen,
    ttlMs: params.ttlMs,
    maxEntries: params.maxEntries,
    nowMs: params.nowMs,
    getTimestamp: (ts) => ts,
  });
}

function pruneRoomWatermarks(params: {
  roomWatermarks: Map<string, MatrixInboundRoomWatermark>;
  ttlMs: number;
  maxEntries: number;
  nowMs: number;
}) {
  pruneTimestampedEntries({
    entries: params.roomWatermarks,
    ttlMs: params.ttlMs,
    maxEntries: params.maxEntries,
    nowMs: params.nowMs,
    getTimestamp: (watermark) => watermark.eventTs,
  });
}

function toStoredState(params: {
  seen: Map<string, number>;
  roomWatermarks: Map<string, MatrixInboundRoomWatermark>;
  ttlMs: number;
  maxEntries: number;
  maxRoomWatermarks: number;
  nowMs: number;
}): StoredMatrixInboundDedupeState {
  pruneSeenEvents(params);
  pruneRoomWatermarks({
    roomWatermarks: params.roomWatermarks,
    ttlMs: params.ttlMs,
    maxEntries: params.maxRoomWatermarks,
    nowMs: params.nowMs,
  });
  return {
    version: STORE_VERSION,
    entries: Array.from(params.seen.entries()).map(([key, ts]) => ({ key, ts })),
    roomWatermarks: Array.from(params.roomWatermarks.entries()).map(([roomId, watermark]) => ({
      roomId,
      eventTs: watermark.eventTs,
      ...(watermark.eventId ? { eventId: watermark.eventId } : {}),
    })),
  };
}

async function readStoredState(
  storagePath: string,
): Promise<StoredMatrixInboundDedupeState | null> {
  const { value } = await readJsonFileWithFallback<StoredMatrixInboundDedupeState | null>(
    storagePath,
    null,
  );
  if (
    !value ||
    (value.version !== 1 && value.version !== STORE_VERSION) ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }
  return {
    version: value.version,
    entries: value.entries,
    roomWatermarks: Array.isArray(value.roomWatermarks) ? value.roomWatermarks : [],
  };
}

function updateRoomWatermark(params: {
  roomWatermarks: Map<string, MatrixInboundRoomWatermark>;
  roomId: string;
  eventTs?: number;
  eventId?: string;
  nowMs: number;
  maxFutureSkewMs: number;
}): void {
  const roomId = normalizeRoomId(params.roomId);
  const eventTs = normalizeTrustedEventTimestamp({
    raw: params.eventTs,
    nowMs: params.nowMs,
    maxFutureSkewMs: params.maxFutureSkewMs,
  });
  if (!roomId || eventTs === null) {
    return;
  }
  const nextEventId = normalizeOptionalEventId(params.eventId);
  const current = params.roomWatermarks.get(roomId);
  if (!current || eventTs > current.eventTs) {
    params.roomWatermarks.set(roomId, {
      eventTs,
      ...(nextEventId ? { eventId: nextEventId } : {}),
    });
    return;
  }
  if (eventTs === current.eventTs && !current.eventId && nextEventId) {
    params.roomWatermarks.set(roomId, { eventTs, eventId: nextEventId });
  }
}

function hasOlderCommittedRoomEvent(params: {
  roomWatermarks: Map<string, MatrixInboundRoomWatermark>;
  roomId: string;
  eventTs: number;
}): boolean {
  const roomId = normalizeRoomId(params.roomId);
  const eventTs = normalizeEventTimestamp(params.eventTs);
  if (!roomId || eventTs === null) {
    return false;
  }
  const current = params.roomWatermarks.get(roomId);
  return Boolean(current && eventTs < current.eventTs);
}

export async function createMatrixInboundEventDeduper(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  storagePath?: string;
  ttlMs?: number;
  maxEntries?: number;
  maxRoomWatermarks?: number;
  maxFutureEventTsSkewMs?: number;
  nowMs?: () => number;
}): Promise<MatrixInboundEventDeduper> {
  const nowMs = params.nowMs ?? (() => Date.now());
  const ttlMs =
    typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs)
      ? Math.max(0, Math.floor(params.ttlMs))
      : DEFAULT_TTL_MS;
  const maxEntries =
    typeof params.maxEntries === "number" && Number.isFinite(params.maxEntries)
      ? Math.max(0, Math.floor(params.maxEntries))
      : DEFAULT_MAX_ENTRIES;
  const maxRoomWatermarks =
    typeof params.maxRoomWatermarks === "number" && Number.isFinite(params.maxRoomWatermarks)
      ? Math.max(0, Math.floor(params.maxRoomWatermarks))
      : DEFAULT_MAX_ROOM_WATERMARKS;
  const maxFutureEventTsSkewMs =
    typeof params.maxFutureEventTsSkewMs === "number" &&
    Number.isFinite(params.maxFutureEventTsSkewMs)
      ? Math.max(0, Math.floor(params.maxFutureEventTsSkewMs))
      : DEFAULT_MAX_FUTURE_EVENT_TS_SKEW_MS;
  const storagePath =
    params.storagePath ??
    resolveInboundDedupeStatePath({
      auth: params.auth,
      env: params.env,
      stateDir: params.stateDir,
    });

  const seen = new Map<string, number>();
  const roomWatermarks = new Map<string, MatrixInboundRoomWatermark>();
  const pending = new Set<string>();
  const persistLock = createAsyncLock();

  try {
    const stored = await readStoredState(storagePath);
    for (const entry of stored?.entries ?? []) {
      if (!entry || typeof entry.key !== "string") {
        continue;
      }
      const key = entry.key.trim();
      const ts = normalizeTimestamp(entry.ts);
      if (!key || ts === null) {
        continue;
      }
      seen.set(key, ts);
    }
    for (const entry of stored?.roomWatermarks ?? []) {
      if (!entry || typeof entry.roomId !== "string") {
        continue;
      }
      updateRoomWatermark({
        roomWatermarks,
        roomId: entry.roomId,
        eventTs: entry.eventTs,
        eventId: entry.eventId,
        nowMs: nowMs(),
        maxFutureSkewMs: maxFutureEventTsSkewMs,
      });
    }
    pruneSeenEvents({ seen, ttlMs, maxEntries, nowMs: nowMs() });
    pruneRoomWatermarks({
      roomWatermarks,
      ttlMs,
      maxEntries: maxRoomWatermarks,
      nowMs: nowMs(),
    });
  } catch (err) {
    LogService.warn("MatrixInboundDedupe", "Failed loading Matrix inbound dedupe store:", err);
  }

  let dirty = false;
  let persistTimer: NodeJS.Timeout | null = null;
  let persistPromise: Promise<void> | null = null;

  const persist = async () => {
    dirty = false;
    const payload = toStoredState({
      seen,
      roomWatermarks,
      ttlMs,
      maxEntries,
      maxRoomWatermarks,
      nowMs: nowMs(),
    });
    try {
      await persistLock(async () => {
        await writeJsonFileAtomically(storagePath, payload);
      });
    } catch (err) {
      dirty = true;
      throw err;
    }
  };

  const flush = async (): Promise<void> => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    while (dirty || persistPromise) {
      if (dirty && !persistPromise) {
        persistPromise = persist().finally(() => {
          persistPromise = null;
        });
      }
      await persistPromise;
    }
  };

  const schedulePersist = () => {
    dirty = true;
    if (persistTimer) {
      return;
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void flush().catch((err) => {
        LogService.warn(
          "MatrixInboundDedupe",
          "Failed persisting Matrix inbound dedupe store:",
          err,
        );
      });
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  };

  return {
    claimEvent: ({ roomId, eventId }) => {
      const key = buildEventKey({ roomId, eventId });
      if (!key) {
        return true;
      }
      pruneSeenEvents({ seen, ttlMs, maxEntries, nowMs: nowMs() });
      if (seen.has(key) || pending.has(key)) {
        return false;
      }
      pending.add(key);
      return true;
    },
    commitEvent: async ({ roomId, eventId, eventTs }) => {
      const key = buildEventKey({ roomId, eventId });
      if (!key) {
        return;
      }
      pending.delete(key);
      const ts = nowMs();
      seen.delete(key);
      seen.set(key, ts);
      updateRoomWatermark({
        roomWatermarks,
        roomId,
        eventTs,
        eventId,
        nowMs: nowMs(),
        maxFutureSkewMs: maxFutureEventTsSkewMs,
      });
      pruneSeenEvents({ seen, ttlMs, maxEntries, nowMs: nowMs() });
      pruneRoomWatermarks({
        roomWatermarks,
        ttlMs,
        maxEntries: maxRoomWatermarks,
        nowMs: nowMs(),
      });
      schedulePersist();
    },
    releaseEvent: ({ roomId, eventId }) => {
      const key = buildEventKey({ roomId, eventId });
      if (!key) {
        return;
      }
      pending.delete(key);
    },
    isOlderThanCommittedWatermark: ({ roomId, eventTs }) =>
      hasOlderCommittedRoomEvent({ roomWatermarks, roomId, eventTs }),
    flush,
    stop: async () => {
      try {
        await flush();
      } catch (err) {
        LogService.warn(
          "MatrixInboundDedupe",
          "Failed to flush Matrix inbound dedupe store during stop():",
          err,
        );
      }
    },
  };
}
