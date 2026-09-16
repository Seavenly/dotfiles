import { createHash } from "node:crypto";

import { digest as canonicalDigest } from "./canonical.mjs";

export const RELEASE_CONTENT_GOVERNANCE = Object.freeze({
  schema: "flow.release-content-git-binding/v1",
  included_paths: Object.freeze([
    "CONTEXT.md",
    "README.md",
    "bin/flow",
    "config/flow/",
    "docs/adr/0007-use-drovr-as-the-delegated-agent-runtime.md",
    "docs/adr/0008-use-a-sole-run-authority-for-flow-lifecycle.md",
    "tests/flow_cli_test.sh",
    "tests/flow_transition_test.sh",
    "tools/drovr/HARNESS-INTERFACE.md",
    "tools/drovr/SPEC.md",
    "tools/drovr/package.json",
    "tools/drovr/src/",
    "tools/drovr/test/compatibility.test.mjs",
    "tools/drovr/test/description.test.mjs",
    "tools/flow/",
  ]),
  excluded_paths: Object.freeze([
    "config/flow/evidence/",
    "config/flow/node_modules/",
    "config/flow/transition-ledger.v1.json",
    "tools/flow/node_modules/",
  ]),
});

export function releaseContentDigest(content) {
  return canonicalDigest({
    schema: content.schema,
    release_id: content.release_id,
    git_binding: content.git_binding,
    files: content.files,
  });
}

export function deriveGitTreeSha(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError("Git tree derivation requires at least one file");
  }
  const root = { directories: new Map(), files: new Map() };
  const seenPaths = new Set();
  for (const entry of files) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.path !== "string" || entry.path.length === 0 ||
        entry.path.startsWith("/") || entry.path.includes("\\") ||
        entry.path.split("/").some((component) => component === "" ||
          component === "." || component === "..") ||
        !["100644", "100755"].includes(entry.mode) ||
        !/^[0-9a-f]{40}$/u.test(entry.git_blob_sha ?? "")) {
      throw new TypeError("Git tree derivation received an invalid file entry");
    }
    if (seenPaths.has(entry.path)) {
      throw new TypeError(`Git tree derivation received a duplicate path: ${entry.path}`);
    }
    seenPaths.add(entry.path);

    const components = entry.path.split("/");
    let directory = root;
    for (const component of components.slice(0, -1)) {
      if (directory.files.has(component)) {
        throw new TypeError(`Git tree path is both a file and directory: ${entry.path}`);
      }
      if (!directory.directories.has(component)) {
        directory.directories.set(component, { directories: new Map(), files: new Map() });
      }
      directory = directory.directories.get(component);
    }
    const name = components.at(-1);
    if (directory.directories.has(name) || directory.files.has(name)) {
      throw new TypeError(`Git tree path is both a file and directory: ${entry.path}`);
    }
    directory.files.set(name, {
      mode: entry.mode,
      objectSha: entry.git_blob_sha,
    });
  }

  return hashTree(root);
}

function hashTree(directory) {
  const entries = [];
  for (const [name, child] of directory.directories) {
    entries.push({ name, isTree: true, mode: "40000", objectSha: hashTree(child) });
  }
  for (const [name, file] of directory.files) {
    entries.push({ name, isTree: false, ...file });
  }
  entries.sort(compareTreeEntries);
  const body = Buffer.concat(entries.map(({ mode, name, objectSha }) =>
    Buffer.concat([
      Buffer.from(`${mode} ${name}\0`, "utf8"),
      Buffer.from(objectSha, "hex"),
    ])));
  return createHash("sha1")
    .update(Buffer.from(`tree ${body.length}\0`))
    .update(body)
    .digest("hex");
}

function compareTreeEntries(left, right) {
  const leftName = Buffer.concat([
    Buffer.from(left.name, "utf8"),
    Buffer.from(left.isTree ? "/" : "\0"),
  ]);
  const rightName = Buffer.concat([
    Buffer.from(right.name, "utf8"),
    Buffer.from(right.isTree ? "/" : "\0"),
  ]);
  return Buffer.compare(leftName, rightName);
}

export function isGovernedReleasePath(path) {
  if (RELEASE_CONTENT_GOVERNANCE.excluded_paths.some((excluded) =>
    excluded.endsWith("/")
      ? path.startsWith(excluded)
      : path === excluded)) {
    return false;
  }
  return RELEASE_CONTENT_GOVERNANCE.included_paths.some((included) =>
    included.endsWith("/")
      ? path.startsWith(included)
      : path === included);
}
