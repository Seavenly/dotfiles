#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import {
  createQualificationIsolation,
  isolatedQualificationEnvironment,
} from "../src/host-recovery-qualification.mjs";
import {
  runDrovrRegistryLockProbe,
  runProductionBackupRestoreProbe,
} from "../src/host-recovery-live-support.mjs";

const REQUIRED = [
  "worktree",
  "raw-root",
  "temporary-root",
  "xdg-state-home",
  "authority-directory",
  "socket",
  "endpoint",
  "backup-directory",
  "repository-root",
  "drovr-config-directory",
  "qualification-workspace",
  "herdr-session",
  "run-id",
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!new Set(["backup_restore", "drovr_lock"]).has(options.probe)) {
    throw new NativeProbeError(
      "native_probe_kind_invalid",
      "--probe must be backup_restore or drovr_lock",
    );
  }
  for (const key of REQUIRED) requiredAbsolute(options, key, key === "herdr-session" || key === "run-id");
  assertBelowTemporaryRoot(options["temporary-root"], [
    options["xdg-state-home"],
    options["authority-directory"],
    options["socket"],
    options["endpoint"],
    options["backup-directory"],
    options["repository-root"],
    options["drovr-config-directory"],
    options["qualification-workspace"],
  ]);
  const isolation = createQualificationIsolation({
    worktreeRoot: options.worktree,
    xdgStateHome: options["xdg-state-home"],
    authorityDirectory: options["authority-directory"],
    socketPath: options.socket,
    endpointPath: options.endpoint,
    backupDirectory: options["backup-directory"],
    repositoryRoot: options["repository-root"],
    drovrConfigDirectory: options["drovr-config-directory"],
    qualificationWorkspace: options["qualification-workspace"],
    herdrSession: options["herdr-session"],
    runId: options["run-id"],
  });
  const timeoutMs = boundedTimeout(options.timeout);
  const setup = options.probe === "backup_restore"
    ? prepareDisposableInputs({ isolation, timeoutMs })
    : prepareDrovrLockInputs({ isolation });
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = options["temporary-root"];
  let result;
  try {
    if (options.probe === "backup_restore") {
      result = await runProductionBackupRestoreProbe({
        authorityDirectory: isolation.authority_directory,
        backupDirectory: isolation.backup_directory,
        repositoryRoot: isolation.repository_root,
        drovrConfigDirectory: isolation.drovr_config_directory,
        rawRoot: options["raw-root"],
        env: {
          ...isolatedQualificationEnvironment(isolation),
          TMPDIR: options["temporary-root"],
        },
        timeoutMs,
      });
    } else {
      result = await runDrovrRegistryLockProbe({
        nodePath: process.execPath,
        registryModulePath: join(isolation.worktree_root, "tools/drovr/src/registry.mjs"),
        registryDirectory: join(isolation.drovr_config_directory, "registry"),
        rawRoot: options["raw-root"],
        resourceKey: `issue-46:${isolation.run_id}`,
        timeoutMs,
      });
    }
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
  const watermark = result.proof?.backup?.watermark ??
    result.proof?.reconciliation?.watermark ??
    result.provider?.watermark ?? null;
  const legalActions = Array.isArray(result.proof?.backup?.legal_actions)
    ? result.proof.backup.legal_actions
    : result.reconciliation?.legal_next_actions ?? [];
  const output = options.probe === "backup_restore"
    ? {
      ...result,
      setup,
      watermark,
      legal_actions: legalActions,
    }
    : {
      ...result,
      setup,
      status: result.reconciliation?.reconciled === true ? "pass" : "blocked",
      reason: result.reconciliation?.reconciled === true
        ? null
        : "drovr_lock_reconciliation_incomplete",
      watermark,
      legal_actions: legalActions,
    };
  process.stdout.write(`${JSON.stringify({
    ...output,
  })}\n`);
}

function prepareDrovrLockInputs({ isolation }) {
  for (const [path, label] of [
    [isolation.xdg_state_home, "XDG state"],
    [isolation.authority_directory, "Flow authority"],
    [isolation.backup_directory, "backup"],
    [isolation.repository_root, "repository"],
    [isolation.drovr_config_directory, "Drovr config"],
    [isolation.qualification_workspace, "qualification workspace"],
  ]) {
    prepareEmptyDirectory(path, label);
  }
  return {
    schema: "flow.native-drovr-lock-setup/v1",
    registry_directory: join(isolation.drovr_config_directory, "registry"),
    isolated_roots: [
      isolation.xdg_state_home,
      isolation.authority_directory,
      isolation.backup_directory,
      isolation.repository_root,
      isolation.drovr_config_directory,
      isolation.qualification_workspace,
    ],
  };
}

function prepareDisposableInputs({ isolation, timeoutMs }) {
  const repository = prepareEmptyDirectory(isolation.repository_root, "repository");
  const drovr = prepareEmptyDirectory(isolation.drovr_config_directory, "Drovr config");
  const sourceDrovr = join(isolation.worktree_root, "config", "drovr");
  assertRegularDirectory(sourceDrovr, "pinned Drovr config");
  assertNoSymlinkTree(sourceDrovr, "pinned Drovr config");
  cpSync(sourceDrovr, drovr, { recursive: true, force: false, errorOnExist: false });
  const repositoryFile = join(repository, "README.md");
  writeFileSync(repositoryFile, "issue-46 native backup restore\n", { flag: "wx", mode: 0o600 });
  execFileSync("git", ["-C", repository, "init", "--quiet", "--initial-branch", "main"], {
    timeout: timeoutMs,
    stdio: "ignore",
  });
  execFileSync("git", ["-C", repository, "config", "user.email", "flow@example.test"], {
    timeout: timeoutMs,
    stdio: "ignore",
  });
  execFileSync("git", ["-C", repository, "config", "user.name", "Flow Qualification"], {
    timeout: timeoutMs,
    stdio: "ignore",
  });
  execFileSync("git", ["-C", repository, "add", "README.md"], {
    timeout: timeoutMs,
    stdio: "ignore",
  });
  execFileSync("git", ["-C", repository, "commit", "--quiet", "-m", "issue-46 native probe"], {
    timeout: timeoutMs,
    stdio: "ignore",
  });
  return {
    schema: "flow.native-backup-restore-setup/v1",
    repository: {
      initialized: true,
      commit: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
        timeout: timeoutMs,
        encoding: "utf8",
      }).trim(),
      tree: execFileSync("git", ["-C", repository, "rev-parse", "HEAD^{tree}"], {
        timeout: timeoutMs,
        encoding: "utf8",
      }).trim(),
      content_sha256: directoryDigest(repository),
    },
    drovr_config: {
      copied: true,
      source_ref: "config/drovr",
      content_sha256: directoryDigest(drovr),
    },
  };
}

function prepareEmptyDirectory(path, label) {
  if (existsSync(path)) {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new NativeProbeError("native_probe_root_invalid", `${label} root is not a real directory`);
    }
    if (readdirSync(path).length > 0) {
      throw new NativeProbeError("native_probe_root_not_empty", `${label} root contains pre-existing content`);
    }
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return path;
}

function assertRegularDirectory(path, label) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new NativeProbeError("native_probe_source_invalid", `${label} is not a real directory`);
  }
}

function assertBelowTemporaryRoot(root, paths) {
  for (const path of paths) {
    const candidate = relative(root, path);
    if (candidate === ".." || candidate.startsWith("../") || candidate.startsWith("..\\") || candidate === "") {
      throw new NativeProbeError(
        "native_probe_root_not_temporary",
        `isolated path must be below the explicit temporary root: ${path}`,
      );
    }
  }
}

function assertNoSymlinkTree(path, label) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new NativeProbeError("native_probe_source_symlink", `${label} contains a symlink`);
    }
    if (entry.isDirectory()) assertNoSymlinkTree(child, label);
  }
}

function directoryDigest(root) {
  const files = [];
  collectFiles(root, root, files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`;
}

function collectFiles(root, current, output) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, path, output);
      continue;
    }
    if (!entry.isFile()) {
      throw new NativeProbeError("native_probe_content_invalid", "disposable setup contains a non-regular entry");
    }
    const bytes = readFileSync(path);
    output.push({
      path: relative(root, path),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
}

function parseArgs(args) {
  const options = {};
  const keys = new Set([
    "--probe",
    ...REQUIRED.map((key) => `--${key}`),
    "--timeout",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!keys.has(flag)) throw new NativeProbeError("native_probe_argument_invalid", `unknown argument: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new NativeProbeError("native_probe_argument_invalid", `missing value for ${flag}`);
    }
    options[flag.slice(2)] = value;
    index += 1;
  }
  return options;
}

function requiredAbsolute(options, key, allowIdentity = false) {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new NativeProbeError("native_probe_argument_invalid", `--${key} is required`);
  }
  if (!allowIdentity && !value.startsWith("/")) {
    throw new NativeProbeError("native_probe_argument_invalid", `--${key} must be absolute`);
  }
}

function boundedTimeout(value) {
  if (value === undefined) return 120_000;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 100 || number > 300_000) {
    throw new NativeProbeError("native_probe_timeout_invalid", "timeout must be between 100 and 300000ms");
  }
  return number;
}

class NativeProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NativeProbeError";
    this.code = code;
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = error?.code === "native_probe_argument_invalid" ||
    error?.code === "native_probe_kind_invalid" ||
    error?.code === "native_probe_timeout_invalid" ? 2 : 1;
});
