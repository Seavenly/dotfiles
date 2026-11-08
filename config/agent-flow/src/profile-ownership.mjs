import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { PROFILE_NAMES } from "./profile-catalog.mjs";

export const PROFILE_OWNER = "dotfiles.hermes-profile/v1\n";
export const PROFILE_OWNER_FILE = ".dotfiles-managed-profile";

async function optionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function directoryEntries(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function symlinkTargets(path, expected) {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return false;
    return (await realpath(path)) === (await realpath(expected));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function inspectProfileOwnership({ root, home, name }) {
  const profileHome = join(home, ".hermes", "profiles", name);
  const ownerFile = join(profileHome, PROFILE_OWNER_FILE);
  const owner = await optionalText(ownerFile);
  if (owner === PROFILE_OWNER) return { name, profileHome, status: "managed" };
  if (owner !== null) return { name, profileHome, status: "conflict" };

  const entries = await directoryEntries(profileHome);
  if (entries.length === 0) return { name, profileHome, status: "empty" };

  const hermesSource = join(
    root,
    "config",
    "agents",
    "profiles",
    name,
    "hermes",
  );
  const expectedLinks = ["SOUL.md", "distribution.yaml"];
  const linksMatch = (
    await Promise.all(
      expectedLinks.map((file) =>
        symlinkTargets(join(profileHome, file), join(hermesSource, file)),
      ),
    )
  ).every(Boolean);
  const extraEntries = entries.filter((entry) => !expectedLinks.includes(entry));
  if (linksMatch && extraEntries.length === 0) {
    return { name, profileHome, status: "prepared" };
  }
  if (linksMatch && entries.includes("config.yaml")) {
    return { name, profileHome, status: "legacy-managed" };
  }
  return { name, profileHome, status: "conflict" };
}

export async function inspectProfileSet({ root, home }) {
  return Promise.all(
    PROFILE_NAMES.map((name) => inspectProfileOwnership({ root, home, name })),
  );
}

export function assertClaimableProfiles(inspections, { force = false } = {}) {
  const conflicts = inspections
    .filter(({ status }) => status === "conflict")
    .map(({ name }) => name);
  if (conflicts.length > 0 && !force) {
    const plural = conflicts.length > 1;
    const subject =
      `unmanaged Hermes profile conflicts with managed name` +
      `${plural ? "s" : ""} ${conflicts.join(", ")}`;
    const action =
      `preserve ${plural ? "them" : "it"} or rerun dotfiles install ` +
      `--force to claim ${plural ? "them" : "it"}`;
    throw new Error(`${subject}; ${action}`);
  }
}

export async function adoptLegacyProfiles(inspections) {
  for (const inspection of inspections) {
    if (inspection.status !== "legacy-managed") continue;
    await mkdir(inspection.profileHome, { recursive: true });
    await writeFile(
      join(inspection.profileHome, PROFILE_OWNER_FILE),
      PROFILE_OWNER,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  }
}
