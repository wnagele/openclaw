import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatrixInboundEventDeduper } from "./inbound-dedupe.js";

describe("Matrix inbound event dedupe", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createStoragePath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-inbound-dedupe-"));
    tempDirs.push(dir);
    return path.join(dir, "inbound-dedupe.json");
  }

  const auth = {
    accountId: "ops",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
    deviceId: "DEVICE",
  } as const;

  it("persists committed events across restarts", async () => {
    const storagePath = createStoragePath();
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$event-1" })).toBe(true);
    await first.commitEvent({
      roomId: "!room:example.org",
      eventId: "$event-1",
    });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$event-1" })).toBe(false);
  });

  it("does not persist released pending claims", async () => {
    const storagePath = createStoragePath();
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$event-2" })).toBe(true);
    first.releaseEvent({ roomId: "!room:example.org", eventId: "$event-2" });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$event-2" })).toBe(true);
  });

  it("prunes expired and overflowed entries on load", async () => {
    const storagePath = createStoragePath();
    fs.writeFileSync(
      storagePath,
      JSON.stringify({
        version: 1,
        entries: [
          { key: "!room:example.org|$old", ts: 10 },
          { key: "!room:example.org|$keep-1", ts: 90 },
          { key: "!room:example.org|$keep-2", ts: 95 },
          { key: "!room:example.org|$keep-3", ts: 100 },
        ],
      }),
      "utf8",
    );

    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      maxEntries: 2,
      nowMs: () => 100,
    });

    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$old" })).toBe(true);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-1" })).toBe(true);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-2" })).toBe(false);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-3" })).toBe(false);
  });

  it("retains replayed backlog events based on processing time", async () => {
    const storagePath = createStoragePath();
    let now = 100;
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      nowMs: () => now,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$backlog" })).toBe(true);
    await first.commitEvent({
      roomId: "!room:example.org",
      eventId: "$backlog",
    });
    await first.stop();

    now = 110;
    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      nowMs: () => now,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$backlog" })).toBe(false);
  });

  it("persists per-room event watermarks for startup backlog fencing", async () => {
    const storagePath = createStoragePath();
    let now = 200;
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      nowMs: () => now,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$newer" })).toBe(true);
    await first.commitEvent({
      roomId: "!room:example.org",
      eventId: "$newer",
      eventTs: 200,
    });
    await first.stop();

    now = 210;
    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      nowMs: () => now,
    });

    expect(
      second.isOlderThanCommittedWatermark({
        roomId: "!room:example.org",
        eventTs: 199,
      }),
    ).toBe(true);
    expect(
      second.isOlderThanCommittedWatermark({
        roomId: "!room:example.org",
        eventTs: 200,
      }),
    ).toBe(false);
    expect(
      second.isOlderThanCommittedWatermark({
        roomId: "!other:example.org",
        eventTs: 199,
      }),
    ).toBe(false);
  });

  it("ignores implausibly future room watermarks when loading persisted state", async () => {
    const storagePath = createStoragePath();
    fs.writeFileSync(
      storagePath,
      JSON.stringify({
        version: 2,
        entries: [],
        roomWatermarks: [{ roomId: "!future:example.org", eventTs: 1_011 }],
      }),
      "utf8",
    );

    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      nowMs: () => 1_000,
      maxFutureEventTsSkewMs: 10,
    });

    expect(
      deduper.isOlderThanCommittedWatermark({
        roomId: "!future:example.org",
        eventTs: 1_000,
      }),
    ).toBe(false);
  });

  it("persists room watermarks that are within the allowed future skew", async () => {
    const storagePath = createStoragePath();
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      nowMs: () => 1_000,
      maxFutureEventTsSkewMs: 10,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$future-ok" })).toBe(true);
    await first.commitEvent({
      roomId: "!room:example.org",
      eventId: "$future-ok",
      eventTs: 1_010,
    });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      nowMs: () => 1_000,
      maxFutureEventTsSkewMs: 10,
    });

    expect(
      second.isOlderThanCommittedWatermark({
        roomId: "!room:example.org",
        eventTs: 1_009,
      }),
    ).toBe(true);
  });

  it("prunes expired and overflowed room watermarks on load", async () => {
    const storagePath = createStoragePath();
    fs.writeFileSync(
      storagePath,
      JSON.stringify({
        version: 2,
        entries: [],
        roomWatermarks: [
          { roomId: "!expired:example.org", eventTs: 10 },
          { roomId: "!keep-1:example.org", eventTs: 90 },
          { roomId: "!keep-2:example.org", eventTs: 95 },
          { roomId: "!keep-3:example.org", eventTs: 100 },
        ],
      }),
      "utf8",
    );

    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      maxRoomWatermarks: 2,
      nowMs: () => 100,
    });

    expect(
      deduper.isOlderThanCommittedWatermark({
        roomId: "!expired:example.org",
        eventTs: 0,
      }),
    ).toBe(false);
    expect(
      deduper.isOlderThanCommittedWatermark({
        roomId: "!keep-1:example.org",
        eventTs: 89,
      }),
    ).toBe(false);
    expect(
      deduper.isOlderThanCommittedWatermark({
        roomId: "!keep-2:example.org",
        eventTs: 94,
      }),
    ).toBe(true);
    expect(
      deduper.isOlderThanCommittedWatermark({
        roomId: "!keep-3:example.org",
        eventTs: 99,
      }),
    ).toBe(true);
  });

  it("bounds persisted room watermarks after overflow", async () => {
    const storagePath = createStoragePath();
    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      maxRoomWatermarks: 2,
      ttlMs: 1_000,
      nowMs: () => 1_000,
    });

    expect(deduper.claimEvent({ roomId: "!room-1:example.org", eventId: "$event-1" })).toBe(true);
    await deduper.commitEvent({
      roomId: "!room-1:example.org",
      eventId: "$event-1",
      eventTs: 100,
    });
    expect(deduper.claimEvent({ roomId: "!room-2:example.org", eventId: "$event-2" })).toBe(true);
    await deduper.commitEvent({
      roomId: "!room-2:example.org",
      eventId: "$event-2",
      eventTs: 200,
    });
    expect(deduper.claimEvent({ roomId: "!room-3:example.org", eventId: "$event-3" })).toBe(true);
    await deduper.commitEvent({
      roomId: "!room-3:example.org",
      eventId: "$event-3",
      eventTs: 300,
    });
    await deduper.stop();

    const stored = JSON.parse(fs.readFileSync(storagePath, "utf8")) as {
      roomWatermarks?: Array<{ roomId: string }>;
    };
    expect(stored.roomWatermarks?.map((entry) => entry.roomId)).toEqual([
      "!room-2:example.org",
      "!room-3:example.org",
    ]);
  });

  it("loads legacy v1 stores without requiring room watermarks", async () => {
    const storagePath = createStoragePath();
    fs.writeFileSync(
      storagePath,
      JSON.stringify({
        version: 1,
        entries: [{ key: "!room:example.org|$old", ts: 10 }],
      }),
      "utf8",
    );

    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      nowMs: () => 10,
    });

    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$old" })).toBe(false);
    expect(
      deduper.isOlderThanCommittedWatermark({
        roomId: "!room:example.org",
        eventTs: 9,
      }),
    ).toBe(false);
  });

  it("treats stop persistence failures as best-effort cleanup", async () => {
    const blockingPath = createStoragePath();
    fs.writeFileSync(blockingPath, "blocking file", "utf8");
    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath: path.join(blockingPath, "nested", "inbound-dedupe.json"),
    });

    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$persist-fail" })).toBe(
      true,
    );
    await deduper.commitEvent({
      roomId: "!room:example.org",
      eventId: "$persist-fail",
    });

    await expect(deduper.stop()).resolves.toBeUndefined();
  });
});
