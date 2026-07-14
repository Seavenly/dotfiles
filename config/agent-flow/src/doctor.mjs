import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";

import { PROFILE_NAMES } from "./profiles.mjs";

const execFileAsync = promisify(execFile);
const EXPECTED_TOOLSETS = {
  "flow-controller": ["kanban", "no_mcp"],
  analyst: ["file", "web", "no_mcp"],
  critic: ["file", "web", "no_mcp"],
  builder: ["file", "terminal", "no_mcp"],
  artifact: ["file", "no_mcp"],
  gate: ["terminal", "no_mcp"],
};
const MINIMUM_WORKER_SCHEMAS = {
  "flow-controller": 7,
  analyst: 11,
  critic: 11,
  builder: 13,
  artifact: 11,
  gate: 9,
};
const PROVIDER_ENV = {
  anthropic: [
    "ANTHROPIC_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ],
  "openai-codex": ["OPENAI_CODEX_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  nous: ["NOUS_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

async function readYaml(path) {
  return parse(await readFile(path, "utf8"));
}

function sameMembers(left, right) {
  return (
    left.length === right.length && left.every((item) => right.includes(item))
  );
}

function parseEnabledToolsets(output) {
  return output
    .split("\n")
    .map((line) => line.match(/enabled\s+([^\s]+)/)?.[1])
    .filter(Boolean);
}

function envValues(contents) {
  return new Map(
    contents
      .split("\n")
      .map((line) =>
        line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/),
      )
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
}

function envValueIsPresent(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return false;
  return !/^(?:""|'')(?:\s*#.*)?$/.test(trimmed);
}

function hasCredentialValue(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (
      typeof child === "string" &&
      child.trim().length > 0 &&
      /(apikey|token|secret|password|agentkey)/.test(normalized)
    ) {
      return true;
    }
    if (hasCredentialValue(child)) return true;
  }
  return false;
}

async function authStoreHasProvider(path, provider) {
  try {
    const auth = JSON.parse(await readFile(path, "utf8"));
    return hasCredentialValue(auth.providers?.[provider]);
  } catch {
    return false;
  }
}

async function credentialFileHasValue(path) {
  try {
    return hasCredentialValue(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return false;
  }
}

async function credentialAvailable({ home, profileHome, provider }) {
  if (await authStoreHasProvider(join(profileHome, "auth.json"), provider))
    return true;
  if (await authStoreHasProvider(join(home, ".hermes", "auth.json"), provider))
    return true;

  const keys = new Set(
    PROVIDER_ENV[provider] ?? [
      `${provider.replaceAll("-", "_").toUpperCase()}_API_KEY`,
    ],
  );
  if ([...keys].some((key) => Boolean(process.env[key]))) return true;
  for (const envFile of [
    join(profileHome, ".env"),
    join(home, ".hermes", ".env"),
  ]) {
    try {
      const present = envValues(await readFile(envFile, "utf8"));
      if ([...keys].some((key) => envValueIsPresent(present.get(key) ?? "")))
        return true;
    } catch {
      // A missing profile-local environment file is normal.
    }
  }

  if (
    provider === "openai-codex" &&
    (await credentialFileHasValue(join(home, ".codex", "auth.json")))
  ) {
    return true;
  }
  if (
    provider === "anthropic" &&
    (await credentialFileHasValue(join(home, ".claude", ".credentials.json")))
  ) {
    return true;
  }
  return false;
}

async function activeDispatchOwners(home, runHermes) {
  const output = await runHermes(["gateway", "list"]);
  const activeProfiles = output
    .split("\n")
    .map((line) => line.match(/^\s*✓\s+([^\s(]+)/)?.[1])
    .filter(Boolean);
  const owners = [];
  for (const name of activeProfiles) {
    const profileHome =
      name === "default"
        ? join(home, ".hermes")
        : join(home, ".hermes", "profiles", name);
    let config = {};
    try {
      config = await readYaml(join(profileHome, "config.yaml"));
    } catch {
      // Hermes defaults dispatch ownership to enabled when the key is absent.
    }
    if (config?.kanban?.dispatch_in_gateway !== false) owners.push(name);
  }
  return owners;
}

function defaultHermesRunner(binary) {
  return async (args, options = {}) => {
    const { stdout } = await execFileAsync(binary, args, {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
    });
    return stdout;
  };
}

export async function doctorProfiles({
  home = process.env.HOME,
  runHermes = defaultHermesRunner(
    process.env.AGENT_FLOW_HERMES_BIN ?? "hermes",
  ),
} = {}) {
  if (!home) throw new Error("HOME is required");
  const checks = [];
  const profiles = [];

  try {
    const versionOutput = await runHermes(["--version"]);
    const match = versionOutput.match(/Hermes Agent v(\d+)\.(\d+)\.(\d+)/);
    const compatible =
      match &&
      Number(match[1]) === 0 &&
      Number(match[2]) === 18 &&
      Number(match[3]) >= 2;
    checks.push({
      id: "hermes-version",
      ok: Boolean(compatible),
      summary: compatible
        ? `Compatible Hermes ${match[0].replace("Hermes Agent v", "")}`
        : "Hermes version is not validated",
      details: compatible
        ? []
        : [
            match
              ? `Found ${match[1]}.${match[2]}.${match[3]}; expected >=0.18.2 <0.19.0`
              : "Could not parse Hermes version",
          ],
    });
  } catch (error) {
    checks.push({
      id: "hermes-version",
      ok: false,
      summary: "Hermes is unavailable",
      details: [error.message],
    });
  }

  const routingFailures = [];
  const credentialFailures = [];
  const toolFailures = [];
  const configuredOwners = [];
  for (const name of PROFILE_NAMES) {
    const profileHome = join(home, ".hermes", "profiles", name);
    let config;
    try {
      config = await readYaml(join(profileHome, "config.yaml"));
    } catch (error) {
      routingFailures.push(`${name}: config unavailable (${error.message})`);
      profiles.push({ name, available: false, enabledToolsets: [] });
      continue;
    }

    const provider = config.model?.provider;
    const model = config.model?.default ?? config.model?.model;
    if (!provider || !model)
      routingFailures.push(`${name}: model routing is incomplete`);
    if (config.kanban?.dispatch_in_gateway === true)
      configuredOwners.push(name);

    const configuredToolsets = config.platform_toolsets?.cli ?? [];
    if (!sameMembers(configuredToolsets, EXPECTED_TOOLSETS[name])) {
      toolFailures.push(
        `${name}: configured toolsets differ from the managed contract`,
      );
    }

    let enabledToolsets = [];
    let workerSchemaCount = null;
    try {
      enabledToolsets = parseEnabledToolsets(
        await runHermes(["-p", name, "tools", "list", "--platform", "cli"]),
      );
      const expectedNative = configuredToolsets.filter(
        (toolset) => toolset !== "kanban" && toolset !== "no_mcp",
      );
      if (!sameMembers(enabledToolsets, expectedNative)) {
        toolFailures.push(
          `${name}: Hermes reported ${enabledToolsets.join(", ") || "no"} enabled CLI toolsets`,
        );
      }
    } catch (error) {
      toolFailures.push(
        `${name}: could not inspect Hermes tools (${error.message})`,
      );
    }
    try {
      const breakdown = JSON.parse(
        await runHermes(
          ["-p", name, "prompt-size", "--platform", "cli", "--json"],
          {
            env: { HERMES_KANBAN_TASK: "agent-flow-doctor-inspection" },
          },
        ),
      );
      workerSchemaCount = breakdown.tools?.count;
      if (
        !Number.isInteger(workerSchemaCount) ||
        workerSchemaCount < MINIMUM_WORKER_SCHEMAS[name]
      ) {
        toolFailures.push(
          `${name}: worker context exposed ${workerSchemaCount ?? "an unknown number of"} tool schemas`,
        );
      }
    } catch (error) {
      toolFailures.push(
        `${name}: could not inspect worker tool schemas (${error.message})`,
      );
    }

    const hasCredential = provider
      ? await credentialAvailable({ home, profileHome, provider })
      : false;
    if (!hasCredential) {
      credentialFailures.push(
        `${name}: no credential source found for ${provider ?? "unconfigured provider"}`,
      );
    }
    profiles.push({
      name,
      available: Boolean(provider && model && hasCredential),
      provider: provider ?? null,
      model: model ?? null,
      configuredToolsets,
      enabledToolsets,
      workerSchemaCount,
      dispatchOwner: config.kanban?.dispatch_in_gateway === true,
      note: ["analyst", "critic"].includes(name)
        ? "Hermes v0.18.2 bundles write operations into the read-oriented file toolset; the profile contract forbids their use."
        : null,
    });
  }

  const builderProvider = profiles.find(
    ({ name }) => name === "builder",
  )?.provider;
  const criticProvider = profiles.find(
    ({ name }) => name === "critic",
  )?.provider;
  if (builderProvider && criticProvider && builderProvider === criticProvider) {
    routingFailures.push("critic and builder providers are not independent");
  }
  checks.push({
    id: "routing",
    ok: routingFailures.length === 0,
    summary:
      routingFailures.length === 0
        ? "All six routes are complete and independent"
        : "Profile routing is incomplete",
    details: routingFailures,
  });
  checks.push({
    id: "credentials",
    ok: credentialFailures.length === 0,
    summary:
      credentialFailures.length === 0
        ? "Credential sources are available"
        : "Credential sources are unavailable",
    details: credentialFailures,
  });

  const dispatchFailures = [];
  if (!sameMembers(configuredOwners, ["flow-controller"])) {
    dispatchFailures.push(
      `configured dispatch owners: ${configuredOwners.join(", ") || "none"}`,
    );
  }
  try {
    const activeOwners = await activeDispatchOwners(home, runHermes);
    if (!sameMembers(activeOwners, ["flow-controller"])) {
      dispatchFailures.push(
        `active dispatch owners: ${activeOwners.join(", ") || "none"}`,
      );
    }
  } catch (error) {
    dispatchFailures.push(
      `could not inspect active gateways (${error.message})`,
    );
  }
  checks.push({
    id: "dispatch-owner",
    ok: dispatchFailures.length === 0,
    summary:
      dispatchFailures.length === 0
        ? "Flow controller is the single active dispatcher"
        : "Dispatcher ownership is unsafe",
    details: dispatchFailures,
  });
  checks.push({
    id: "toolsets",
    ok: toolFailures.length === 0,
    summary:
      toolFailures.length === 0
        ? "Hermes toolsets match the managed contracts"
        : "Hermes toolsets differ from the managed contracts",
    details: toolFailures,
  });

  return { ok: checks.every(({ ok }) => ok), checks, profiles };
}
