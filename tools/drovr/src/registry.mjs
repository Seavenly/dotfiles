import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
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
  const launchDocuments = join(directory, "launch-documents");
  await mkdir(launchDocuments, { recursive: true, mode: 0o700 });
  await chmod(launchDocuments, 0o700);
}

function recordPath(directory, kind, id) {
  if (!KINDS.has(kind))
    throw new Error(`unknown registry record kind: ${kind}`);
  return join(directory, kind, `${id}.json`);
}

async function validatePrivateDirectory(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
    throw new DrovrError(
      `unsafe registry directory ${path}: expected owner-only permissions`,
      { code: 3, outcome: "unsafe_state_permissions" },
    );
  }
  return true;
}

async function validatePrivateFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new DrovrError(
      `unsafe registry record ${path}: expected owner-only permissions`,
      { code: 3, outcome: "unsafe_state_permissions" },
    );
  }
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

export async function writeLaunchDocument(directory, key, contents) {
  await ensureStateDirectory(directory);
  const safeKey = createHash("sha256").update(key).digest("hex");
  const path = join(directory, "launch-documents", `${safeKey}.txt`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return path;
}

export async function readRecords(directory, kind) {
  if (!(await validatePrivateDirectory(directory))) return [];
  const kindDirectory = join(directory, kind);
  if (!(await validatePrivateDirectory(kindDirectory))) return [];
  let paths;
  try {
    paths = await readdir(kindDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const name of paths.filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(directory, kind, name);
    try {
      await validatePrivateFile(path);
      records.push(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (error instanceof DrovrError) throw error;
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
