import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OWNER_RUNTIME_BINDING_SCHEMA = "flow.owner-runtime-binding/v1";

const DEFAULT_OWNER_SCRIPT = fileURLToPath(new URL("./owner-process.mjs", import.meta.url));
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export class OwnerRuntimeBindingError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "OwnerRuntimeBindingError";
    this.code = code;
  }
}

/**
 * Select the governed release tree used for public qualification. The
 * disposable FLOW_REPOSITORY_ROOT is intentionally not considered here: it
 * is a production backup/restore boundary, never a release authority.
 */
export function qualificationRepositoryRootFor({
  env = process.env,
  configDirectory,
} = {}) {
  const configured = env.FLOW_QUALIFICATION_REPOSITORY_ROOT;
  if (configured !== undefined) {
    const root = absolutePath(configured, "qualification_repository_root");
    if (!isGovernedRepositoryRoot(root)) {
      throw new OwnerRuntimeBindingError(
        "owner_runtime_binding_unavailable",
        "configured qualification repository is not governed",
      );
    }
    return root;
  }
  const configRoot = absolutePath(
    configDirectory ?? env.FLOW_CONFIG_DIRECTORY,
    "config_directory",
  );
  const derived = resolve(dirname(configRoot), "..");
  if (!isGovernedRepositoryRoot(derived)) {
    throw new OwnerRuntimeBindingError(
      "owner_runtime_binding_unavailable",
      "governed qualification repository cannot be derived from config directory",
    );
  }
  return derived;
}

export function isGovernedRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || !isAbsolutePath(repositoryRoot)) {
    return false;
  }
  try {
    const rootInfo = lstatSync(repositoryRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return isRegularFile(join(repositoryRoot, "config/flow/evidence/release-content.v1.json")) &&
    isRegularFile(join(repositoryRoot, "tools/flow/src/flow-runtime.mjs"));
}

/** Derive the immutable identity the detached child must revalidate. */
export function deriveOwnerRuntimeBinding({
  env = process.env,
  ownerScript = DEFAULT_OWNER_SCRIPT,
} = {}) {
  const runtimeModulePath = absolutePath(
    env.FLOW_OWNER_RUNTIME_MODULE ?? join(dirname(ownerScript), "runtime.mjs"),
    "runtime_module_path",
  );
  const configDirectory = absolutePath(
    env.FLOW_CONFIG_DIRECTORY ?? join(dirname(runtimeModulePath), ".."),
    "config_directory",
  );
  const qualificationRepositoryRoot = qualificationRepositoryRootFor({
    env,
    configDirectory,
  });
  const releaseContentPath = join(
    configDirectory,
    "evidence/release-content.v1.json",
  );
  const releaseContentBytes = readRegularFile(
    releaseContentPath,
    "release_content_unavailable",
  );
  let releaseContent;
  try {
    releaseContent = JSON.parse(releaseContentBytes.toString("utf8"));
  } catch {
    throw new OwnerRuntimeBindingError(
      "owner_runtime_binding_unavailable",
      "release content is not valid JSON",
    );
  }
  if (releaseContent?.schema !== "flow.release-content/v1" ||
      !DIGEST.test(releaseContent.content_digest ?? "")) {
    throw new OwnerRuntimeBindingError(
      "owner_runtime_binding_unavailable",
      "release content digest is unavailable",
    );
  }
  return Object.freeze({
    schema: OWNER_RUNTIME_BINDING_SCHEMA,
    runtime_module_path: runtimeModulePath,
    runtime_module_sha256: fileDigest(runtimeModulePath, "runtime_module_unavailable"),
    config_directory: configDirectory,
    config_directory_sha256: directoryDigest(configDirectory),
    qualification_repository_root: qualificationRepositoryRoot,
    release_content_digest: releaseContent.content_digest,
    release_content_bytes_sha256: bytesDigest(releaseContentBytes),
  });
}

/**
 * Recompute and compare the binding before the child imports its runtime.
 * This is deliberately synchronous so no runtime/provider code can execute
 * before the fail-closed check completes.
 */
export function assertOwnerRuntimeBinding({
  env = process.env,
  ownerScript = DEFAULT_OWNER_SCRIPT,
} = {}) {
  const encoded = env.FLOW_OWNER_RUNTIME_BINDING;
  if (encoded === undefined) return deriveOwnerRuntimeBinding({ env, ownerScript });
  let expected;
  try {
    expected = JSON.parse(encoded);
  } catch {
    throw new OwnerRuntimeBindingError(
      "owner_runtime_binding_mismatch",
      "owner runtime binding is not valid JSON",
    );
  }
  if (!validOwnerRuntimeBinding(expected)) {
    throw new OwnerRuntimeBindingError(
      "owner_runtime_binding_mismatch",
      "owner runtime binding has an invalid shape",
    );
  }
  const actual = deriveOwnerRuntimeBinding({ env, ownerScript });
  if (!sameBinding(expected, actual)) {
    throw new OwnerRuntimeBindingError(
      "owner_runtime_binding_mismatch",
      "owner runtime binding changed before child load",
    );
  }
  return actual;
}

export function validOwnerRuntimeBinding(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) &&
    value.schema === OWNER_RUNTIME_BINDING_SCHEMA &&
    absoluteValue(value.runtime_module_path) &&
    DIGEST.test(value.runtime_module_sha256 ?? "") &&
    absoluteValue(value.config_directory) &&
    DIGEST.test(value.config_directory_sha256 ?? "") &&
    absoluteValue(value.qualification_repository_root) &&
    DIGEST.test(value.release_content_digest ?? "") &&
    DIGEST.test(value.release_content_bytes_sha256 ?? "") &&
    Object.keys(value).sort().join(",") === [
      "config_directory",
      "config_directory_sha256",
      "qualification_repository_root",
      "release_content_bytes_sha256",
      "release_content_digest",
      "runtime_module_path",
      "runtime_module_sha256",
      "schema",
    ].join(",");
}

export function ownerRuntimeBindingEqual(left, right) {
  return validOwnerRuntimeBinding(left) &&
    validOwnerRuntimeBinding(right) &&
    JSON.stringify(left) === JSON.stringify(right);
}

function sameBinding(left, right) {
  return validOwnerRuntimeBinding(left) && validOwnerRuntimeBinding(right) &&
    Object.keys(right).every((key) => left[key] === right[key]);
}

function directoryDigest(root) {
  const entries = [];
  walkDirectory(root, "", entries);
  const hash = createHash("sha256");
  for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(`${entry.path}\0${entry.mode}\0${entry.sha256}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function walkDirectory(root, relative, entries) {
  const directory = join(root, relative);
  let children;
  try {
    children = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new OwnerRuntimeBindingError(
      "owner_runtime_binding_unavailable",
      `cannot inspect config directory: ${error?.code ?? "read_error"}`,
    );
  }
  for (const child of children) {
    if (child.name === "node_modules" || child.name === ".git") continue;
    const childRelative = relative ? join(relative, child.name) : child.name;
    const childPath = join(root, childRelative);
    const info = lstatSync(childPath);
    if (info.isSymbolicLink()) {
      throw new OwnerRuntimeBindingError(
        "owner_runtime_binding_unavailable",
        `config directory contains a symlink: ${childRelative}`,
      );
    }
    if (info.isDirectory()) {
      walkDirectory(root, childRelative, entries);
    } else if (info.isFile()) {
      entries.push({
        path: childRelative,
        mode: info.mode & 0o7777,
        sha256: bytesDigest(readFileSync(childPath)),
      });
    } else {
      throw new OwnerRuntimeBindingError(
        "owner_runtime_binding_unavailable",
        `config directory contains unsupported entry: ${childRelative}`,
      );
    }
  }
}

function fileDigest(path, code) {
  return bytesDigest(readRegularFile(path, code));
}

function bytesDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readRegularFile(path, code) {
  if (!isRegularFile(path)) {
    throw new OwnerRuntimeBindingError(code, `required file is unavailable: ${path}`);
  }
  try {
    return readFileSync(path);
  } catch (error) {
    throw new OwnerRuntimeBindingError(
      code,
      `required file cannot be read: ${error?.code ?? "read_error"}`,
    );
  }
}

function isRegularFile(path) {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function absolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolutePath(value)) {
    throw new OwnerRuntimeBindingError(
      "owner_runtime_binding_unavailable",
      `${name} must be absolute`,
    );
  }
  return resolve(value);
}

function isAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/");
}

function absoluteValue(value) {
  return isAbsolutePath(value) && value === resolve(value);
}
