import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DrovrError } from "./errors.mjs";

const KINDS = new Set(["groups", "tasks", "agents", "turns", "blocks"]);

export function stateDirectory(env = process.env) {
  const stateHome =
    env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state");
  return join(stateHome, "drovr");
}

export function taskLifecycleLockKey(taskId) {
  return `task-lifecycle:${taskId}`;
}

async function ensureStateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const locks = join(directory, "locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  await chmod(locks, 0o700);
  for (const kind of KINDS) {
    const path = join(directory, kind);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
}

function recordPath(directory, kind, id) {
  if (!KINDS.has(kind))
    throw new Error(`unknown registry record kind: ${kind}`);
  return join(directory, kind, `${id}.json`);
}

export async function writeRecord(directory, kind, record) {
  await ensureStateDirectory(directory);
  const path = recordPath(directory, kind, record.id);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function readRecords(directory, kind) {
  await ensureStateDirectory(directory);
  const paths = await readdir(join(directory, kind));
  const records = [];
  for (const name of paths.filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(directory, kind, name);
    try {
      records.push(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      throw new DrovrError(
        `corrupt registry record ${path}: ${error.message}`,
        {
          code: 5,
          outcome: "corrupt_registry",
        },
      );
    }
  }
  return records;
}

export async function withResourceLock(directory, key, operation) {
  await ensureStateDirectory(directory);
  const safeKey = createHash("sha256").update(key).digest("hex");
  const path = join(directory, "locks", safeKey);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || attempt >= 500) {
        throw new DrovrError(`cannot acquire registry lock for ${key}`, {
          code: 5,
          outcome: "registry_locked",
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
