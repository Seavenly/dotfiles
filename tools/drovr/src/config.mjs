import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DrovrError } from "./errors.mjs";

const CAPABILITIES = [
  "read-only",
  "on-approve",
  "workspace-write",
  "auto",
  "unrestricted",
];
const EFFORTS = ["low", "medium", "high", "xhigh"];
const CODEX_CAPABILITY_CONTRACT = {
  "read-only": {
    sandbox: "read-only",
    approval: "never",
    search: false,
  },
  "on-approve": {
    sandbox: "read-only",
    approval: "on-request",
    approvals_reviewer: "user",
    search: false,
  },
  "workspace-write": {
    sandbox: "workspace-write",
    approval: "on-request",
    approvals_reviewer: "user",
    search: false,
    network_access: false,
  },
  auto: {
    sandbox: "workspace-write",
    approval: "on-request",
    approvals_reviewer: "auto_review",
    search: true,
    network_access: false,
  },
  unrestricted: {
    sandbox: "danger-full-access",
    approval: "never",
    search: false,
  },
};

function stripComment(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && !escaped) quoted = !quoted;
    if (character === "#" && !quoted) return line.slice(0, index);
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  return line;
}

function parseValue(value, path, lineNumber) {
  try {
    if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new Error("unterminated string");
      return value.slice(1, -1);
    }
    return JSON.parse(value);
  } catch (error) {
    throw new DrovrError(
      `${path}:${lineNumber}: unsupported TOML value (${error.message})`,
    );
  }
}

export function parseToml(source, path = "config.toml") {
  const document = {};
  let table = document;
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const tableMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/u);
    if (tableMatch) {
      table = document;
      for (const part of tableMatch[1].split(".")) {
        table[part] ??= {};
        table = table[part];
      }
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u);
    if (!assignment) {
      throw new DrovrError(`${path}:${index + 1}: invalid TOML statement`);
    }
    table[assignment[1]] = parseValue(assignment[2], path, index + 1);
  }
  return document;
}

async function loadToml(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new DrovrError(`cannot read configuration ${path}: ${error.message}`);
  }
  return { document: parseToml(source, path), source };
}

function validateCapability(name, document, path) {
  if (document.schema !== "drovr.capability/v1") {
    throw new DrovrError(`${path}: expected schema drovr.capability/v1`);
  }
  if (!document.codex || !document.claude) {
    throw new DrovrError(`${path}: codex and claude mappings are required`);
  }
  const { sandbox, approval, approvals_reviewer: reviewer } = document.codex;
  if (
    !["read-only", "workspace-write", "danger-full-access"].includes(sandbox)
  ) {
    throw new DrovrError(`${path}: invalid Codex sandbox for ${name}`);
  }
  if (!["on-request", "never"].includes(approval)) {
    throw new DrovrError(`${path}: invalid Codex approval policy for ${name}`);
  }
  if (
    approval === "on-request" &&
    !["user", "auto_review"].includes(reviewer)
  ) {
    throw new DrovrError(
      `${path}: invalid Codex approvals reviewer for ${name}`,
    );
  }
  if (
    JSON.stringify(document.codex) !==
    JSON.stringify(CODEX_CAPABILITY_CONTRACT[name])
  ) {
    throw new DrovrError(
      `${path}: Codex mapping does not match the ${name} contract`,
    );
  }
}

export function configurationDirectory(env = process.env) {
  return (
    env.DROVR_CONFIG_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"), "drovr")
  );
}

export async function loadConfiguration({ env = process.env } = {}) {
  const directory = configurationDirectory(env);
  const rootPath = join(directory, "config.toml");
  const root = await loadToml(rootPath);
  if (root.document.schema !== "drovr.config/v1") {
    throw new DrovrError(`${rootPath}: expected schema drovr.config/v1`);
  }
  const defaults = root.document.defaults ?? {};
  if (defaults.harness !== "codex") {
    throw new DrovrError(
      `${rootPath}: the initial slice supports default harness codex`,
    );
  }
  if (!defaults.model || !EFFORTS.includes(defaults.effort)) {
    throw new DrovrError(`${rootPath}: invalid model or effort default`);
  }
  if (!CAPABILITIES.includes(defaults.capability)) {
    throw new DrovrError(`${rootPath}: invalid capability default`);
  }

  const capabilities = {};
  const fingerprints = {};
  fingerprints[rootPath] = createHash("sha256")
    .update(root.source)
    .digest("hex");
  for (const name of CAPABILITIES) {
    const path = join(directory, "capabilities", `${name}.toml`);
    const loaded = await loadToml(path);
    validateCapability(name, loaded.document, path);
    capabilities[name] = loaded.document;
    fingerprints[path] = createHash("sha256")
      .update(loaded.source)
      .digest("hex");
  }

  const roles = {};
  let roleEntries = [];
  try {
    roleEntries = await readdir(join(directory, "roles"), {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new DrovrError(`cannot read role catalog: ${error.message}`);
    }
  }
  for (const entry of roleEntries.filter((candidate) =>
    candidate.isDirectory(),
  )) {
    const roleDirectory = join(directory, "roles", entry.name);
    const rolePath = join(roleDirectory, "role.toml");
    const loaded = await loadToml(rolePath);
    if (loaded.document.schema !== "drovr.role/v1") {
      throw new DrovrError(`${rolePath}: expected schema drovr.role/v1`);
    }
    const roleDefaults = loaded.document.defaults ?? {};
    if (roleDefaults.harness && roleDefaults.harness !== "codex") {
      throw new DrovrError(`${rolePath}: unsupported default harness`);
    }
    if (roleDefaults.effort && !EFFORTS.includes(roleDefaults.effort)) {
      throw new DrovrError(`${rolePath}: invalid effort default`);
    }
    if (
      roleDefaults.capability &&
      !CAPABILITIES.includes(roleDefaults.capability)
    ) {
      throw new DrovrError(`${rolePath}: invalid capability default`);
    }
    const instructionPaths = [
      join(roleDirectory, "instructions.md"),
      join(roleDirectory, "codex.md"),
    ];
    const instructions = [];
    for (const path of instructionPaths) {
      try {
        const source = await readFile(path, "utf8");
        instructions.push(source.trim());
        fingerprints[path] = createHash("sha256").update(source).digest("hex");
      } catch (error) {
        if (path.endsWith("instructions.md") || error.code !== "ENOENT") {
          throw new DrovrError(
            `cannot read role instructions ${path}: ${error.message}`,
          );
        }
      }
    }
    fingerprints[rolePath] = createHash("sha256")
      .update(loaded.source)
      .digest("hex");
    roles[entry.name] = {
      defaults: roleDefaults,
      instructions: instructions.filter(Boolean).join("\n\n"),
    };
  }

  return {
    directory,
    session: root.document.session ?? "delegates",
    defaults,
    capabilities,
    roles,
    fingerprints,
  };
}

export function resolveLaunchSpecification(configuration, options = {}) {
  const role = options.role ? configuration.roles[options.role] : null;
  if (options.role && !role) {
    throw new DrovrError(`unknown role: ${options.role}`, {
      outcome: "unsupported_configuration",
      code: 0,
    });
  }
  const roleDefaults = role?.defaults ?? {};
  const harness =
    options.harness ?? roleDefaults.harness ?? configuration.defaults.harness;
  const model =
    options.model ?? roleDefaults.model ?? configuration.defaults.model;
  const effort =
    options.effort ?? roleDefaults.effort ?? configuration.defaults.effort;
  const capability =
    options.capability ??
    roleDefaults.capability ??
    configuration.defaults.capability;
  if (harness !== "codex") {
    throw new DrovrError("this slice supports only --harness codex", {
      outcome: "unsupported_configuration",
      code: 0,
    });
  }
  if (
    !model ||
    !EFFORTS.includes(effort) ||
    !configuration.capabilities[capability]
  ) {
    throw new DrovrError("unsupported Codex launch configuration", {
      outcome: "unsupported_configuration",
      code: 0,
    });
  }
  const selectedFingerprints = Object.fromEntries(
    Object.entries(configuration.fingerprints).filter(
      ([path]) =>
        path.endsWith("/config.toml") ||
        path.endsWith(`/capabilities/${capability}.toml`) ||
        (options.role && path.includes(`/roles/${options.role}/`)),
    ),
  );
  return {
    harness,
    role: options.role ?? null,
    instructions: role?.instructions ?? "",
    model,
    effort,
    capability,
    native: configuration.capabilities[capability].codex,
    catalog_fingerprints: selectedFingerprints,
  };
}
