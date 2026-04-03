import { listLocalHeavyChecks } from "./lib/local-heavy-check-runtime.mjs";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const locks = listLocalHeavyChecks(process.cwd(), process.env);

if (jsonOutput) {
  console.log(JSON.stringify({ locks }, null, 2));
  process.exit(0);
}

if (locks.length === 0) {
  console.log("No local heavy checks are registered.");
  process.exit(0);
}

for (const lock of locks) {
  const owner = formatActor(lock.owner, lock.ownerAlive);
  const waiters = lock.waiters
    .map((waiter) => `  waiter: ${formatActor(waiter, waiter.alive)}`)
    .join("\n");
  console.log(
    [
      `${lock.lockName}: ${lock.stale ? "stale" : "held"}`,
      `  owner: ${owner}`,
      `  path: ${lock.lockDir}`,
      waiters,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function formatActor(actor, alive) {
  if (!actor || typeof actor !== "object") {
    return "unknown";
  }

  const tool = typeof actor.tool === "string" ? actor.tool : "unknown-tool";
  const pid = typeof actor.pid === "number" ? `pid ${actor.pid}` : "unknown pid";
  const cwd = typeof actor.cwd === "string" ? actor.cwd : "unknown cwd";
  return `${tool}, ${pid}, cwd ${cwd}, ${alive ? "alive" : "dead"}`;
}
