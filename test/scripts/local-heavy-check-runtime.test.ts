import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
  applyLocalTsgoPolicy,
  listLocalHeavyChecks,
} from "../../scripts/lib/local-heavy-check-runtime.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-heavy-check-"));
  tempDirs.push(dir);
  return dir;
}

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ...process.env,
    OPENCLAW_LOCAL_CHECK: "1",
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("local-heavy-check-runtime", () => {
  it("tightens local tsgo runs to a single checker with a Go memory limit", () => {
    const { args, env } = applyLocalTsgoPolicy([], makeEnv());

    expect(args).toEqual(["--singleThreaded", "--checkers", "1"]);
    expect(env.GOGC).toBe("30");
    expect(env.GOMEMLIMIT).toBe("3GiB");
  });

  it("keeps explicit tsgo flags and Go env overrides intact", () => {
    const { args, env } = applyLocalTsgoPolicy(
      ["--checkers", "4", "--singleThreaded", "--pprofDir", "/tmp/existing"],
      makeEnv({
        GOGC: "80",
        GOMEMLIMIT: "5GiB",
        OPENCLAW_TSGO_PPROF_DIR: "/tmp/profile",
      }),
    );

    expect(args).toEqual(["--checkers", "4", "--singleThreaded", "--pprofDir", "/tmp/existing"]);
    expect(env.GOGC).toBe("80");
    expect(env.GOMEMLIMIT).toBe("5GiB");
  });

  it("serializes local oxlint runs onto one thread", () => {
    const { args } = applyLocalOxlintPolicy([], makeEnv());

    expect(args).toEqual(["--type-aware", "--tsconfig", "tsconfig.oxlint.json", "--threads=1"]);
  });

  it("reclaims stale local heavy-check locks from dead pids", () => {
    const cwd = makeTempDir();
    const commonDir = path.join(cwd, ".git");
    const lockDir = path.join(commonDir, "openclaw-local-checks", "heavy-check.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        tool: "tsgo",
        cwd,
      })}\n`,
      "utf8",
    );

    const release = acquireLocalHeavyCheckLockSync({
      cwd,
      env: makeEnv(),
      toolName: "oxlint",
    });

    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.tool).toBe("oxlint");

    release();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("tracks queued waiters while a local heavy check is blocked", async () => {
    const cwd = makeTempDir();
    const release = acquireLocalHeavyCheckLockSync({
      cwd,
      env: makeEnv(),
      lockName: "test",
      toolName: "test",
    });
    const lockDir = path.join(cwd, ".git", "openclaw-local-checks", "test.lock");
    const helperUrl = pathToFileURL(path.resolve("scripts/lib/local-heavy-check-runtime.mjs")).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          `import { acquireLocalHeavyCheckLockSync } from ${JSON.stringify(helperUrl)};`,
          `const release = acquireLocalHeavyCheckLockSync({ cwd: ${JSON.stringify(cwd)}, env: process.env, lockName: "test", toolName: "test" });`,
          "release();",
        ].join(" "),
      ],
      {
        cwd,
        env: makeEnv({
          OPENCLAW_HEAVY_CHECK_LOCK_TIMEOUT_MS: "2000",
          OPENCLAW_HEAVY_CHECK_LOCK_POLL_MS: "10",
        }),
        stdio: "ignore",
      },
    );

    await waitFor(
      () =>
        fs.existsSync(path.join(lockDir, "waiters")) &&
        fs.readdirSync(path.join(lockDir, "waiters")).length > 0,
    );

    const locksWhileBlocked = listLocalHeavyChecks(cwd, makeEnv());
    expect(locksWhileBlocked).toHaveLength(1);
    expect(locksWhileBlocked[0]?.lockName).toBe("test");
    expect(locksWhileBlocked[0]?.waiters).toHaveLength(1);
    expect(locksWhileBlocked[0]?.waiters[0]?.tool).toBe("test");

    release();
    const childExit = await waitForExit(child);
    expect(childExit.code).toBe(0);
    expect(fs.existsSync(path.join(lockDir, "waiters"))).toBe(false);
  });

  it("lists local heavy-check ownership and waiter state", () => {
    const cwd = makeTempDir();
    const lockDir = path.join(cwd, ".git", "openclaw-local-checks", "oxlint.lock");
    const waitersDir = path.join(lockDir, "waiters");
    fs.mkdirSync(waitersDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        tool: "oxlint",
        cwd,
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(waitersDir, "999999999.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        tool: "test",
        cwd,
      })}\n`,
      "utf8",
    );

    const locks = listLocalHeavyChecks(cwd, makeEnv());
    expect(locks).toHaveLength(1);
    expect(locks[0]?.lockName).toBe("oxlint");
    expect(locks[0]?.ownerAlive).toBe(true);
    expect(locks[0]?.waiters).toHaveLength(1);
    expect(locks[0]?.waiters[0]?.alive).toBe(false);
  });
});
