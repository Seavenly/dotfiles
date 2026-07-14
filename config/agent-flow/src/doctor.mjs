import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import {
  createHermesProfileInspector,
  defaultHermesRunner,
} from "./hermes-profile-inspector.mjs";
import {
  PROFILE_CATALOG,
  PROFILE_NAMES,
  SUPPORTED_HERMES_VERSIONS,
} from "./profile-catalog.mjs";
import { inspectProfileCredentials } from "./profile-credentials.mjs";


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

export async function doctorProfiles({
  home = process.env.HOME,
  runHermes = defaultHermesRunner(
    process.env.AGENT_FLOW_HERMES_BIN ?? "hermes",
  ),
  inspectProfile,
} = {}) {
  if (!home) throw new Error("HOME is required");
  const checks = [];
  const profiles = [];

  let versionOutput = "";
  try {
    versionOutput = await runHermes(["--version"]);
    const match = versionOutput.match(/Hermes Agent v(\d+\.\d+\.\d+)/);
    const version = match?.[1];
    const compatible = SUPPORTED_HERMES_VERSIONS.includes(version);
    checks.push({
      id: "hermes-version",
      ok: Boolean(compatible),
      summary: compatible
        ? `Validated Hermes ${version}`
        : "Hermes version is not validated",
      details: compatible
        ? []
        : [
            match
              ? `Found ${version}; validated version: ${SUPPORTED_HERMES_VERSIONS.join(", ")}`
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
  const nativeFailures = [];
  const configuredOwners = [];
  let effectiveProfileInspector = inspectProfile;
  if (!effectiveProfileInspector) {
    try {
      effectiveProfileInspector = createHermesProfileInspector({
        home,
        versionOutput,
      });
    } catch (error) {
      effectiveProfileInspector = async () => {
        throw error;
      };
    }
  }
  for (const name of PROFILE_NAMES) {
    const contract = PROFILE_CATALOG[name];
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
    if (!sameMembers(configuredToolsets, contract.configuredToolsets)) {
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
      if (!sameMembers(enabledToolsets, contract.enabledToolsets)) {
        toolFailures.push(
          `${name}: Hermes reported ${enabledToolsets.join(", ") || "no"} enabled CLI toolsets`,
        );
      }
    } catch (error) {
      toolFailures.push(
        `${name}: could not inspect Hermes tools (${error.message})`,
      );
    }
    let workerTools = [];
    try {
      const inspection = await effectiveProfileInspector(name);
      workerTools = inspection.tools.toSorted();
      workerSchemaCount = workerTools.length;
      if (!sameMembers(workerTools, contract.workerTools)) {
        const unexpected = workerTools.filter(
          (tool) => !contract.workerTools.includes(tool),
        );
        const missing = contract.workerTools.filter(
          (tool) => !workerTools.includes(tool),
        );
        const unexpectedSummary = unexpected.join(", ") || "none";
        const missingSummary = missing.join(", ") || "none";
        toolFailures.push(
          `${name}: worker tools differ from the managed contract ` +
            `(unexpected: ${unexpectedSummary}; missing: ${missingSummary})`,
        );
      }
      if (inspection.dispatchInGateway !== (name === "flow-controller")) {
        nativeFailures.push(
          `${name}: Hermes loaded kanban.dispatch_in_gateway=${inspection.dispatchInGateway}`,
        );
      }
      if (inspection.autoDecompose !== false) {
        nativeFailures.push(
          `${name}: Hermes loaded kanban.auto_decompose=${inspection.autoDecompose}`,
        );
      }
    } catch (error) {
      toolFailures.push(
        `${name}: could not inspect worker tool schemas (${error.message})`,
      );
      nativeFailures.push(
        `${name}: could not inspect native profile configuration (${error.message})`,
      );
    }

    const credentials = await inspectProfileCredentials({
      config,
      home,
      profileHome,
    });
    credentialFailures.push(
      ...credentials.failures.map((failure) => `${name}: ${failure}`),
    );
    profiles.push({
      name,
      available: Boolean(provider && model && credentials.available),
      provider: provider ?? null,
      model: model ?? null,
      providers: credentials.providers,
      configuredToolsets,
      enabledToolsets,
      workerSchemaCount,
      workerTools,
      dispatchOwner: config.kanban?.dispatch_in_gateway === true,
      note: contract.note ?? null,
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
  checks.push({
    id: "native-config",
    ok: nativeFailures.length === 0,
    summary:
      nativeFailures.length === 0
        ? "Hermes accepts the managed profile invariants"
        : "Hermes loaded unsafe profile settings",
    details: nativeFailures,
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
