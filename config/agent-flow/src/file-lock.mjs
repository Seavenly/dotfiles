import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function acquireFileLock(
  lockPath,
  { malformedGraceMs = 5000, retries = 100, retryDelayMs = 5 } = {},
) {
  const directory = dirname(lockPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await sweepStaleCandidates(lockPath);
  const token = `${process.pid}:${randomUUID()}`;
  const candidate = `${lockPath}.candidate.${token}`;
  const handle = await open(candidate, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }

  let acquired = false;
  try {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        await link(candidate, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (await removeStaleLock(lockPath, { malformedGraceMs })) continue;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  } finally {
    await unlink(candidate).catch(ignoreMissing);
  }
  if (!acquired) throw new Error(`resource is busy: ${lockPath}`);

  return async () => {
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8"));
      if (owner.token === token) await unlink(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
}

async function sweepStaleCandidates(lockPath) {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.candidate.`;
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number(entry.slice(prefix.length).split(":", 1)[0]);
    if (processIsAlive(pid)) continue;
    await unlink(join(directory, entry)).catch(ignoreMissing);
  }
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function removeStaleLock(lockPath, { malformedGraceMs }) {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    if (processIsAlive(owner.pid)) return false;
    await unlink(lockPath).catch(ignoreMissing);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    const metadata = await stat(lockPath).catch(() => null);
    if (!metadata || Date.now() - metadata.mtimeMs <= malformedGraceMs) return false;
    await unlink(lockPath).catch(ignoreMissing);
    return true;
  }
}

function ignoreMissing(error) {
  if (error.code !== "ENOENT") throw error;
}
