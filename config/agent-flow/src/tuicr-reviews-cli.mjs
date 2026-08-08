#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  inspectReviewHealth,
  loadReviewManifest,
} from "./review-manifest.mjs";
import { acquireFileLock, processIsAlive } from "./file-lock.mjs";

const stateHome = process.env.XDG_STATE_HOME ??
  (process.env.HOME ? join(process.env.HOME, ".local", "state") : null);
if (!process.env.TUICR_REVIEWS_FILE && !stateHome) {
  throw new Error("HOME, XDG_STATE_HOME, or TUICR_REVIEWS_FILE is required");
}
const file = process.env.TUICR_REVIEWS_FILE ?? join(
  stateHome,
  "dotfiles",
  "tuicr-reviews.jsonl",
);

try {
  await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`tuicr-reviews: ${error.message}\n`);
  process.exitCode = 1;
}

async function run(args) {
  const command = args.shift();
  switch (command) {
    case "add":
      await add(args);
      return;
    case "list":
      await list(args);
      return;
    case "toggle-approved":
      await toggleApproved(args);
      return;
    case "prune":
      requireNoArguments(args);
      await mutateStore(async (entries) => {
        const kept = [];
        for (const entry of entries) {
          if (entry.kind !== "manifest") {
            kept.push(entry);
            continue;
          }
          try {
            const manifest = await loadReviewManifest(entry.manifest);
            if (manifest.review.status !== "archived") kept.push(entry);
          } catch {
            kept.push(entry);
          }
        }
        return kept;
      });
      return;
    case "rebuild":
      await rebuild(args);
      return;
    case "rm":
      await remove(args);
      return;
    case undefined:
    case "-h":
    case "--help":
      usage(process.stdout);
      return;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function add(args) {
  const options = parseOptions(args, new Set([
    "--manifest",
    "--repo",
    "--worktree",
    "--base",
    "--branch",
    "--slug",
    "--summary",
  ]));
  if (options.has("--manifest")) {
    if (options.size !== 1) throw new Error("--manifest cannot be combined with legacy add options");
    const manifestPath = absolutePath(options.get("--manifest"), "manifest");
    const projection = await projectManifest(manifestPath);
    const entry = {
      kind: "manifest",
      manifest: manifestPath,
      created: projection.created,
      projection,
    };
    await mutateStore(async (entries) => {
      const existing = entries.find(
        (candidate) => candidate.kind === "manifest" && candidate.manifest === manifestPath,
      );
      if (existing) entry.created = existing.created;
      entry.projection.created = entry.created;
      return [
        ...entries.filter(
          (candidate) => candidate.kind !== "manifest" || candidate.manifest !== manifestPath,
        ),
        entry,
      ];
    });
    return;
  }

  for (const required of ["--worktree", "--base", "--branch"]) {
    if (!options.has(required)) throw new Error("legacy add needs --worktree, --base, --branch");
  }
  const worktree = await canonicalPath(options.get("--worktree"));
  const entry = {
    kind: "legacy",
    repo: options.get("--repo") ?? worktree,
    worktree,
    base: options.get("--base"),
    branch: options.get("--branch"),
    slug: options.get("--slug") ?? "",
    created: new Date().toISOString(),
    summary: sanitize(options.get("--summary") ?? ""),
    approved: false,
  };
  await mutateStore(async (entries) => {
    const existing = entries.find((candidate) => legacyKey(candidate, entry));
    if (existing) entry.created = existing.created;
    return [...entries.filter((candidate) => !legacyKey(candidate, entry)), entry];
  });
}

async function list(args) {
  let json = false;
  let approvedOnly = false;
  for (const argument of args) {
    if (argument === "--json") json = true;
    else if (argument === "--approved") approvedOnly = true;
    else throw new Error(`unknown arg: ${argument}`);
  }
  const entries = await loadStore();
  const projections = [];
  for (const entry of entries) projections.push(await projectEntry(entry));
  const filtered = projections
    .filter((projection) => !approvedOnly || (projection.approved && projection.health === "current"))
    .sort((left, right) => right.created.localeCompare(left.created));
  if (json) {
    process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
    return;
  }
  for (const projection of filtered) {
    process.stdout.write(`${[
      projection.worktree,
      projection.base,
      projection.branch,
      projection.repo,
      projection.slug,
      projection.created,
      projection.summary,
      String(projection.approved),
      projection.lifecycle,
      projection.health,
      projection.base_sha ?? "",
      projection.head_sha ?? "",
      projection.run_id ?? "",
      projection.session_slug ?? "",
      projection.kind,
      projection.manifest ?? "",
    ].map(sanitize).join("\t")}\n`);
  }
}

async function toggleApproved(args) {
  const options = parseOptions(args, new Set(["--worktree", "--base", "--branch"]));
  for (const required of ["--worktree", "--base", "--branch"]) {
    if (!options.has(required)) throw new Error("toggle-approved needs --worktree, --base, --branch");
  }
  await mutateStore(async (entries) => {
    let matched = false;
    const next = entries.map((entry) => {
      if (
        entry.kind === "legacy" &&
        entry.worktree === options.get("--worktree") &&
        entry.base === options.get("--base") &&
        entry.branch === options.get("--branch")
      ) {
        matched = true;
        return { ...entry, approved: !entry.approved };
      }
      return entry;
    });
    if (!matched) {
      throw new Error("approval toggles are legacy-only; use agent-flow review transition for manifests");
    }
    return next;
  });
}

async function remove(args) {
  const options = parseOptions(args, new Set(["--manifest", "--worktree", "--base", "--branch"]));
  if (options.has("--manifest")) {
    if (options.size !== 1) throw new Error("--manifest cannot be combined with review key options");
    const manifest = absolutePath(options.get("--manifest"), "manifest");
    await mutateStore(async (entries) => entries.filter(
      (entry) => entry.kind !== "manifest" || entry.manifest !== manifest,
    ));
    return;
  }
  if (!options.has("--worktree")) {
    throw new Error("rm needs --manifest or --worktree (add --base --branch to drop one review)");
  }
  const worktree = options.get("--worktree");
  const base = options.get("--base");
  const branch = options.get("--branch");
  if ((base === undefined) !== (branch === undefined)) {
    throw new Error("rm requires both --base and --branch when either is supplied");
  }
  await mutateStore(async (entries) => {
    const projected = await Promise.all(entries.map(projectEntry));
    return entries.filter((entry, index) => {
      const item = projected[index];
      if (item.worktree !== worktree) return true;
      return base !== undefined && (item.base !== base || item.branch !== branch);
    });
  });
}

async function rebuild(args) {
  const options = parseOptions(args, new Set(["--root"]));
  if (options.size !== 1 || !options.has("--root")) throw new Error("rebuild needs --root <directory>");
  const root = absolutePath(options.get("--root"), "root");
  const manifests = await findReviewManifests(root);
  const rebuilt = [];
  for (const manifest of manifests) {
    const projection = await projectManifest(manifest);
    if (projection.lifecycle === "archived") continue;
    rebuilt.push({
      kind: "manifest",
      manifest,
      created: projection.created,
      projection,
    });
  }
  await mutateStore(async (entries) => [
    ...entries.filter(({ kind }) => kind === "legacy"),
    ...rebuilt,
  ]);
}

async function projectEntry(entry) {
  if (entry.kind === "legacy") {
    let health = "current";
    try {
      if (!(await stat(entry.worktree)).isDirectory()) health = "missing_worktree";
    } catch {
      health = "missing_worktree";
    }
    return {
      worktree: entry.worktree,
      base: entry.base,
      branch: entry.branch,
      repo: entry.repo,
      slug: entry.slug ?? "",
      created: entry.created ?? "",
      summary: entry.summary ?? "",
      approved: entry.approved === true,
      lifecycle: entry.approved === true ? "approved" : "review_ready",
      health,
      base_sha: null,
      head_sha: null,
      run_id: null,
      session_slug: null,
      kind: "legacy",
      manifest: null,
    };
  }
  try {
    const projection = await projectManifest(entry.manifest);
    projection.created = entry.created ?? projection.created;
    return projection;
  } catch (error) {
    return {
      ...entry.projection,
      created: entry.created ?? entry.projection?.created ?? "",
      health: error.cause?.code === "ENOENT" ? "manifest_missing" : "manifest_invalid",
      kind: "manifest",
      manifest: entry.manifest,
    };
  }
}

async function projectManifest(manifestPath) {
  const manifest = await loadReviewManifest(manifestPath);
  const health = await inspectReviewHealth(manifest);
  const sessionSlug = manifest.review.session_slug;
  return {
    worktree: manifest.worktree,
    base: manifest.base.branch,
    branch: manifest.head.branch,
    repo: manifest.repo,
    slug: sessionSlug ?? manifest.run_id,
    created: manifest.created_at ?? "",
    summary: sanitize(manifest.summary),
    approved:
      manifest.review.status === "approved" &&
      manifest.review.reviewed_head_sha === manifest.head.sha,
    lifecycle: manifest.review.status,
    health: health.health,
    base_sha: manifest.base.sha,
    head_sha: manifest.head.sha,
    run_id: manifest.run_id,
    session_slug: sessionSlug,
    kind: "manifest",
    manifest: manifestPath,
  };
}

async function findReviewManifests(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if ([".git", "node_modules"].includes(entry.name)) continue;
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const document = JSON.parse(await readFile(path, "utf8"));
          if (document.schema === "agent-flow.local-review/v1") {
            await loadReviewManifest(path);
            found.push(path);
          }
        } catch {
          // Unrelated or invalid JSON is not a rebuild candidate.
        }
      }
    }
  }
  await visit(root);
  return found.sort();
}

async function loadStore() {
  try {
    const content = await readFile(file, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          return entry?.kind === "manifest" || entry?.kind === "legacy" || entry?.worktree
            ? [entry.kind ? entry : { ...entry, kind: "legacy" }]
            : [];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function mutateStore(mutator) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await sweepStaleTemps();
  return withLock(async () => {
    const next = await mutator(await loadStore());
    const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
    let renamed = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        for (const entry of next) await handle.writeFile(`${JSON.stringify(entry)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      renamed = true;
    } finally {
      if (!renamed) await unlink(temporary).catch(ignoreMissing);
    }
  });
}

async function withLock(operation) {
  const lock = `${file}.lock`;
  const release = await acquireFileLock(lock);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function sweepStaleTemps() {
  const directory = dirname(file);
  const prefix = `${basename(file)}.tmp.`;
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number(entry.slice(prefix.length).split(".", 1)[0]);
    if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) continue;
    await unlink(join(directory, entry)).catch(ignoreMissing);
  }
}

function ignoreMissing(error) {
  if (error.code !== "ENOENT") throw error;
}

function parseOptions(args, allowed) {
  if (args.length % 2 !== 0) throw new Error("option value is missing");
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name)) throw new Error(`unknown arg: ${name}`);
    if (options.has(name)) throw new Error(`duplicate arg: ${name}`);
    if (!value) throw new Error(`missing value for ${name}`);
    options.set(name, value);
  }
  return options;
}

function legacyKey(candidate, entry) {
  return candidate.kind === "legacy" &&
    candidate.worktree === entry.worktree &&
    candidate.base === entry.base &&
    candidate.branch === entry.branch;
}

async function canonicalPath(path) {
  const absolute = absolutePath(path, "worktree");
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function absolutePath(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  return resolve(path);
}

function sanitize(value) {
  return String(value ?? "").replaceAll("\t", " ").replaceAll("\n", " ");
}

function requireNoArguments(args) {
  if (args.length > 0) throw new Error(`unknown arg: ${args[0]}`);
}

function usage(stream) {
  stream.write(
    "Usage:\n" +
      "  tuicr-reviews add --manifest <absolute-review.json>\n" +
      "  tuicr-reviews add --repo R --worktree W --base B --branch BR [--slug S] [--summary text]\n" +
      "  tuicr-reviews list [--approved] [--json]\n" +
      "  tuicr-reviews toggle-approved --worktree W --base B --branch BR  # legacy only\n" +
      "  tuicr-reviews prune\n" +
      "  tuicr-reviews rebuild --root <manifest-root>\n" +
      "  tuicr-reviews rm --manifest <review.json>\n" +
      "  tuicr-reviews rm --worktree W [--base B --branch BR]\n",
  );
}
