import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import {
  createHermesProfileInspector,
  defaultHermesRunner,
} from "./hermes-profile-inspector.mjs";
import { resolveHermesRoot } from "./hermes-home.mjs";
import {
  PROFILE_CATALOG,
  PROFILE_CONCURRENCY,
  PROFILE_NAMES,
  SUPPORTED_HERMES_VERSIONS,
} from "./profile-catalog.mjs";
import { inspectProfileCredentials } from "./profile-credentials.mjs";
import {
  profileConfigurationFingerprint,
  profileSetFingerprint,
} from "./profile-fingerprint.mjs";


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

function enabledStatus(inspection, key) {
  if (!inspection) return "unknown";
  return inspection[key] ? "enabled" : "disabled";
}

function terminalCredentialPosture({
  enabled,
  gatewaySecretsFiltered,
  normalCliCredentialsReachable,
  providerSecretsFilteredByDefault,
}) {
  if (!enabled) return "Terminal tools are not exposed by this profile.";
  if (
    !normalCliCredentialsReachable ||
    !providerSecretsFilteredByDefault ||
    !gatewaySecretsFiltered
  ) {
    return "The terminal trust probe did not establish the managed credential posture.";
  }
  return (
    "Real-home and OS-keychain CLI credentials are reachable, and " +
    "ordinary non-blocklisted environment variables are inherited. " +
    "Hermes filters provider secret environment variables by default " +
    "unless an env_passthrough skill explicitly re-enables one; gateway " +
    "secrets remain filtered."
  );
}

async function activeDispatchOwners(hermesHome, runHermes) {
  const output = await runHermes(["gateway", "list"]);
  const activeProfiles = output
    .split("\n")
    .map((line) => line.match(/^\s*✓\s+([^\s(]+)/)?.[1])
    .filter(Boolean);
  const owners = [];
  for (const name of activeProfiles) {
    const profileHome =
      name === "default"
        ? hermesHome
        : join(hermesHome, "profiles", name);
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
  hermesHome = process.env.HERMES_HOME,
  runHermes = defaultHermesRunner(
    process.env.AGENT_FLOW_HERMES_BIN ?? "hermes",
  ),
  inspectProfile,
} = {}) {
  if (!home) throw new Error("HOME is required");
  hermesHome = resolveHermesRoot({ hermesHome, home });
  const checks = [];
  const profiles = [];

  let versionOutput = "";
  let hermesVersion = null;
  try {
    versionOutput = await runHermes(["--version"]);
    const match = versionOutput.match(/Hermes Agent v(\d+\.\d+\.\d+)/);
    hermesVersion = match?.[1] ?? null;
    const compatible = SUPPORTED_HERMES_VERSIONS.includes(hermesVersion);
    checks.push({
      id: "hermes-version",
      ok: Boolean(compatible),
      summary: compatible
        ? `Validated Hermes ${hermesVersion}`
        : "Hermes version is not validated",
      details: compatible
        ? []
        : [
            match
              ? `Found ${hermesVersion}; validated version: ${SUPPORTED_HERMES_VERSIONS.join(", ")}`
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
  const trustFailures = [];
  const trustDetails = [];
  const configuredOwners = [];
  let effectiveProfileInspector = inspectProfile;
  if (!effectiveProfileInspector) {
    try {
      effectiveProfileInspector = createHermesProfileInspector({
        home,
        hermesHome,
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
    const profileHome = join(hermesHome, "profiles", name);
    let config;
    try {
      config = await readYaml(join(profileHome, "config.yaml"));
    } catch (error) {
      routingFailures.push(`${name}: config unavailable (${error.message})`);
      trustFailures.push(`${name}: trust posture is unavailable`);
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
    let workerToolsMatch = false;
    let inspection = null;
    try {
      inspection = await effectiveProfileInspector(name);
      workerTools = inspection.tools.toSorted();
      workerSchemaCount = workerTools.length;
      workerToolsMatch = sameMembers(workerTools, contract.workerTools);
      if (!workerToolsMatch) {
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
        trustFailures.push(
          `${name}: effective worker schemas do not establish the managed trust posture`,
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
      if (inspection.terminalBackend !== "local") {
        trustFailures.push(
          `${name}: Hermes loaded terminal.backend=${inspection.terminalBackend}`,
        );
      }
      if (inspection.terminalHomeMode !== "real") {
        trustFailures.push(
          `${name}: Hermes loaded terminal.home_mode=${inspection.terminalHomeMode}`,
        );
      }
      if (inspection.memoryEnabled !== false) {
        trustFailures.push(
          `${name}: Hermes loaded memory.memory_enabled=${inspection.memoryEnabled}`,
        );
      }
      if (inspection.userProfileEnabled !== false) {
        trustFailures.push(
          `${name}: Hermes loaded memory.user_profile_enabled=${inspection.userProfileEnabled}`,
        );
      }
      const concurrencyKeys = [
        ["maxInProgress", "max_in_progress"],
        ["maxInProgressPerProfile", "max_in_progress_per_profile"],
        ["maxSpawn", "max_spawn"],
      ];
      for (const [key, nativeKey] of concurrencyKeys) {
        if (inspection.concurrency[key] !== PROFILE_CONCURRENCY[key]) {
          trustFailures.push(
            `${name}: Hermes loaded kanban.${nativeKey}=${inspection.concurrency[key]}`,
          );
        }
      }
      if (contract.terminal) {
        const terminalProbeChecks = [
          ["homeIsOsUserHome", "terminal HOME is not the OS-user HOME"],
          ["homeReadable", "terminal cannot read the OS-user HOME"],
          [
            "ordinaryEnvInherited",
            "terminal did not inherit an ordinary environment sentinel",
          ],
          [
            "providerSecretFilteredByDefault",
            "terminal did not apply default provider-secret filtering",
          ],
          [
            "gatewaySecretFiltered",
            "terminal did not filter a gateway-secret sentinel",
          ],
        ];
        for (const [key, failure] of terminalProbeChecks) {
          if (!inspection.terminalProbe[key]) {
            trustFailures.push(`${name}: ${failure}`);
          }
        }
        if (new Set(["flow-controller", "gate"]).has(name) && !inspection.terminalProbe.agentFlowPath) {
          trustFailures.push(
            `${name}: terminal cannot resolve the agent-flow command`,
          );
        }
      }
    } catch (error) {
      toolFailures.push(
        `${name}: could not inspect worker tool schemas (${error.message})`,
      );
      nativeFailures.push(
        `${name}: could not inspect native profile configuration (${error.message})`,
      );
      trustFailures.push(
        `${name}: could not verify host-local trust posture (${error.message})`,
      );
    }

    const credentials = await inspectProfileCredentials({
      config,
      hermesHome,
      home,
      profileHome,
    });
    credentialFailures.push(
      ...credentials.failures.map((failure) => `${name}: ${failure}`),
    );
    const terminalEnabled = contract.terminal;
    const realHomeTerminal = Boolean(
      terminalEnabled &&
        inspection?.terminalBackend === "local" &&
        inspection?.terminalHomeMode === "real" &&
        inspection?.terminalProbe?.homeIsOsUserHome &&
        inspection?.terminalProbe?.homeReadable,
    );
    const ordinaryEnvironmentInherited = Boolean(
      realHomeTerminal && inspection?.terminalProbe?.ordinaryEnvInherited,
    );
    const providerSecretsFilteredByDefault = Boolean(
      terminalEnabled &&
        inspection?.terminalProbe?.providerSecretFilteredByDefault,
    );
    const gatewaySecretsFiltered = Boolean(
      terminalEnabled && inspection?.terminalProbe?.gatewaySecretFiltered,
    );
    const normalCliCredentialsReachable =
      realHomeTerminal && ordinaryEnvironmentInherited;
    const technicallyEnforced = [
      `worker tool schemas: ${workerTools.join(", ") || "unavailable"}`,
      inspection && workerToolsMatch
        ? "MCP tools unavailable in the effective worker schemas"
        : "MCP absence not established because worker schemas differ or are unavailable",
      `Hermes memory ${enabledStatus(inspection, "memoryEnabled")}; ` +
        `user profile ${enabledStatus(inspection, "userProfileEnabled")}`,
      `automatic Kanban decomposition ${enabledStatus(inspection, "autoDecompose")}`,
      `loaded concurrency: ${inspection?.concurrency?.maxInProgress ?? "unknown"} global, ` +
        `${inspection?.concurrency?.maxInProgressPerProfile ?? "unknown"} per profile, and ` +
        `${inspection?.concurrency?.maxSpawn ?? "unknown"} spawned tasks`,
      `Kanban gateway dispatch ${enabledStatus(inspection, "dispatchInGateway")}`,
    ];
    const availableTerminalTools = ["terminal", "process"].filter((tool) =>
      workerTools.includes(tool),
    );
    if (availableTerminalTools.length > 0) {
      technicallyEnforced.push(
        `available terminal schemas: ${availableTerminalTools.join(", ")}; ` +
          `backend ${inspection?.terminalBackend ?? "unknown"} with ` +
          `${inspection?.terminalHomeMode ?? "unknown"} HOME mode`,
      );
    } else {
      technicallyEnforced.push(
        inspection
          ? "terminal and process tools are unavailable"
          : "terminal and process tool posture is unavailable",
      );
    }
    const trust = {
      execution: "host-local",
      filesystemSandbox: false,
      technicallyEnforced,
      contractOnly: contract.contractOnly,
      terminal: {
        enabled: terminalEnabled,
        backend: inspection?.terminalBackend ?? null,
        homeMode: inspection?.terminalHomeMode ?? null,
        inheritsRealUserHome: realHomeTerminal,
        homeReadable: inspection?.terminalProbe?.homeReadable ?? null,
        ordinaryEnvironmentInherited,
        normalCliCredentialsReachable,
        agentFlowCommandReachable:
          terminalEnabled && inspection
            ? Boolean(inspection.terminalProbe.agentFlowPath)
            : null,
        providerSecretsFilteredByDefault:
          terminalEnabled && inspection
            ? providerSecretsFilteredByDefault
            : null,
        gatewaySecretsFiltered:
          terminalEnabled && inspection ? gatewaySecretsFiltered : null,
        credentialPosture: terminalCredentialPosture({
          enabled: terminalEnabled,
          gatewaySecretsFiltered,
          normalCliCredentialsReachable,
          providerSecretsFilteredByDefault,
        }),
      },
    };
    trustDetails.push(
      `${name}: host-local, filesystem sandbox=no; ` +
        (terminalEnabled
          ? `terminal=${inspection?.terminalBackend ?? "unknown"}, ` +
            `HOME=${realHomeTerminal ? "real user" : "not real user"}, ` +
            `normal CLI credentials=${ordinaryEnvironmentInherited ? "reachable" : "not established"}, ` +
            `provider env secrets=${providerSecretsFilteredByDefault ? "filtered by default" : "not filtered by default"}, ` +
            `gateway secrets=${gatewaySecretsFiltered ? "filtered" : "not filtered"}; `
          : "terminal=unavailable; ") +
        `technically-enforced=${technicallyEnforced.join(" | ")}; ` +
        `contract-only=${contract.contractOnly.join(" | ")}`,
    );
    const configurationFingerprint = inspection
      ? profileConfigurationFingerprint({
          config,
          hermesVersion: hermesVersion ?? "unvalidated",
          inspection,
          name,
        })
      : null;
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
      concurrency: inspection?.concurrency ?? null,
      trust,
      configurationFingerprint,
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
  checks.push({
    id: "trust-posture",
    ok: trustFailures.length === 0,
    summary:
      trustFailures.length === 0
        ? "Host-local profile trust posture is explicit"
        : "Host-local profile trust posture differs from policy",
    details: [...trustFailures, ...trustDetails],
  });

  const dispatchFailures = [];
  if (!sameMembers(configuredOwners, ["flow-controller"])) {
    dispatchFailures.push(
      `configured dispatch owners: ${configuredOwners.join(", ") || "none"}`,
    );
  }
  try {
    const activeOwners = await activeDispatchOwners(hermesHome, runHermes);
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

  const fingerprintedProfiles = profiles.filter(
    ({ configurationFingerprint }) => configurationFingerprint,
  );
  const configurationSetFingerprint =
    fingerprintedProfiles.length === PROFILE_NAMES.length
      ? profileSetFingerprint(fingerprintedProfiles)
      : null;
  return {
    ok: checks.every(({ ok }) => ok),
    profileSetFingerprint: configurationSetFingerprint,
    checks,
    profiles,
  };
}
