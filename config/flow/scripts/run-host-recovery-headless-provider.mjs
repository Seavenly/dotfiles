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
const RECEIPT_MANIFEST_NAME = "public-command-receipts.json";

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
  const receipts = await loadPublicReceiptManifest(root);
  const files = await collectInputFiles(root, receipts.supporting_paths);
  const evidence = await loadReleaseEvidence(root, releaseEvidence);
  const records = [];
  for (const file of files) {
    if (RELEASE_EVIDENCE_NAMES.has(file.name)) continue;
    records.push(...await readPublicRecords(file, root, receipts.by_path));
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
  validateDistinctRenderedSources(captures);
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

async function collectInputFiles(root, supportingPaths = new Set()) {
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
                 !RELEASE_EVIDENCE_NAMES.has(entry.name) &&
                 entry.name !== RECEIPT_MANIFEST_NAME &&
                 !supportingPaths.has(relativePath)) {
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

async function loadPublicReceiptManifest(root) {
  const path = resolve(root, RECEIPT_MANIFEST_NAME);
  let value;
  try {
    value = parseJson(await readFile(path), RECEIPT_MANIFEST_NAME);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new HeadlessProviderError(
        "headless_capture_receipt_missing",
        `headless captures require ${RECEIPT_MANIFEST_NAME} binding each persisted public log`,
      );
    }
    throw error;
  }
  if (!isRecord(value) || value.schema !== "flow.headless-public-receipts/v1" ||
      !Array.isArray(value.receipts) || value.receipts.length === 0) {
    throw new HeadlessProviderError(
      "headless_capture_receipt_invalid",
      "headless public receipt manifest is invalid",
    );
  }
  const byPath = new Map();
  const supportingPaths = new Set();
  for (const receipt of value.receipts) {
    if (!isRecord(receipt) || typeof receipt.path !== "string" ||
        isAbsolute(receipt.path) || byPath.has(receipt.path) ||
        !["public_process", "composed"].includes(receipt.provenance) ||
        !DIGEST.test(`sha256:${receipt.persisted_sha256 ?? ""}`)) {
      throw new HeadlessProviderError(
        "headless_capture_receipt_invalid",
        "headless public receipt manifest contains an invalid capture binding",
      );
    }
    const persistedPath = resolve(root, receipt.path);
    if (!persistedPath.startsWith(`${root}${sep}`)) {
      throw new HeadlessProviderError(
        "headless_capture_receipt_path_invalid",
        `headless public receipt path escapes the input root: ${receipt.path}`,
      );
    }
    let persistedBytes;
    try {
      persistedBytes = await readFile(persistedPath);
    } catch (error) {
      throw new HeadlessProviderError(
        "headless_capture_receipt_log_missing",
        `persisted headless capture is unavailable: ${receipt.path}: ${error.code ?? error.message}`,
      );
    }
    const persistedSha = bytesDigest(persistedBytes);
    if (persistedSha !== receipt.persisted_sha256) {
      throw new HeadlessProviderError(
        "headless_capture_receipt_digest_mismatch",
        `persisted headless capture does not match its command receipt: ${receipt.path}`,
      );
    }
    if (receipt.provenance === "public_process" && receipt.stdout_sha256 !== persistedSha) {
      throw new HeadlessProviderError(
        "headless_capture_stdout_digest_mismatch",
        `public command stdout receipt does not match persisted capture: ${receipt.path}`,
      );
    }
    if (receipt.provenance === "composed") {
      if (!Array.isArray(receipt.components) || receipt.components.length === 0) {
        throw new HeadlessProviderError(
          "headless_capture_composed_receipt_missing",
          `composed capture has no public command component receipts: ${receipt.path}`,
        );
      }
      for (const component of receipt.components) {
        if (!isRecord(component) || typeof component.path !== "string" ||
            isAbsolute(component.path) ||
            !/^[0-9a-f]{64}$/u.test(component.sha256 ?? "") ||
            !/^(?:sha256:)?[0-9a-f]{64}$/u.test(component.stdout_sha256 ?? "") ||
            component.sha256 !== component.stdout_sha256.replace(/^sha256:/u, "")) {
          throw new HeadlessProviderError(
            "headless_capture_composed_receipt_invalid",
            `composed capture component is not bound to its originating stdout receipt: ${receipt.path}`,
          );
        }
        const componentPath = resolve(root, component.path);
        if (!componentPath.startsWith(`${root}${sep}`)) {
          throw new HeadlessProviderError(
            "headless_capture_receipt_path_invalid",
            `headless command component escapes the input root: ${component.path}`,
          );
        }
        const componentBytes = await readFile(componentPath).catch((error) => {
          throw new HeadlessProviderError(
            "headless_capture_receipt_log_missing",
            `persisted command component is unavailable: ${component.path}: ${error.code ?? error.message}`,
          );
        });
        if (bytesDigest(componentBytes) !== component.sha256) {
          throw new HeadlessProviderError(
            "headless_capture_receipt_digest_mismatch",
            `persisted command component does not match its receipt: ${component.path}`,
          );
        }
        supportingPaths.add(component.path);
      }
    }
    byPath.set(receipt.path, Object.freeze({
      ...receipt,
      supporting_paths: receipt.components?.map(({ path }) => path) ?? [],
    }));
  }
  return { by_path: byPath, supporting_paths: supportingPaths };
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

async function readPublicRecords(file, root, receiptByPath) {
  const receipt = receiptByPath.get(file.relative_path);
  if (!receipt) {
    throw new HeadlessProviderError(
      "headless_capture_receipt_missing",
      `no persisted public command receipt binds ${file.relative_path}`,
    );
  }
  const text = file.bytes.toString("utf8");
  const records = [];
  if (file.name.endsWith(".json")) {
    const parsed = parseJson(file.bytes, file.relative_path);
    for (const value of flattenRecords(parsed)) {
      records.push(record(value, file, root, null, receipt));
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
      records.push(record(value, file, root, lineNumber, receipt));
    }
  }
  return records;
}

function flattenRecords(value) {
  return flatten(value, {
    command_kind: null,
    source_provenance: "public_process",
  });

  function flatten(current, inherited) {
    if (Array.isArray(current)) return current.flatMap((item) => flatten(item, inherited));
    if (!isRecord(current)) return [];
    const metadata = {
      command_kind: typeof current.command_kind === "string"
        ? current.command_kind
        : inherited.command_kind,
      // Provenance comes only from the persisted command receipt. A field in
      // the captured JSON is public data, not provenance authority.
      source_provenance: inherited.source_provenance,
    };
    const records = PUBLIC_SCHEMA.test(current.schema ?? "")
      ? [{ value: current, ...metadata }]
      : [];
    for (const [key, child] of Object.entries(current)) {
      if (key === "schema" || key === "output") continue;
      records.push(...flatten(child, metadata));
    }
    if (isRecord(current.output)) {
      records.push(...flatten(current.output, metadata));
    }
    return records;
  }
}

function record(value, file, root, line, receipt) {
  const unwrapped = isRecord(value) && Object.hasOwn(value, "value") &&
    isRecord(value.value)
    ? value
    : { value, command_kind: null, source_provenance: "public_process" };
  return {
    value: unwrapped.value,
    command_kind: unwrapped.command_kind,
    source_provenance: receipt.provenance,
    source: {
      path: relative(root, file.path).split(sep).join("/"),
      line,
      sha256: file.sha256,
      provenance: receipt.provenance,
      receipt: {
        command_id: receipt.command_id ?? null,
        command_kind: receipt.command_kind ?? null,
        stdout_sha256: receipt.stdout_sha256 ?? null,
        persisted_sha256: receipt.persisted_sha256,
        components: receipt.components ?? [],
      },
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
    const operator = value.schema === "flow.operator-projection/v1"
      ? value
      : value.views?.operator;
    const checkpoints = Array.isArray(value.checkpoints)
      ? value.checkpoints
      : operator?.checkpoints;
    if (!isRecord(operator) || operator.schema !== "flow.operator-projection/v1" ||
        !Array.isArray(checkpoints) || checkpoints.length === 0) return null;
    projection = operator;
  } else if (kind === "candidate") {
    if (value.schema !== "work.review-candidate-projection/v1") return null;
  } else if (kind === "review") {
    if (!["flow.review-inbox-projection/v1", "flow.review-projection/v1"].includes(value.schema)) {
      return null;
    }
  } else if (kind === "graph") {
    projection = value.schema === "flow.graph-projection/v1" ? value : value.views?.graph;
    if (!isRecord(projection) || projection.schema !== "flow.graph-projection/v1") return null;
  } else if (kind === "timeline") {
    projection = value.schema === "flow.timeline-projection/v1" ? value : value.views?.timeline;
    if (!isRecord(projection) || projection.schema !== "flow.timeline-projection/v1") return null;
  } else if (kind === "tuicr") {
    if (!["tuicr.review-consumer-observation/v1", "tuicr.review-projection/v1"].includes(value.schema)) {
      return null;
    }
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
    rendered_bytes_sha256: item.source.receipt.persisted_sha256,
    persisted_rendered_bytes: item.source.receipt.persisted_sha256 === item.source.sha256,
  };
}

function makeCapture(kind, candidate) {
  const value = {
    schema: "flow.headless-capture/v1",
    form: kind,
    source: candidate.item.source,
    source_schema: candidate.item.value.schema,
    source_provenance: candidate.item.source_provenance,
    source_bytes_sha256: candidate.item.source.sha256,
    rendered_bytes_sha256: candidate.rendered_bytes_sha256,
    persisted_rendered_bytes: candidate.persisted_rendered_bytes === true,
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

function validateDistinctRenderedSources(captures) {
  for (const capture of captures) {
    if (capture.value.persisted_rendered_bytes !== true ||
        !["public_process", "composed"].includes(capture.value.source_provenance) ||
        capture.value.source_bytes_sha256 !== capture.value.rendered_bytes_sha256 ||
        capture.value.source?.receipt?.persisted_sha256 !== capture.value.rendered_bytes_sha256 ||
        capture.value.source_provenance === "composed" &&
          (!Array.isArray(capture.value.source.receipt.components) ||
           capture.value.source.receipt.components.length === 0)) {
      throw new HeadlessProviderError(
        "headless_rendered_bytes_unproven",
        `headless ${capture.kind} capture is not bound to persisted public output bytes`,
      );
    }
  }
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
