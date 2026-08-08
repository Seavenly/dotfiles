import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { contentDigest } from "./canonical-json.mjs";

export async function sourceObservation(
  id,
  path,
  { pruneAtDepth = null, pruneDirectories = new Set() } = {},
) {
  try {
    const metadata = await readdir(path);
    return {
      content_sha256: await sourceContentDigest(path, {
        pruneAtDepth,
        pruneDirectories,
      }),
      entry_count: metadata.length,
      evidence_status: "verified",
      id,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { entry_count: 0, evidence_status: "missing", id };
    }
    return {
      entry_count: 0,
      evidence_status: "unreadable",
      id,
      reason: error.code ?? "read_failed",
    };
  }
}

export async function fileEvidence(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      return {
        evidence_status: metadata.isSymbolicLink() ? "uncertain" : "unreadable",
        reason: metadata.isSymbolicLink()
          ? "symbolic_link_not_followed"
          : "not_a_regular_file",
      };
    }
    const bytes = await readFile(path);
    return { bytes, evidence_status: "verified", sha256: sha256(bytes) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { evidence_status: "missing", reason: "absent" };
    }
    return {
      evidence_status: "unreadable",
      reason: error.code ?? "read_failed",
    };
  }
}

export async function descendantEntries(
  root,
  { depth = 0, pruneAtDepth = null, pruneDirectories = new Set() } = {},
) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    return [{ kind: "unreadable", path: root }];
  }
  const descendants = [];
  for (const entry of entries.sort(byName)) {
    const path = join(root, entry.name);
    const pruned = pruneDirectories.has(entry.name) &&
      (pruneAtDepth === null || depth === pruneAtDepth);
    if (entry.isDirectory() && !pruned) {
      descendants.push(...await descendantEntries(path, {
        depth: depth + 1,
        pruneAtDepth,
        pruneDirectories,
      }));
    } else if (entry.isFile()) {
      descendants.push({ kind: "file", path });
    } else if (entry.isSymbolicLink()) {
      descendants.push({ kind: "symlink", path });
    }
  }
  return descendants;
}

async function sourceContentDigest(root, { pruneAtDepth, pruneDirectories }) {
  const evidence = [];
  for (const entry of await descendantEntries(root, {
    pruneAtDepth,
    pruneDirectories,
  })) {
    const observed = entry.kind === "file"
      ? await fileEvidence(entry.path)
      : {
          evidence_status: entry.kind === "symlink" ? "uncertain" : "unreadable",
          reason: entry.kind === "symlink"
            ? "symbolic_link_not_followed"
            : "directory_unreadable",
        };
    evidence.push({
      evidence_status: observed.evidence_status,
      path: relative(root, entry.path),
      reason: observed.reason ?? null,
      sha256: observed.sha256 ?? null,
    });
  }
  return contentDigest(evidence);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function byName(left, right) {
  return compareStrings(left.name, right.name);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
