import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  access,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

import { digestCanonical } from "./canonical-json.mjs";

const execFileAsync = promisify(execFile);
const NATIVE_VERSION_TIMEOUT_MS = 5_000;
const NATIVE_COMMANDS = Object.freeze({ codex: "codex", claude: "claude" });

export const QUALIFICATION_TRUST_SCHEMA = "drovr.qualification-trust/v1";

export function trustPreflightNotApplicable({ reason = "deterministic_replay" } = {}) {
  return {
    schema: QUALIFICATION_TRUST_SCHEMA,
    status: "not_applicable",
    workspace: null,
    harnesses: {},
    configuration: {
      created: false,
      origin: "not_applicable",
      cleanup: "not_applicable",
    },
    native_work_started: false,
    binding: null,
    reason: { code: reason, message: "Deterministic replay does not launch a native harness." },
  };
}

export function trustPreflightNotRun({
  harnesses = [],
  workspace,
  reason = "runtime_prerequisites_unavailable",
} = {}) {
  const path = workspace ? resolve(workspace) : null;
  return {
    schema: QUALIFICATION_TRUST_SCHEMA,
    status: "not_run",
    workspace: path ? { path, identity: null } : null,
    harnesses: Object.fromEntries(
      [...new Set(harnesses)].map((harness) => [
        harness,
        {
          harness,
          status: "ambiguous",
          workspace: path ? { path, identity: null } : null,
          executable: null,
          integration: null,
          source: null,
          origin: "not_observed",
          reason: {
            code: reason,
            message: "Trust preflight was not run because native runtime prerequisites were unavailable.",
          },
          action: {
            code: "pretrust_exact_workspace",
            message: "Resolve the native runtime prerequisites, then pretrust the exact qualification workspace before rerunning.",
          },
        },
      ]),
    ),
    configuration: {
      created: false,
      origin: "not_observed",
      cleanup: "not_created",
    },
    native_work_started: false,
    binding: null,
    reason: {
      code: reason,
      message: "Trust preflight was not run because native runtime prerequisites were unavailable.",
    },
  };
}

export function trustPreflightReady(result, harnesses = []) {
  const selected = [...new Set(harnesses)];
  return (
    result?.schema === QUALIFICATION_TRUST_SCHEMA &&
    result.status === "trusted" &&
    result.native_work_started === false &&
    result.configuration?.created === false &&
    typeof result.workspace?.path === "string" &&
    typeof result.workspace?.identity === "string" &&
    typeof result.binding === "string" &&
    selected.length > 0 &&
    selected.every((harness) => {
      const observation = result.harnesses?.[harness];
      return (
        observation?.status === "trusted" &&
        observation.workspace?.path === result.workspace.path &&
        observation.workspace?.identity === result.workspace.identity &&
        typeof observation.executable?.path === "string" &&
        typeof observation.executable?.version === "string" &&
        typeof observation.integration?.id === "string" &&
        typeof observation.integration?.detail === "string" &&
        observation.source?.status === "present" &&
        typeof observation.source.path === "string" &&
        typeof observation.source.digest === "string" &&
        ["pre_existing", "created_for_run"].includes(observation.origin)
      );
    })
  );
}

export function classifyTrustObservation({
  harness,
  workspace,
  executable,
  expectedVersion,
  observedVersion,
  integration,
  source,
} = {}) {
  const base = {
    schema: QUALIFICATION_TRUST_SCHEMA,
    harness,
    workspace: workspace ?? null,
    executable: executable ?? null,
    integration: integration ?? null,
    source: evidenceSource(source),
    origin: "not_proven",
  };
  const fail = (status, code, message) => ({
    ...base,
    status,
    reason: { code, message },
    action: trustAction(harness, workspace, source),
  });

  if (!Object.hasOwn(NATIVE_COMMANDS, harness)) {
    return fail(
      "ambiguous",
      "unsupported_harness",
      `Trust preflight does not recognize harness ${String(harness)}.`,
    );
  }
  if (
    typeof workspace?.path !== "string" ||
    typeof workspace.identity !== "string" ||
    workspace.path.length === 0
  ) {
    return fail(
      "ambiguous",
      "workspace_identity_unavailable",
      `The exact ${harness} qualification workspace identity could not be observed.`,
    );
  }
  if (
    typeof executable?.path !== "string" ||
    typeof observedVersion !== "string" ||
    observedVersion.length === 0
  ) {
    return fail(
      "ambiguous",
      "native_executable_unavailable",
      `The exact ${harness} executable and version could not be observed.`,
    );
  }
  if (
    typeof expectedVersion !== "string" ||
    expectedVersion.length === 0 ||
    observedVersion !== expectedVersion
  ) {
    return fail(
      "changed",
      "native_executable_changed",
      `The ${harness} executable version changed between qualification checks: expected ${expectedVersion ?? "unavailable"}, observed ${observedVersion}.`,
    );
  }
  if (
    typeof integration?.id !== "string" ||
    !new RegExp(`^herdr-${harness}/v\\d+$`, "u").test(integration.id) ||
    typeof integration.detail !== "string" ||
    !/^current \(v\d+\)$/u.test(integration.detail)
  ) {
    return fail(
      "ambiguous",
      "native_integration_unavailable",
      `The exact current Herdr ${harness} integration could not be observed.`,
    );
  }
  if (source?.status === "changed") {
    return fail(
      "changed",
      "trust_configuration_changed",
      `The ${harness} trust configuration changed while it was being observed.`,
    );
  }
  if (source?.status === "ambiguous") {
    return fail(
      "ambiguous",
      "trust_configuration_ambiguous",
      `The ${harness} trust configuration is missing, malformed, or contains conflicting exact-workspace observations.`,
    );
  }
  if (source?.status === "missing") {
    return fail(
      "untrusted",
      "qualification_workspace_untrusted",
      `The ${harness} trust configuration does not contain an exact trusted entry for ${workspace.path}.`,
    );
  }
  if (source?.status !== "present") {
    return fail(
      "ambiguous",
      "trust_configuration_unavailable",
      `The ${harness} trust configuration could not be observed safely.`,
    );
  }
  if (source.workspace_path !== workspace.path) {
    return fail(
      "changed",
      "trust_workspace_changed",
      `The ${harness} trust observation is bound to ${source.workspace_path ?? "an unknown workspace"}, not ${workspace.path}.`,
    );
  }
  if (source.entry === "missing") {
    return fail(
      "untrusted",
      "qualification_workspace_untrusted",
      `The ${harness} trust configuration has no exact entry for ${workspace.path}; parent trust is not inherited.`,
    );
  }
  if (
    source.trust_level === "trusted" ||
    (harness === "claude" && source.trust_level === true)
  ) {
    return {
      ...base,
      status: "trusted",
      origin: "pre_existing",
      reason: null,
      action: null,
    };
  }
  if (
    source.trust_level === "untrusted" ||
    source.trust_level === false
  ) {
    return fail(
      "untrusted",
      "qualification_workspace_untrusted",
      `The exact ${harness} qualification workspace is explicitly untrusted.`,
    );
  }
  return fail(
    "ambiguous",
    "trust_observation_ambiguous",
    `The exact ${harness} trust value for ${workspace.path} is not a recognized native trust state.`,
  );
}

export async function preflightQualificationTrust({
  harnesses,
  workspace,
  env = process.env,
  versions = {},
  resolveExecutable = resolveNativeExecutable,
  readVersion = readNativeVersion,
  readSource = readNativeTrustSource,
} = {}) {
  const selected = [...new Set(harnesses ?? [])];
  const workspaceObservation = await observeWorkspace(workspace);
  const observations = {};

  for (const harness of selected) {
    const sourcePath = nativeTrustConfigPath(harness, env);
    let source;
    try {
      source = await readSource({
        harness,
        path: sourcePath,
        workspacePath: workspaceObservation.path,
      });
    } catch (error) {
      source = {
        status: "ambiguous",
        path: sourcePath,
        digest: null,
        workspace_path: workspaceObservation.path,
        entry: "unreadable",
        trust_level: null,
        error: errorMessage(error),
      };
    }

    let executable = null;
    let observedVersion = null;
    let executableError;
    try {
      executable = await resolveExecutable(NATIVE_COMMANDS[harness], env);
      observedVersion = await readVersion(executable, env);
    } catch (error) {
      executableError = errorMessage(error);
    }
    const observation = classifyTrustObservation({
      harness,
      workspace: workspaceObservation,
      executable: executable
        ? { ...executable, version: observedVersion }
        : null,
      expectedVersion: versions[harness],
      observedVersion,
      integration: integrationFacts(harness, versions.integration?.[harness]),
      source: executableError
        ? {
            ...source,
            status: "ambiguous",
            error: executableError,
          }
        : source,
    });
    observations[harness] = observation;
  }

  const trusted = selected.length > 0 && selected.every(
    (harness) => observations[harness]?.status === "trusted",
  );
  const result = {
    schema: QUALIFICATION_TRUST_SCHEMA,
    status: trusted ? "trusted" : "blocked",
    workspace: workspaceObservation,
    harnesses: observations,
    configuration: {
      created: false,
      origin: "pre_existing_or_missing",
      cleanup: "not_created",
    },
    native_work_started: false,
    binding: null,
    reason: trusted
      ? null
      : firstReason(observations) ?? {
          code: "trust_preflight_incomplete",
          message: "Trust preflight did not produce a trusted observation for every selected harness.",
        },
  };
  result.binding = digestCanonical({
    workspace: result.workspace,
    harnesses: Object.fromEntries(
      selected.map((harness) => [harness, observations[harness]]),
    ),
  });
  return result;
}

export async function resolveNativeExecutable(command, env = process.env) {
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const candidates = command.includes("/")
    ? [command]
    : pathValue
        .split(delimiter)
        .filter((directory) => directory.length > 0)
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const canonicalPath = await realpath(candidate);
      const metadata = await stat(canonicalPath);
      if (!metadata.isFile()) continue;
      return {
        path: canonicalPath,
        lookup_path: resolve(candidate),
      };
    } catch {
      // Continue through PATH entries until the first executable is found.
    }
  }
  throw new Error(`cannot resolve executable ${command} from PATH`);
}

export async function readNativeVersion(executable, env = process.env) {
  const { stdout, stderr } = await execFileAsync(executable.path, ["--version"], {
    cwd: env.PWD,
    env: { ...env },
    encoding: "utf8",
    timeout: NATIVE_VERSION_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
  const line = `${stdout ?? ""}\n${stderr ?? ""}`
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (!line) throw new Error(`executable ${executable.path} returned no version`);
  return line;
}

export async function readNativeTrustSource({ harness, path, workspacePath }) {
  const snapshot = await readStableFile(path);
  if (snapshot.status !== "present") {
    return {
      ...snapshot,
      workspace_path: workspacePath,
      entry: snapshot.status === "missing" ? "missing" : "unreadable",
      trust_level: null,
    };
  }
  const parsed = harness === "codex"
    ? parseCodexTrust(snapshot.content, workspacePath)
    : harness === "claude"
      ? parseClaudeTrust(snapshot.content, workspacePath)
      : (() => {
          throw new Error(`unsupported trust harness ${harness}`);
        })();
  const { content: _content, ...safeSnapshot } = snapshot;
  return { ...safeSnapshot, ...parsed };
}

function nativeTrustConfigPath(harness, env) {
  const home = env.HOME ?? homedir();
  if (harness === "codex") {
    return join(env.CODEX_HOME ?? join(home, ".codex"), "config.toml");
  }
  if (harness === "claude") {
    return join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json");
  }
  return resolve(home, `.${harness}.json`);
}

async function observeWorkspace(workspace) {
  const fallback = { path: resolve(workspace ?? "."), identity: null };
  try {
    const path = await realpath(workspace);
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw new Error("qualification workspace is not a directory");
    return {
      path,
      identity: digestCanonical({
        path,
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode,
      }),
    };
  } catch (error) {
    return { ...fallback, error: errorMessage(error) };
  }
}

async function readStableFile(path) {
  const normalizedPath = resolve(path);
  let before;
  let content;
  let after;
  try {
    before = await stat(normalizedPath);
    content = await readFile(normalizedPath, "utf8");
    after = await stat(normalizedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        status: "missing",
        path: normalizedPath,
        digest: null,
        content: null,
      };
    }
    return {
      status: "ambiguous",
      path: normalizedPath,
      digest: null,
      content: null,
      error: errorMessage(error),
    };
  }
  const beforeToken = fileMetadataToken(before);
  const afterToken = fileMetadataToken(after);
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (beforeToken !== afterToken) {
    return {
      status: "changed",
      path: normalizedPath,
      digest,
      content,
      snapshot: { before: beforeToken, after: afterToken },
    };
  }
  return {
    status: "present",
    path: normalizedPath,
    digest,
    content,
    snapshot: beforeToken,
  };
}

function parseCodexTrust(content, workspacePath) {
  const entries = new Map();
  let current;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const header = projectHeader(line);
    if (header) {
      current = entries.get(header) ?? {
        path: header,
        headers: 0,
        trustValues: [],
      };
      current.headers += 1;
      entries.set(header, current);
      continue;
    }
    if (!current || !line.includes("=")) continue;
    const assignment = /^(trust_level)\s*=\s*(.+)$/u.exec(line);
    if (!assignment) continue;
    current.trustValues.push(parseTomlScalar(assignment[2]));
  }
  const entry = entries.get(workspacePath);
  if (!entry) {
    return {
      workspace_path: workspacePath,
      entry: "missing",
      trust_level: null,
    };
  }
  if (entry.headers !== 1 || entry.trustValues.length !== 1) {
    throw new Error(`conflicting Codex trust entries for ${workspacePath}`);
  }
  return {
    workspace_path: workspacePath,
    entry: "present",
    trust_level: entry.trustValues[0],
  };
}

function parseClaudeTrust(content, workspacePath) {
  const document = JSON.parse(content);
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    throw new Error("Claude trust configuration root is not an object");
  }
  if (document.projects === undefined) {
    return {
      workspace_path: workspacePath,
      entry: "missing",
      trust_level: null,
    };
  }
  if (
    document.projects === null ||
    typeof document.projects !== "object" ||
    Array.isArray(document.projects)
  ) {
    throw new Error("Claude trust projects entry is not an object");
  }
  if (!Object.hasOwn(document.projects, workspacePath)) {
    return {
      workspace_path: workspacePath,
      entry: "missing",
      trust_level: null,
    };
  }
  const project = document.projects[workspacePath];
  if (
    project === null ||
    typeof project !== "object" ||
    Array.isArray(project) ||
    !Object.hasOwn(project, "hasTrustDialogAccepted")
  ) {
    throw new Error(`ambiguous Claude trust entry for ${workspacePath}`);
  }
  if (typeof project.hasTrustDialogAccepted !== "boolean") {
    throw new Error(`invalid Claude trust value for ${workspacePath}`);
  }
  return {
    workspace_path: workspacePath,
    entry: "present",
    trust_level: project.hasTrustDialogAccepted,
  };
}

function projectHeader(line) {
  const basic = /^\[projects\."((?:\\.|[^"])*)"\]$/u.exec(line);
  if (basic) return decodeTomlBasicString(basic[1]);
  const literal = /^\[projects\.'((?:''|[^'])*)'\]$/u.exec(line);
  if (literal) return literal[1].replaceAll("''", "'");
  return null;
}

function parseTomlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) throw new Error("unterminated TOML string");
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed;
}

function decodeTomlBasicString(value) {
  return JSON.parse(`"${value}"`);
}

function stripTomlComment(line) {
  let quoted = false;
  let literal = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && !literal && !escaped) quoted = !quoted;
    if (character === "'" && !quoted) literal = !literal;
    if (character === "#" && !quoted && !literal) return line.slice(0, index);
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  return line;
}

function fileMetadataToken(metadata) {
  return [
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.mtimeMs,
    metadata.mode,
  ].join(":");
}

function evidenceSource(source) {
  if (!source) return null;
  const result = {
    status: source.status ?? "ambiguous",
    path: source.path ?? null,
    digest: source.digest ?? null,
    workspace_path: source.workspace_path ?? null,
    entry: source.entry ?? null,
    trust_level: Object.hasOwn(source, "trust_level")
      ? source.trust_level
      : null,
  };
  if (source.error) result.error = source.error;
  if (source.snapshot) result.snapshot = source.snapshot;
  return result;
}

function trustAction(harness, workspace, source) {
  const path = workspace?.path ?? "the exact qualification workspace";
  const configuration = source?.path ?? `the ${harness} native trust configuration`;
  return {
    code: "pretrust_exact_workspace",
    configuration,
    message: `Pretrust the exact ${harness} qualification workspace ${path} using its documented native trust control, then rerun qualification. The runner will not submit native keys or accept an unclassified prompt.`,
  };
}

function integrationFacts(harness, detail) {
  if (typeof detail !== "string") return null;
  const match = /^current \(v(\d+)\)$/u.exec(detail);
  return match
    ? { id: `herdr-${harness}/v${match[1]}`, detail }
    : { id: null, detail };
}

function firstReason(observations) {
  return Object.values(observations).find(({ reason }) => reason)?.reason ?? null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
