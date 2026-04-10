const A2UI_PATH = "/__openclaw__/a2ui";
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";

function isCanvasHttpPath(pathname: string): boolean {
  return (
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`)
  );
}

function sanitizeCanvasEntryUrl(rawEntryUrl: string): string | undefined {
  try {
    const entry = new URL(rawEntryUrl, "http://localhost");
    if (entry.origin !== "http://localhost") {
      return undefined;
    }
    if (!isCanvasHttpPath(entry.pathname)) {
      return undefined;
    }
    return `${entry.pathname}${entry.search}${entry.hash}`;
  } catch {
    return undefined;
  }
}

export function resolveCanvasIframeUrl(
  entryUrl: string | undefined,
  canvasHostUrl?: string | null,
): string | undefined {
  const rawEntryUrl = entryUrl?.trim();
  if (!rawEntryUrl) {
    return undefined;
  }
  const safeEntryUrl = sanitizeCanvasEntryUrl(rawEntryUrl);
  if (!safeEntryUrl) {
    return undefined;
  }
  if (!canvasHostUrl?.trim()) {
    return safeEntryUrl;
  }
  try {
    const scopedHostUrl = new URL(canvasHostUrl);
    const scopedPrefix = scopedHostUrl.pathname.replace(/\/+$/, "");
    if (!scopedPrefix.startsWith(CANVAS_CAPABILITY_PATH_PREFIX)) {
      return safeEntryUrl;
    }
    const entry = new URL(safeEntryUrl, scopedHostUrl.origin);
    if (!isCanvasHttpPath(entry.pathname)) {
      return safeEntryUrl;
    }
    entry.protocol = scopedHostUrl.protocol;
    entry.username = scopedHostUrl.username;
    entry.password = scopedHostUrl.password;
    entry.host = scopedHostUrl.host;
    entry.pathname = `${scopedPrefix}${entry.pathname}`;
    return entry.toString();
  } catch {
    return safeEntryUrl;
  }
}
