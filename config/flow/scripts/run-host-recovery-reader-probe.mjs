#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  createQualificationIsolation,
  resolvePinnedEntrypoints,
} from "../src/host-recovery-qualification.mjs";
import {
  HostRecoveryReaderIntegrationError,
  runReaderProbe,
} from "../src/host-recovery-reader-integration.mjs";

const PATH_OPTIONS = Object.freeze([
  "worktree",
  "raw-root",
  "xdg-state-home",
  "authority-directory",
  "socket",
  "endpoint",
  "backup-directory",
  "repository-root",
  "drovr-config-directory",
  "qualification-workspace",
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const probe = normalizeProbe(options.probe ?? options.scenario);
  const paths = Object.fromEntries(PATH_OPTIONS.map((name) => [
    name,
    requiredAbsolute(options, name),
  ]));
  const herdrSession = required(options, "herdr-session");
  const runId = required(options, "run-id");
  const temporaryRoot = dirname(paths["xdg-state-home"]);
  for (const [name, path] of Object.entries(paths)) {
    if (name !== "worktree") assertUnderTemporaryRoot(path, name, temporaryRoot);
  }
  mkdirSync(paths["raw-root"], { recursive: true, mode: 0o700 });
  const isolation = createQualificationIsolation({
    worktreeRoot: paths.worktree,
    xdgStateHome: paths["xdg-state-home"],
    authorityDirectory: paths["authority-directory"],
    socketPath: paths.socket,
    endpointPath: paths.endpoint,
    backupDirectory: paths["backup-directory"],
    repositoryRoot: paths["repository-root"],
    drovrConfigDirectory: paths["drovr-config-directory"],
    qualificationWorkspace: paths["qualification-workspace"],
    herdrSession,
    runId,
  });
  const entrypoints = resolvePinnedEntrypoints({ worktreeRoot: paths.worktree });
  const timeoutMs = options.timeout === undefined
    ? 120_000
    : Number(options.timeout);
  const result = await runReaderProbe({
    probe,
    entrypoints,
    isolation,
    rawRoot: paths["raw-root"],
    timeoutMs,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      throw new ReaderProbeCliError("argument_invalid", `unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (key.length === 0 || index + 1 >= args.length || args[index + 1].startsWith("--")) {
      throw new ReaderProbeCliError("argument_value_missing", `missing value for --${key}`);
    }
    options[key] = args[index + 1];
    index += 1;
  }
  return options;
}

function normalizeProbe(value) {
  if (value === "projection" || value === "projection_rebuild_readers" ||
      value === "native_projection_reader_probe") return "projection";
  if (value === "suspended" || value === "suspended_run_admission" ||
      value === "native_suspended_admission_check") return "suspended";
  throw new ReaderProbeCliError(
    "probe_invalid",
    "--probe must be projection or suspended",
  );
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ReaderProbeCliError("argument_required", `--${name} is required`);
  }
  return value;
}

function requiredAbsolute(options, name) {
  const value = required(options, name);
  if (!isAbsolute(value)) {
    throw new ReaderProbeCliError("path_not_absolute", `--${name} must be absolute`);
  }
  return resolve(value);
}

function assertUnderTemporaryRoot(path, label, temporaryRoot) {
  const suffix = relative(resolve(temporaryRoot), resolve(path));
  if (suffix === "" || suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix)) {
    throw new ReaderProbeCliError(
      "path_not_temporary",
      `--${label} must be below ${temporaryRoot}`,
    );
  }
}

class ReaderProbeCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReaderProbeCliError";
    this.code = code;
  }
}

main().catch((error) => {
  const code = error?.code ?? "reader_probe_failed";
  const message = error?.message ?? String(error);
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = error instanceof HostRecoveryReaderIntegrationError ? 2 : 1;
});
