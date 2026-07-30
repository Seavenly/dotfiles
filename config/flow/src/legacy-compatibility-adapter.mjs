import { readdir } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  descendantEntries,
  fileEvidence,
  sourceObservation,
} from "./filesystem-evidence.mjs";

const HERMES_RUN_SCHEMA = "agent-flow.run/v1";
const REVIEW_SCHEMA = "agent-flow.local-review/v1";
const STACK_SCHEMAS = new Set([
  "agent-flow.stack-plan/v1",
  "agent-flow.stack-state/v1",
]);

export class FilesystemLegacyCompatibilityAdapter {
  constructor({ legacyRoots }) {
    this.legacyRoots = legacyRoots;
  }

  async observe() {
    const observation = emptyObservation();
    await this.#observeRuns({
      implementation: "claude-agent-teams",
      root: this.legacyRoots.claudeRuns,
      observation,
    });
    await this.#observeRuns({
      implementation: "hermes-agent-flow",
      root: this.legacyRoots.hermesRuns,
      observation,
    });
    await this.#observeStacks(observation);
    return settleLegacyEvidence(observation);
  }

  async #observeRuns({ implementation, root, observation }) {
    const source = await sourceObservation(`${implementation}-runs`, root, {
      pruneAtDepth: 1,
      pruneDirectories: new Set(["repo", "worktree"]),
    });
    observation.sources.push(source);
    if (source.evidence_status !== "verified") return;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort(byName)) {
      if (!entry.isDirectory()) continue;
      await this.#observeRun({
        implementation,
        observation,
        root,
        runDirectory: join(root, entry.name),
        runName: entry.name,
      });
    }
  }

  async #observeRun({ implementation, observation, root, runDirectory, runName }) {
    const runId = `${implementation}:${runName}`;
    const manifestPath = implementation === "hermes-agent-flow"
      ? join(runDirectory, "run.json")
      : join(runDirectory, "brief.md");
    const manifest = implementation === "hermes-agent-flow"
      ? await jsonEvidence(manifestPath, HERMES_RUN_SCHEMA)
      : await fileEvidence(manifestPath);
    const document = manifest.document ?? null;
    const claudeFlow = implementation === "claude-agent-teams"
      ? claudeBriefType(manifest.bytes)
      : null;
    observation.runs.push({
      evidence_status: manifest.evidence_status,
      flow: document?.identity?.flow ?? claudeFlow,
      id: runId,
      implementation,
      reason: manifest.reason ?? null,
      sha256: manifest.sha256 ?? null,
    });
    if (document?.identity?.external_root) {
      const external = document.identity.external_root;
      observation.active_ownership.push({
        evidence_status: "uncertain",
        id: `${external.system}:${external.id}`,
        owner: runId,
        reason: "terminal_state_not_recorded_in_retained_manifest",
        state: "uncertain",
      });
    }
    if (implementation === "claude-agent-teams") {
      observation.active_ownership.push({
        evidence_status: "uncertain",
        id: `${runId}:external-root`,
        owner: runId,
        reason: "external_root_not_machine_readable_in_retained_brief",
        state: "uncertain",
      });
      observation.transcript_pointers.push({
        evidence_status: "uncertain",
        id: `${runId}:transcript`,
        path: null,
        reason: "native_transcript_not_machine_linked_to_retained_run",
        run_id: runId,
        sha256: null,
      });
      if (claudeFlow === "review") {
        observation.reviews.push({
          evidence_status: "uncertain",
          generation: null,
          id: `${runId}:review`,
          path: relative(root, manifestPath),
          reason: "review_lifecycle_not_machine_readable_in_retained_brief",
          status: null,
        });
      }
    }

    const artifactRoot = implementation === "hermes-agent-flow"
      ? join(runDirectory, "artifacts")
      : join(runDirectory, "out");
    for (const entry of await descendantEntries(artifactRoot)) {
      const evidence = entry.kind === "file"
        ? await fileEvidence(entry.path)
        : entry.kind === "symlink" ? {
            evidence_status: "uncertain",
            reason: "symbolic_link_not_followed",
          } : {
            evidence_status: "unreadable",
            reason: "directory_unreadable",
          };
      observation.artifacts.push({
        evidence_status: evidence.evidence_status,
        path: relative(root, entry.path),
        reason: evidence.reason ?? null,
        run_id: runId,
        sha256: evidence.sha256 ?? null,
      });
    }

    for (const entry of await runEvidenceEntries(runDirectory)) {
      if (entry.kind !== "file") {
        const evidence = entry.kind === "symlink" ? {
          evidence_status: "uncertain",
          reason: "symbolic_link_not_followed",
        } : {
          evidence_status: "unreadable",
          reason: "directory_unreadable",
        };
        addUnusableDocument({
          documentPath: entry.path,
          evidence,
          implementation,
          observation,
          root,
          runId,
        });
        if (isRetainedRecord(entry.path, runDirectory)) {
          observation.artifacts.push(retainedRecordEvidence({
            evidence,
            path: entry.path,
            root,
            runId,
          }));
        }
        continue;
      }
      const parsed = await jsonFileEvidence(entry.path);
      if (!parsed) {
        if (isRetainedRecord(entry.path, runDirectory)) {
          const evidence = await fileEvidence(entry.path);
          observation.artifacts.push(retainedRecordEvidence({
            evidence,
            path: entry.path,
            root,
            runId,
          }));
        }
        continue;
      }
      if (isRetainedRecord(entry.path, runDirectory)) {
        observation.artifacts.push(retainedRecordEvidence({
          evidence: parsed,
          path: entry.path,
          root,
          runId,
        }));
      }
      if (parsed.evidence_status !== "verified") {
        addUnusableDocument({
          documentPath: entry.path,
          evidence: parsed,
          implementation,
          observation,
          root,
          runId,
        });
        continue;
      }
      this.#observeDocument({
        document: parsed.document,
        documentPath: entry.path,
        implementation,
        observation,
        root,
        runId,
      });
    }
    if (
      implementation === "hermes-agent-flow" &&
      !observation.pending_transcripts.some(({ run_id: pendingRun }) =>
        pendingRun === runId
      )
    ) {
      observation.transcript_pointers.push({
        evidence_status: "uncertain",
        id: `${runId}:transcript`,
        path: null,
        reason: "retained_run_has_no_transcript_pointer",
        run_id: runId,
        sha256: null,
      });
    }
  }

  #observeDocument({
    document,
    documentPath,
    implementation,
    observation,
    root,
    runId,
  }) {
    if (isReviewRecord(documentPath)) {
      const reviewId = `${runId}:review`;
      const supported = document?.schema === REVIEW_SCHEMA;
      observation.reviews.push({
        evidence_status: supported ? "verified" : "uncertain",
        generation: document.review?.generation ?? null,
        id: reviewId,
        path: relative(root, documentPath),
        reason: supported
          ? null
          : `unsupported_schema:${document?.schema ?? "missing"}`,
        status: document.review?.status ?? null,
      });
      if (supported) {
        for (const [name, path] of Object.entries(document.artifacts ?? {})) {
          if (typeof path !== "string") continue;
          observation.pending_references.push({
            id: `${reviewId}:artifact:${name}`,
            path,
            root,
            run_id: runId,
          });
        }
      }
    }
    if (STACK_SCHEMAS.has(document?.schema)) {
      addStack(document, documentPath, implementation, observation, root);
    } else if (isStackRecord(documentPath)) {
      addUnusableStack({
        documentPath,
        evidenceStatus: "uncertain",
        implementation,
        observation,
        reason: `unsupported_schema:${document?.schema ?? "missing"}`,
        root,
      });
    }
    if (typeof document?.schema === "string" && document.schema.startsWith("agent-flow.")) {
      for (const effect of unresolvedEffects(document)) {
        observation.unresolved_effects.push({
          evidence_status: "verified",
          id: `${runId}:${relative(root, documentPath)}:${effect.path}`,
          kind: effect.kind,
          reason: "retained legacy record contains an unsettled effect",
          subject: runId,
        });
      }
    }
    for (const pointer of transcriptPointers(document)) {
      const path = pointer.value;
      const resolved = isAbsolute(path) ? path : resolve(dirname(documentPath), path);
      observation.pending_transcripts.push({
        id: `${runId}:${relative(root, documentPath)}:${pointer.key}`,
        path: resolved,
        root,
        run_id: runId,
      });
    }
  }

  async #observeStacks(observation) {
    const root = this.legacyRoots.hermesStacks;
    if (!root) {
      observation.sources.push({
        entry_count: 0,
        evidence_status: "uncertain",
        id: "hermes-agent-flow-stack-registry",
        reason: "operator_supplied_stack_paths_are_not_registered",
      });
      return;
    }
    const source = await sourceObservation("hermes-agent-flow-stacks", root);
    observation.sources.push(source);
    if (source.evidence_status !== "verified") return;
    for (const entry of await descendantEntries(root)) {
      if (entry.kind !== "file") {
        addUnusableStack({
          documentPath: entry.path,
          evidenceStatus: entry.kind === "symlink" ? "uncertain" : "unreadable",
          implementation: "hermes-agent-flow",
          observation,
          reason: entry.kind === "symlink"
            ? "symbolic_link_not_followed"
            : "directory_unreadable",
          root,
        });
        continue;
      }
      if (!entry.path.endsWith(".json")) continue;
      const parsed = await jsonFileEvidence(entry.path);
      if (parsed?.evidence_status === "verified" && STACK_SCHEMAS.has(parsed.document?.schema)) {
        addStack(
          parsed.document,
          entry.path,
          "hermes-agent-flow",
          observation,
          root,
        );
      } else {
        addUnusableStack({
          documentPath: entry.path,
          evidenceStatus: parsed?.evidence_status === "verified"
            ? "uncertain"
            : parsed?.evidence_status ?? "unreadable",
          implementation: "hermes-agent-flow",
          observation,
          reason: parsed?.evidence_status === "verified"
            ? `unsupported_schema:${parsed.document?.schema ?? "missing"}`
            : parsed?.reason ?? "unreadable_json",
          root,
        });
      }
    }
  }
}

function addUnusableDocument({
  documentPath,
  evidence,
  implementation,
  observation,
  root,
  runId,
}) {
  if (isReviewRecord(documentPath)) {
    observation.reviews.push({
      evidence_status: evidence.evidence_status,
      generation: null,
      id: `${runId}:review`,
      path: relative(root, documentPath),
      reason: evidence.reason,
      status: null,
    });
  }
  if (isStackRecord(documentPath)) {
    addUnusableStack({
      documentPath,
      evidenceStatus: evidence.evidence_status,
      implementation,
      observation,
      reason: evidence.reason,
      root,
    });
  }
}

function addUnusableStack({
  documentPath,
  evidenceStatus,
  implementation,
  observation,
  reason,
  root,
}) {
  observation.stacks.push({
    evidence_status: evidenceStatus,
    generation: null,
    id: `${implementation}-stack:record:${relative(root, documentPath)}`,
    path: relative(root, documentPath),
    reason,
    status: null,
  });
}

async function settleLegacyEvidence(observation) {
  for (const reference of observation.pending_references) {
    observation.artifacts.push(await projectedFileEvidence(reference));
  }
  for (const pointer of observation.pending_transcripts) {
    observation.transcript_pointers.push({
      ...await projectedFileEvidence(pointer),
      id: pointer.id,
    });
  }
  delete observation.pending_references;
  delete observation.pending_transcripts;
  observation.artifacts = uniqueEvidence(observation.artifacts);
  for (const values of Object.values(observation)) values.sort(byIdentity);
  return observation;
}

async function projectedFileEvidence({ id, path, root, run_id: runId }) {
  const projectedPath = relative(root, path);
  if (projectedPath.startsWith(`..${sep}`) || isAbsolute(projectedPath)) {
    return {
      evidence_status: "uncertain",
      id,
      path: "<outside-retained-root>",
      reason: "reference_outside_retained_root",
      run_id: runId,
      sha256: null,
    };
  }
  const evidence = await fileEvidence(path);
  return {
    evidence_status: evidence.evidence_status,
    path: projectedPath,
    reason: evidence.reason ?? null,
    run_id: runId,
    sha256: evidence.sha256 ?? null,
  };
}

function uniqueEvidence(values) {
  const unique = new Map();
  for (const value of values) {
    const identity = value.path === "<outside-retained-root>"
      ? value.id
      : value.path ?? value.id;
    const key = `${value.run_id ?? ""}:${identity}`;
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()];
}

function addStack(document, path, implementation, observation, root) {
  const generation = document.generation ?? 1;
  const runId = document.run_id ?? "unknown";
  const id = `${implementation}-stack:${runId}:generation-${generation}`;
  if (!observation.stacks.some((stack) => stack.id === id)) {
    observation.stacks.push({
      evidence_status: "verified",
      generation,
      id,
      path: relative(root, path),
      reason: null,
      status: document.status ?? document.approval?.status ?? null,
    });
  }
  if (["building", "failed", "publish_failed"].includes(document.status)) {
    observation.unresolved_effects.push({
      evidence_status: "verified",
      id: `${id}:publication`,
      kind: "stack_publication",
      reason: document.error ?? `stack remains ${document.status}`,
      subject: id,
    });
  }
}

function transcriptPointers(value, path = []) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => transcriptPointers(item, [...path, index]));
  }
  if (value === null || typeof value !== "object") return [];
  const pointers = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (/transcript(?:_path|_pointer)?$/iu.test(key) && typeof child === "string") {
      pointers.push({ key: childPath.join("."), value: child });
    } else {
      pointers.push(...transcriptPointers(child, childPath));
    }
  }
  return pointers;
}

function hasPendingValue(value) {
  if (value === null || value === false || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function unresolvedEffects(value, path = []) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => unresolvedEffects(item, [...path, index]));
  }
  if (value === null || typeof value !== "object") return [];
  const effects = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (key.startsWith("pending_") && hasPendingValue(child)) {
      effects.push({ kind: key.slice("pending_".length), path: childPath.join(".") });
      continue;
    }
    if (
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      ["pending", "reconciling", "uncertain"].includes(child.status)
    ) {
      effects.push({ kind: key, path: childPath.join(".") });
    }
    effects.push(...unresolvedEffects(child, childPath));
  }
  return effects;
}

function isReviewRecord(path) {
  return basename(path) === "review.json";
}

function claudeBriefType(bytes) {
  if (!bytes) return null;
  const frontmatter = bytes.toString("utf8").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  const type = frontmatter?.[1].match(/^type:\s*([a-z][a-z0-9_-]*)\s*$/imu);
  return type?.[1]?.toLowerCase() ?? null;
}

function isStackRecord(path) {
  return /stack.*\.json$/iu.test(basename(path));
}

async function jsonEvidence(path, expectedSchema) {
  const evidence = await fileEvidence(path);
  if (evidence.evidence_status !== "verified") return evidence;
  try {
    const document = JSON.parse(evidence.bytes.toString("utf8"));
    if (document?.schema !== expectedSchema) {
      return {
        ...evidence,
        document,
        evidence_status: "uncertain",
        reason: `unsupported_schema:${document?.schema ?? "missing"}`,
      };
    }
    return { ...evidence, document };
  } catch {
    return { ...evidence, evidence_status: "unreadable", reason: "invalid_json" };
  }
}

async function jsonFileEvidence(path) {
  if (!path.endsWith(".json")) return null;
  const evidence = await fileEvidence(path);
  if (evidence.evidence_status !== "verified") return evidence;
  try {
    return {
      ...evidence,
      document: JSON.parse(evidence.bytes.toString("utf8")),
      evidence_status: "verified",
    };
  } catch {
    return { ...evidence, evidence_status: "unreadable", reason: "invalid_json" };
  }
}

function isRetainedRecord(path, runDirectory) {
  const relativePath = relative(runDirectory, path);
  return !["brief.md", "run.json"].includes(relativePath) &&
    !/^(?:artifacts|out)(?:\/|$)/u.test(relativePath) &&
    !isReviewRecord(path) &&
    !isStackRecord(path);
}

function retainedRecordEvidence({ evidence, path, root, runId }) {
  return {
    evidence_status: evidence.evidence_status,
    path: relative(root, path),
    reason: evidence.reason ?? null,
    run_id: runId,
    sha256: evidence.sha256 ?? null,
  };
}

async function runEvidenceEntries(runDirectory) {
  return descendantEntries(runDirectory, {
    pruneAtDepth: 0,
    pruneDirectories: new Set(["repo", "worktree"]),
  });
}

function emptyObservation() {
  return {
    active_ownership: [],
    artifacts: [],
    pending_references: [],
    pending_transcripts: [],
    reviews: [],
    runs: [],
    sources: [],
    stacks: [],
    transcript_pointers: [],
    unresolved_effects: [],
  };
}

function byName(left, right) {
  return compareStrings(left.name, right.name);
}

function byIdentity(left, right) {
  return compareStrings(String(left.id ?? left.path), String(right.id ?? right.path));
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
