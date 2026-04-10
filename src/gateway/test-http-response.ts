import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { vi } from "vitest";

export function makeMockHttpResponse(): {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const setHeader = vi.fn();
  const emitter = new EventEmitter();
  const res = {
    headersSent: false,
    statusCode: 200,
    writable: true,
    writableEnded: false,
    setHeader,
    write: vi.fn(() => true),
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    destroy: vi.fn(() => {
      res.writableEnded = true;
      emitter.emit("close");
      return res;
    }),
  } as unknown as ServerResponse;
  const end = vi.fn((chunk?: unknown) => {
    if (chunk !== undefined) {
      (res.write as unknown as ReturnType<typeof vi.fn>)(chunk);
    }
    res.headersSent = true;
    res.writableEnded = true;
    emitter.emit("finish");
    emitter.emit("close");
    return res;
  });
  (res as ServerResponse & { end: typeof end }).end = end;
  return { res, setHeader, end };
}
