import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOCAL_GO_GC = "30";
const DEFAULT_LOCAL_GO_MEMORY_LIMIT = "3GiB";
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LOCK_POLL_MS = 500;
const DEFAULT_STALE_LOCK_MS = 30 * 1000;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function isLocalCheckEnabled(env) {
  const raw = env.OPENCLAW_LOCAL_CHECK?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

export function hasFlag(args, name) {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

export function applyLocalTsgoPolicy(args, env) {
  const nextEnv = { ...env };
  const nextArgs = [...args];

  if (!isLocalCheckEnabled(nextEnv)) {
    return { env: nextEnv, args: nextArgs };
  }

  insertBeforeSeparator(nextArgs, "--singleThreaded");
  insertBeforeSeparator(nextArgs, "--checkers", "1");

  if (!nextEnv.GOGC) {
    nextEnv.GOGC = DEFAULT_LOCAL_GO_GC;
  }
  if (!nextEnv.GOMEMLIMIT) {
    nextEnv.GOMEMLIMIT = DEFAULT_LOCAL_GO_MEMORY_LIMIT;
  }
  if (nextEnv.OPENCLAW_TSGO_PPROF_DIR && !hasFlag(nextArgs, "--pprofDir")) {
    insertBeforeSeparator(nextArgs, "--pprofDir", nextEnv.OPENCLAW_TSGO_PPROF_DIR);
  }

  return { env: nextEnv, args: nextArgs };
}

export function applyLocalOxlintPolicy(args, env) {
  const nextEnv = { ...env };
  const nextArgs = [...args];

  insertBeforeSeparator(nextArgs, "--type-aware");
  insertBeforeSeparator(nextArgs, "--tsconfig", "tsconfig.oxlint.json");

  if (isLocalCheckEnabled(nextEnv)) {
    insertBeforeSeparator(nextArgs, "--threads=1");
  }

  return { env: nextEnv, args: nextArgs };
}

export function acquireLocalHeavyCheckLockSync(params) {
  const env = params.env ?? process.env;

  if (!isLocalCheckEnabled(env)) {
    return () => {};
  }

  const locksDir = resolveLocalHeavyChecksDir(params.cwd);
  const lockName = params.lockName ?? "heavy-check";
  const lockDir = path.join(locksDir, `${lockName}.lock`);
  const ownerPath = path.join(lockDir, "owner.json");
  const timeoutMs = readPositiveInt(
    env.OPENCLAW_HEAVY_CHECK_LOCK_TIMEOUT_MS,
    DEFAULT_LOCK_TIMEOUT_MS,
  );
  const pollMs = readPositiveInt(env.OPENCLAW_HEAVY_CHECK_LOCK_POLL_MS, DEFAULT_LOCK_POLL_MS);
  const staleLockMs = readPositiveInt(
    env.OPENCLAW_HEAVY_CHECK_STALE_LOCK_MS,
    DEFAULT_STALE_LOCK_MS,
  );
  const startedAt = Date.now();
  let waitingLogged = false;
  let waiterStateWritten = false;

  fs.mkdirSync(locksDir, { recursive: true });

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      if (waiterStateWritten) {
        cleanupWaiterState(lockDir, process.pid);
        waiterStateWritten = false;
      }
      writeOwnerFile(ownerPath, {
        pid: process.pid,
        tool: params.toolName,
        lockName,
        cwd: params.cwd,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      });
      return () => {
        fs.rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const owner = readOwnerFile(ownerPath);
      if (shouldReclaimLock({ owner, lockDir, staleLockMs })) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        waiterStateWritten = false;
        continue;
      }

      writeWaiterState(lockDir, {
        pid: process.pid,
        tool: params.toolName,
        lockName,
        cwd: params.cwd,
        hostname: os.hostname(),
        createdAt: new Date(startedAt).toISOString(),
        ownerPid: owner && typeof owner.pid === "number" ? owner.pid : null,
        ownerTool: owner && typeof owner.tool === "string" ? owner.tool : null,
      });
      waiterStateWritten = true;

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        cleanupWaiterState(lockDir, process.pid);
        const ownerLabel = describeOwner(owner);
        throw new Error(
          `[${params.toolName}] timed out waiting for the local heavy-check lock at ${lockDir}${
            ownerLabel ? ` (${ownerLabel})` : ""
          }. If no local heavy checks are still running, remove the stale lock and retry.`,
          { cause: error },
        );
      }

      if (!waitingLogged) {
        const ownerLabel = describeOwner(owner);
        console.error(
          `[${params.toolName}] waiting for the local heavy-check lock${
            ownerLabel ? ` held by ${ownerLabel}` : ""
          }...`,
        );
        waitingLogged = true;
      }

      sleepSync(pollMs);
    }
  }
}

export function resolveLocalHeavyChecksDir(cwd) {
  return path.join(resolveGitCommonDir(cwd), "openclaw-local-checks");
}

export function listLocalHeavyChecks(cwd, env = process.env) {
  const locksDir = resolveLocalHeavyChecksDir(cwd);
  const staleLockMs = readPositiveInt(
    env.OPENCLAW_HEAVY_CHECK_STALE_LOCK_MS,
    DEFAULT_STALE_LOCK_MS,
  );

  let entries = [];
  try {
    entries = fs
      .readdirSync(locksDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".lock"));
  } catch {
    return [];
  }

  return entries
    .map((entry) => {
      const lockDir = path.join(locksDir, entry.name);
      const owner = readOwnerFile(path.join(lockDir, "owner.json"));
      const waiters = readWaiterStates(lockDir).map((waiter) => ({
        ...waiter,
        alive: typeof waiter.pid === "number" ? isProcessAlive(waiter.pid) : false,
      }));
      return {
        lockName: entry.name.replace(/\.lock$/u, ""),
        lockDir,
        owner,
        ownerAlive: owner && typeof owner.pid === "number" ? isProcessAlive(owner.pid) : false,
        stale: shouldReclaimLock({ owner, lockDir, staleLockMs }),
        waiters,
      };
    })
    .toSorted((left, right) => left.lockName.localeCompare(right.lockName));
}

export function resolveGitCommonDir(cwd) {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status === 0) {
    const raw = result.stdout.trim();
    if (raw.length > 0) {
      return path.resolve(cwd, raw);
    }
  }

  return path.join(cwd, ".git");
}

function insertBeforeSeparator(args, ...items) {
  if (items.length > 0 && hasFlag(args, items[0])) {
    return;
  }

  const separatorIndex = args.indexOf("--");
  const insertIndex = separatorIndex === -1 ? args.length : separatorIndex;
  args.splice(insertIndex, 0, ...items);
}

function readPositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeOwnerFile(ownerPath, owner) {
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
}

function writeWaiterState(lockDir, waiter) {
  const waitersDir = path.join(lockDir, "waiters");
  fs.mkdirSync(waitersDir, { recursive: true });
  writeOwnerFile(path.join(waitersDir, `${process.pid}.json`), waiter);
}

function cleanupWaiterState(lockDir, pid) {
  const waitersDir = path.join(lockDir, "waiters");
  const waiterPath = path.join(waitersDir, `${pid}.json`);
  fs.rmSync(waiterPath, { force: true });
  try {
    if (fs.readdirSync(waitersDir).length === 0) {
      fs.rmdirSync(waitersDir);
    }
  } catch {
    // Ignore cleanup failures for concurrent waiters.
  }
}

function readOwnerFile(ownerPath) {
  try {
    return JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

function readWaiterStates(lockDir) {
  const waitersDir = path.join(lockDir, "waiters");
  let entries = [];
  try {
    entries = fs.readdirSync(waitersDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readOwnerFile(path.join(waitersDir, entry.name)))
    .filter(Boolean);
}

function isAlreadyExistsError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function shouldReclaimLock({ owner, lockDir, staleLockMs }) {
  if (owner && typeof owner.pid === "number") {
    return !isProcessAlive(owner.pid);
  }

  try {
    const stats = fs.statSync(lockDir);
    return Date.now() - stats.mtimeMs >= staleLockMs;
  } catch {
    return true;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function describeOwner(owner) {
  if (!owner || typeof owner !== "object") {
    return "";
  }

  const tool = typeof owner.tool === "string" ? owner.tool : "unknown-tool";
  const pid = typeof owner.pid === "number" ? `pid ${owner.pid}` : "unknown pid";
  const cwd = typeof owner.cwd === "string" ? owner.cwd : "unknown cwd";
  return `${tool}, ${pid}, cwd ${cwd}`;
}

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}
