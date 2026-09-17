#!/usr/bin/env node

import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const HEADLESS_PROVIDER_SCHEMA =
  "flow.host-recovery-headless-provider/v1";
export const HEADLESS_INPUT_SCHEMA = "flow.host-recovery-headless-input/v1";
export const HEADLESS_FORM_KINDS = Object.freeze([
  "terminal",
  "status",
  "checkpoint",
  "candidate",
  "review",
  "graph",
  "timeline",
  "tuicr",
]);

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PUBLIC_SCHEMA = /^(?:flow|work|drovr|tuicr)\.[A-Za-z0-9._-]+\/v\d+$/u;
const INPUT_FILE = /\.(?:json|jsonl|log)$/u;
const RELEASE_EVIDENCE_NAMES = new Set([
  "release-evidence.json",
  "release-evidence.v1.json",
]);

export class HeadlessProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "HeadlessProviderError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Build native-provider observations from files captured by a public Flow
 * process. The provider never invents a watermark or legal action. Every
 * emitted form points at the exact input file, line, bytes digest, and public
 * schema from which it was derived.
 */
export async function deriveHeadlessProvider({
  inputRoot,
  releaseEvidence = undefined,
} = {}) {
  const root = await assertInputRoot(inputRoot);
  const files = await collectInputFiles(root);
  const evidence = await loadReleaseEvidence(root, releaseEvidence);
  const records = [];
  for (const file of files) {
    if (RELEASE_EVIDENCE_NAMES.has(file.name)) continue;
    records.push(...await readPublicRecords(file, root));
  }
  const captures = [];
  const missing = [];
  for (const kind of HEADLESS_FORM_KINDS) {
    const derived = deriveForm(kind, records);
    if (derived === null) {
      missing.push(kind);
      continue;
    }
    captures.push(makeCapture(kind, derived));
  }
  if (missing.length > 0) {
    throw new HeadlessProviderError(
      "headless_form_unavailable",
      `required headless forms are not derivable from captured public projections: ${missing.join(", ")}`,
      { missing_forms: missing, source_count: records.length },
    );
  }
  const captureDigests = captures.map(({ sha256 }) => sha256);
  if (new Set(captureDigests).size !== captures.length) {
    throw new HeadlessProviderError(
      "headless_forms_not_distinct",
      "headless provider produced duplicate capture bytes",
    );
  }
  return Object.freeze({
    schema: HEADLESS_PROVIDER_SCHEMA,
    version: 1,
    status: "pass",
    input: {
      root_ref: "captured-public-projections",
      file_count: files.length,
      record_count: records.length,
      source_digests: files.map(({ relative_path, sha256 }) => ({
        path: relative_path,
        sha256,
      })),
    },
    captures,
    out_of_scope_forms: disabledForms(evidence),
    release_evidence: evidence,
  });
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const provider = await deriveHeadlessProvider({
      inputRoot: options.input_root,
      releaseEvidence: options.release_evidence ?? cliReleaseEvidence(options),
    });
    const bytes = Buffer.from(`${JSON.stringify(provider, null, 2)}\n`);
    if (options.output === undefined) {
      process.stdout.write(bytes);
    } else {
      await writeOutput(options.output, bytes);
      process.stdout.write(`${JSON.stringify({
        schema: provider.schema,
        status: provider.status,
        output: options.output,
        capture_count: provider.captures.length,
      })}\n`);
    }
  } catch (error) {
    const payload = {
      schema: HEADLESS_PROVIDER_SCHEMA,
      version: 1,
      status: "blocked",
      code: error?.code ?? "headless_provider_failed",
      reason: error?.message ?? String(error),
      ...(error?.details ?? {}),
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = error instanceof HeadlessProviderError ? 1 : 2;
  }
}

if (isMainModule()) await main();

function parseArgs(args) {
  const options = {};
  const allowed = new Set([
    "--input-root",
    "--output",
    "--release-evidence",
    "--release-id",
    "--manifest-digest",
    "--route",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag)) {
      throw new HeadlessProviderError("headless_argument_invalid", `unknown argument: ${flag}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new HeadlessProviderError("headless_argument_invalid", `missing value for ${flag}`);
    }
    options[flag.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  if (typeof options.input_root !== "string" || !isAbsolute(options.input_root)) {
    throw new HeadlessProviderError(
      "headless_argument_invalid",
      "--input-root must be an absolute directory",
    );
  }
  if (options.output !== undefined && !isAbsolute(options.output)) {
    throw new HeadlessProviderError(
      "headless_argument_invalid",
      "--output must be an absolute file path",
    );
  }
  return options;
}

function cliReleaseEvidence(options) {
  const evidence = {};
  if (typeof options.release_id === "string") evidence.release_id = options.release_id;
  if (typeof options.manifest_digest === "string") {
    evidence.manifest_digest = options.manifest_digest;
  }
  if (typeof options.route === "string") evidence.route = options.route;
  return Object.keys(evidence).length === 0 ? undefined : evidence;
}

async function assertInputRoot(inputRoot) {
  const root = resolve(inputRoot);
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    throw new HeadlessProviderError(
      "headless_input_unavailable",
      `headless input root is unavailable: ${error.code ?? error.message}`,
    );
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new HeadlessProviderError(
      "headless_input_invalid",
      "headless input root must be a real directory",
    );
  }
  return root;
}

async function collectInputFiles(root) {
  const files = [];
  await walk(root, "");
  if (files.length === 0) {
    throw new HeadlessProviderError(
      "headless_input_empty",
      "headless input directory contains no JSON projection or log files",
    );
  }
  return files.sort((left, right) => left.relative_path.localeCompare(right.relative_path));

  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const path = `${directory}${sep}${entry.name}`;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new HeadlessProviderError(
          "headless_input_symlink",
          `headless input contains a symlink: ${relativePath}`,
        );
      }
      if (info.isDirectory()) {
        await walk(path, relativePath);
      } else if (info.isFile() && INPUT_FILE.test(entry.name) &&
                 !RELEASE_EVIDENCE_NAMES.has(entry.name)) {
        const bytes = await readFile(path);
        files.push({
          name: entry.name,
          path,
          relative_path: relativePath,
          bytes,
          sha256: bytesDigest(bytes),
        });
      }
    }
  }
}

async function loadReleaseEvidence(root, supplied) {
  let value = supplied;
  if (typeof supplied === "string") {
    const path = resolve(supplied);
    const info = await lstat(path).catch((error) => {
      throw new HeadlessProviderError(
        "release_evidence_unavailable",
        `release evidence is unavailable: ${error.code ?? error.message}`,
      );
    });
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new HeadlessProviderError(
        "release_evidence_invalid",
        "release evidence must be a regular file",
      );
    }
    value = parseJson(await readFile(path), path);
  }
  if (value === undefined) {
    const candidates = ["release-evidence.json", "release-evidence.v1.json"];
    for (const name of candidates) {
      try {
        value = parseJson(await readFile(resolve(root, name)), name);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  if (value === undefined) {
    throw new HeadlessProviderError(
      "release_evidence_missing",
      "headless capture qualification requires release-evidence.json",
    );
  }
  if (!isRecord(value) ||
      (typeof value.release_id !== "string" &&
       typeof value.manifest_digest !== "string" &&
       typeof value.route !== "string")) {
    throw new HeadlessProviderError(
      "release_evidence_invalid",
      "release evidence must bind a release_id, manifest_digest, or route",
    );
  }
  return redactReleaseEvidence(value);
}

async function readPublicRecords(file, root) {
  const text = file.bytes.toString("utf8");
  const records = [];
  if (file.name.endsWith(".json")) {
    const parsed = parseJson(file.bytes, file.relative_path);
    for (const value of flattenRecords(parsed)) {
      records.push(record(value, file, root, null));
    }
    return records;
  }
  let lineNumber = 0;
  for (const line of text.split(/\r?\n/u)) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A native/public log may contain diagnostics. It cannot become a
      // capture, so ignore the line and require an independently valid record.
      continue;
    }
    for (const value of flattenRecords(parsed)) {
      records.push(record(value, file, root, lineNumber));
    }
  }
  return records;
}

function flattenRecords(value) {
  if (Array.isArray(value)) return value.flatMap(flattenRecords);
  if (!isRecord(value)) return [];
  if (isRecord(value.output)) {
    return [{
      value: value.output,
      command_kind: typeof value.command_kind === "string" ? value.command_kind : null,
      source_provenance: value.provenance ?? "public_process",
    }];
  }
  return [{ value, command_kind: null, source_provenance: "public_process" }];
}

function record(value, file, root, line) {
  const unwrapped = isRecord(value) && Object.hasOwn(value, "value") &&
    isRecord(value.value)
    ? value
    : { value, command_kind: null, source_provenance: "public_process" };
  return {
    value: unwrapped.value,
    command_kind: unwrapped.command_kind,
    source_provenance: unwrapped.source_provenance,
    source: {
      path: relative(root, file.path).split(sep).join("/"),
      line,
      sha256: file.sha256,
      provenance: "public_process",
    },
    raw_text: file.bytes.toString("utf8"),
  };
}

function deriveForm(kind, records) {
  const candidates = records
    .map((item) => deriveCandidate(kind, item))
    .filter(Boolean)
    .sort(compareCandidates);
  if (candidates.length === 0) return null;
  return candidates[0];
}

function deriveCandidate(kind, item) {
  const value = item.value;
  if (!isRecord(value) || !PUBLIC_SCHEMA.test(value.schema ?? "")) return null;
  const watermark = exactWatermark(value);
  if (!watermark) return null;
  let projection = value;
  if (kind === "status") {
    if (![
      "flow.owner-status/v1",
      "flow.runtime-runner-status/v1",
    ].includes(value.schema)) return null;
    projection = {
      ...value,
      watermark,
      legal_actions: exactLegalActions(value) ?? [],
    };
  } else if (kind === "checkpoint") {
    const operator = value.views?.operator;
    const checkpoints = Array.isArray(value.checkpoints)
      ? value.checkpoints
      : operator?.checkpoints;
    if (Array.isArray(checkpoints) && checkpoints.length > 0) {
      projection = operator ?? value;
    } else {
      const review = firstInboxItem(value);
      if (review === null) return null;
      projection = derivedInboxProjection("flow.checkpoint-text-projection/v1", value, review, {
        checkpoint: review.status,
        review_id: review.review_id,
        candidate_id: review.candidate_id,
      });
    }
  } else if (kind === "candidate") {
    if (value.schema !== "work.review-candidate-projection/v1" &&
        !(typeof value.candidate_fingerprint === "string" &&
          (typeof value.candidate_id === "string" || typeof value.subject_id === "string"))) {
      const review = firstInboxItem(value);
      if (review === null || !isRecord(review.candidate)) return null;
      projection = derivedInboxProjection("flow.candidate-text-projection/v1", value, review, {
        candidate_id: review.candidate_id,
        candidate_fingerprint: review.candidate_fingerprint,
        candidate: review.candidate,
      });
    }
  } else if (kind === "review") {
    if (!["flow.review-inbox-projection/v1", "flow.review-projection/v1"].includes(value.schema) &&
        typeof value.review_id !== "string") return null;
  } else if (kind === "graph") {
    projection = value.schema === "flow.graph-projection/v1" ? value : value.views?.graph;
    if (!isRecord(projection) || projection.schema !== "flow.graph-projection/v1") {
      const review = firstInboxItem(value);
      if (review === null) return null;
      projection = derivedInboxProjection("flow.graph-projection/v1", value, review, {
        nodes: [
          { id: review.candidate_id, kind: "candidate" },
          { id: review.review_id, kind: "review", status: review.status },
        ],
        edges: [{ from: review.candidate_id, to: review.review_id, kind: "review_of" }],
      });
    }
  } else if (kind === "timeline") {
    projection = value.schema === "flow.timeline-projection/v1" ? value : value.views?.timeline;
    if (!isRecord(projection) || projection.schema !== "flow.timeline-projection/v1") {
      const review = firstInboxItem(value);
      if (review === null) return null;
      projection = derivedInboxProjection("flow.timeline-projection/v1", value, review, {
        events: [{
          kind: "review",
          subject_id: review.review_id,
          status: review.status,
          lifecycle_generation: review.lifecycle_generation,
        }],
      });
    }
  } else if (kind === "tuicr") {
    if (!["flow.review-inbox-projection/v1", "flow.review-projection/v1"].includes(value.schema) &&
        typeof value.review_id !== "string") return null;
    projection = {
      schema: "tuicr.review-text-projection/v1",
      review: value,
      consumer: "tuicr",
    };
  } else if (kind === "terminal") {
    if (item.command_kind !== "status" && !item.source.path.endsWith(".log")) return null;
    projection = {
      schema: "flow.terminal-public-log/v1",
      text: item.raw_text.trim(),
      command_kind: item.command_kind ?? "public-json-log",
      projection: value,
      watermark,
      legal_actions: exactLegalActions(value) ?? [],
    };
  }
  const projectionWatermark = exactWatermark(projection) ?? watermark;
  const legalActions = exactLegalActions(projection) ?? exactLegalActions(value);
  if (legalActions === null) return null;
  return {
    item,
    projection,
    watermark: projectionWatermark,
    legal_actions: legalActions,
  };
}

function makeCapture(kind, candidate) {
  const value = {
    schema: "flow.headless-capture/v1",
    form: kind,
    source: candidate.item.source,
    source_schema: candidate.item.value.schema,
    source_provenance: candidate.item.source_provenance,
    projection: candidate.projection,
    watermark: candidate.watermark,
    legal_actions: candidate.legal_actions,
  };
  const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  return Object.freeze({
    id: `headless:${kind}`,
    kind,
    format: kind === "terminal" ? "text" : "json",
    value,
    sha256: bytesDigest(serialized),
    legibility: inspectLegibility(value),
    provenance: "native_provider",
    watermark: candidate.watermark,
    legal_actions: candidate.legal_actions,
    source: candidate.item.source,
  });
}

function compareCandidates(left, right) {
  const leftPath = `${left.item.source.path}:${left.item.source.line ?? 0}`;
  const rightPath = `${right.item.source.path}:${right.item.source.line ?? 0}`;
  return leftPath.localeCompare(rightPath);
}

function exactWatermark(value) {
  if (!isRecord(value)) return null;
  for (const key of [
    "watermark",
    "authority_watermark",
    "review_authority_watermark",
    "candidate_authority_watermark",
  ]) {
    const candidate = value[key];
    if (typeof candidate === "string" && DIGEST.test(candidate)) return candidate;
    if (isRecord(candidate)) {
      for (const nested of ["generation", "content_sha256", "registry_sha256"]) {
        if (typeof candidate[nested] === "string" && DIGEST.test(candidate[nested])) {
          return candidate[nested];
        }
      }
    }
  }
  const releaseDigest = value.runtime_binding?.release_content_digest;
  if (typeof releaseDigest === "string" && DIGEST.test(releaseDigest)) {
    return releaseDigest;
  }
  return null;
}

function firstInboxItem(value) {
  return value.schema === "flow.review-inbox-projection/v1" &&
      Array.isArray(value.items) && isRecord(value.items[0])
    ? value.items[0]
    : null;
}

function derivedInboxProjection(schema, inbox, review, fields) {
  return {
    schema,
    ...fields,
    watermark: exactWatermark(inbox),
    legal_actions: Array.isArray(review.legal_actions) ? review.legal_actions : [],
  };
}

function exactLegalActions(value) {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.legal_actions)) return value.legal_actions;
  if (Array.isArray(value.legal_next_actions)) return value.legal_next_actions;
  if (Array.isArray(value.items) && value.items.every((item) =>
    isRecord(item) && Array.isArray(item.legal_actions))) {
    return value.items.map((item) => item.legal_actions);
  }
  return null;
}

function disabledForms(evidence) {
  return [
    {
      form: "macos_visual",
      status: "out_of_scope",
      reason: "expanded macOS visual capture is deferred to issue 47",
      release_evidence: evidence,
    },
    {
      form: "expanded_macos_visuals",
      status: "out_of_scope",
      reason: "expanded macOS visual capture is deferred to issue 47",
      release_evidence: evidence,
    },
  ];
}

function inspectLegibility(value) {
  try {
    const readableValue = value?.projection?.projection ?? value?.projection ?? value;
    const text = JSON.stringify(readableValue, null, 2);
    const roundTrip = JSON.stringify(JSON.parse(text)) === JSON.stringify(readableValue);
    const lines = text.split("\n");
    const wrapped = lines.map((line) => line.match(/.{1,120}/gu) ?? [""]);
    const wrappingPreservesContent = wrapped.every((chunks, index) =>
      chunks.every((chunk) => chunk.length <= 120) && chunks.join("") === lines[index]);
    return typeof text === "string" && text.trim().length > 0 &&
      roundTrip && lines.length >= 2 && wrappingPreservesContent &&
      !text.includes("\uFFFD") &&
      !/(?:\[truncated\]|<truncated>|…\s*truncated)/iu.test(text) &&
      !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)
      ? "pass"
      : "fail";
  } catch {
    return "fail";
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new HeadlessProviderError(
      "headless_json_invalid",
      `captured JSON is invalid: ${label}: ${error.message}`,
    );
  }
}

function redactReleaseEvidence(value) {
  const output = {};
  for (const key of ["release_id", "manifest_digest", "route", "candidate_tree_sha"]) {
    if (typeof value[key] === "string") output[key] = value[key];
  }
  return output;
}

async function writeOutput(output, bytes) {
  const path = resolve(output);
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

function bytesDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMainModule() {
  return process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}
