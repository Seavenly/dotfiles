import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function acquireRunMutationLock(
  runDirectory,
  { operation = "launch" } = {},
) {
  const lockPath = `${runDirectory}.launch.lock`;
  return acquireExclusiveLock({
    busyCode: "AGENT_FLOW_LAUNCH_BUSY",
    lockPath,
    operation,
    busyMessage: (owner) => {
      const label = owner?.operation === "cancellation"
        ? "cancellation"
        : "launcher";
      return `another ${label} is active for this run; retry after it exits (${lockPath})`;
    },
    staleMessage:
      `stale launch lock detected; remove ${lockPath} after confirming no launcher is active`,
  });
}

export async function acquireExternalOwnershipLock({
  externalRoot,
  repositoryPath,
  stateHome,
}) {
  const key = createHash("sha256")
    .update(JSON.stringify([repositoryPath, externalRoot.system, externalRoot.id]))
    .digest("hex");
  const lockPath = join(
    stateHome,
    "agent-flow",
    "ownership-locks",
    `${key}.lock`,
  );
  return acquireExclusiveLock({
    busyCode: "AGENT_FLOW_OWNERSHIP_BUSY",
    lockPath,
    operation: "external-ownership",
    busyMessage: () =>
      `external ownership is being claimed; retry after it exits (${lockPath})`,
    staleMessage:
      `stale external ownership lock detected; remove ${lockPath} after confirming no launcher is active`,
  });
}

export async function acquireBoardRegistryLock({ kanbanHome }) {
  await mkdir(kanbanHome, { recursive: true, mode: 0o700 });
  const boardStore = await realpath(kanbanHome);
  const lockPath = join(
    boardStore,
    "agent-flow",
    "board-registry.lock",
  );
  return acquireExclusiveLock({
    busyCode: "AGENT_FLOW_BOARD_BUSY",
    lockPath,
    operation: "board-ownership",
    busyMessage: () =>
      `board ownership is being verified; retry after it exits (${lockPath})`,
    staleMessage:
      `stale board lock detected; remove ${lockPath} after confirming no launcher is active`,
  });
}

async function acquireExclusiveLock({
  busyCode,
  lockPath,
  operation,
  busyMessage,
  staleMessage,
}) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomUUID()}`;
  try {
    const handle = await open(lockPath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ operation, pid: process.pid, token })}\n`,
      );
    } finally {
      await handle.close();
    }
    return async () => {
      try {
        const owner = parseLock(await readFile(lockPath));
        if (owner.token === token) await unlink(lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = await readLock(lockPath);
    const stale = owner !== null && !processIsAlive(owner.pid);
    const busy = new Error(
      stale
        ? staleMessage
        : busyMessage(owner),
    );
    busy.code = busyCode;
    throw busy;
  }
}

async function readLock(lockPath) {
  try {
    const owner = parseLock(await readFile(lockPath));
    return Number.isInteger(owner.pid) && owner.pid > 0 ? owner : null;
  } catch (error) {
    if (error.code === "ENOENT") return { pid: -1 };
    return null;
  }
}

function parseLock(bytes) {
  const owner = JSON.parse(bytes.toString("utf8"));
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    throw new Error("launch lock must contain a JSON object");
  }
  return owner;
}

function processIsAlive(pid) {
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
