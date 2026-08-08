import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { doctorProfiles } from "../src/doctor.mjs";
import { inspectProfileCredentials } from "../src/profile-credentials.mjs";
import { PROFILE_NAMES, renderProfiles } from "../src/profiles.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const expectedToolsets = {
  "flow-controller": ["terminal"],
  analyst: ["web", "file"],
  critic: ["web", "file"],
  builder: ["terminal", "file"],
  artifact: ["file"],
  gate: ["terminal"],
};
const kanbanTools = [
  "kanban_block",
  "kanban_comment",
  "kanban_complete",
  "kanban_create",
  "kanban_heartbeat",
  "kanban_link",
  "kanban_show",
];
const fileTools = ["patch", "read_file", "search_files", "write_file"];
const expectedWorkerTools = {
  "flow-controller": [...kanbanTools, "process", "terminal"],
  analyst: [...kanbanTools, ...fileTools],
  critic: [...kanbanTools, ...fileTools],
  builder: [...kanbanTools, ...fileTools, "process", "terminal"].sort(),
  artifact: [...kanbanTools, ...fileTools],
  gate: [...kanbanTools, "process", "terminal"],
};
const expectedConcurrency = {
  maxInProgress: 6,
  maxInProgressPerProfile: 3,
  maxSpawn: 6,
};

function completeRouting() {
  return {
    schema: "dotfiles.hermes-routing/v1",
    profiles: Object.fromEntries(
      PROFILE_NAMES.map((name) => [
        name,
        {
          model: {
            provider: name === "critic" ? "anthropic" : "openai-codex",
            default: `${name}-model`,
          },
        },
      ]),
    ),
  };
}

async function fixture(routing = completeRouting()) {
  const base = await mkdtemp(join(tmpdir(), "agent-flow-doctor-"));
  const home = join(base, "home");
  const configHome = join(home, ".config");
  const routingFile = join(configHome, "dotfiles", "hermes-routing.yaml");
  await mkdir(join(configHome, "dotfiles"), { recursive: true });
  await writeFile(routingFile, JSON.stringify(routing));
  await renderProfiles({ root, home, configHome, routingFile });
  return { home, configHome };
}

function fakeHermes(version = "0.18.2", gatewayRunning = true) {
  return async (args) => {
    if (args[0] === "--version") {
      return `Hermes Agent v${version} (test)\n`;
    }
    if (args[0] === "gateway" && args[1] === "list") {
      return gatewayRunning
        ? "Gateways:\n  ✓ flow-controller          - PID 123\n"
        : "Gateways:\n  ✗ flow-controller          - not running\n";
    }
    const profile = args[1];
    assert.deepEqual(args, [
      "-p",
      profile,
      "tools",
      "list",
      "--platform",
      "cli",
    ]);
    return expectedToolsets[profile]
      .map((toolset) => `  ✓ enabled  ${toolset}  test`)
      .join("\n");
  };
}

function fakeProfileInspector(overrides = {}) {
  return async (name) => ({
    tools: overrides[name]?.tools ?? expectedWorkerTools[name],
    dispatchInGateway:
      overrides[name]?.dispatchInGateway ?? name === "flow-controller",
    autoDecompose: overrides[name]?.autoDecompose ?? false,
    terminalBackend: overrides[name]?.terminalBackend ?? "local",
    terminalHomeMode: overrides[name]?.terminalHomeMode ?? "real",
    memoryEnabled: overrides[name]?.memoryEnabled ?? false,
    userProfileEnabled: overrides[name]?.userProfileEnabled ?? false,
    concurrency: overrides[name]?.concurrency ?? expectedConcurrency,
    terminalProbe: overrides[name]?.terminalProbe ?? {
      home: "/Users/test",
      homeReadable: true,
      ordinaryEnvInherited: true,
      providerSecretFilteredByDefault: true,
      gatewaySecretFiltered: true,
      homeIsOsUserHome: true,
      agentFlowPath: "/Users/test/.local/bin/agent-flow",
    },
  });
}

test("profile doctor verifies routing, credentials, tools, and dispatcher ownership", async () => {
  const paths = await fixture();
  for (const name of PROFILE_NAMES) {
    const profileHome = join(paths.home, ".hermes", "profiles", name);
    const provider = name === "critic" ? "anthropic" : "openai-codex";
    await writeFile(
      join(profileHome, "auth.json"),
      JSON.stringify({
        providers: { [provider]: { access_token: "test-only" } },
      }),
      { mode: 0o600 },
    );
  }
  await writeFile(
    join(paths.home, ".hermes", "profiles", "flow-controller", "gateway.pid"),
    JSON.stringify({
      pid: process.pid,
      kind: "hermes-gateway",
      argv: ["hermes", "-p", "flow-controller", "gateway", "run"],
    }),
  );

  const report = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes(),
    inspectProfile: fakeProfileInspector(),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map(({ id, ok }) => [id, ok]),
    [
      ["hermes-version", true],
      ["routing", true],
      ["credentials", true],
      ["native-config", true],
      ["trust-posture", true],
      ["dispatch-owner", true],
      ["toolsets", true],
    ],
  );
  assert.deepEqual(
    report.profiles.find(({ name }) => name === "analyst").enabledToolsets,
    ["web", "file"],
  );
  assert.match(
    report.profiles.find(({ name }) => name === "analyst").note,
    /write operations/,
  );
  assert.equal(
    report.profiles.find(({ name }) => name === "flow-controller")
      .workerSchemaCount,
    9,
  );
  assert.deepEqual(
    report.profiles.find(({ name }) => name === "builder").workerTools,
    expectedWorkerTools.builder,
  );
  const builder = report.profiles.find(({ name }) => name === "builder");
  assert.equal(builder.trust.filesystemSandbox, false);
  assert.equal(builder.trust.terminal.backend, "local");
  assert.equal(builder.trust.terminal.inheritsRealUserHome, true);
  assert.equal(builder.trust.terminal.normalCliCredentialsReachable, true);
  assert.equal(builder.trust.terminal.providerSecretsFilteredByDefault, true);
  assert.equal(builder.trust.terminal.gatewaySecretsFiltered, true);
  assert.match(builder.trust.contractOnly.join("\n"), /assigned worktree/);
  assert.deepEqual(builder.concurrency, expectedConcurrency);
  assert.match(report.profileSetFingerprint, /^sha256:[a-f0-9]{64}$/);
  for (const profile of report.profiles) {
    assert.match(profile.configurationFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(profile.trust.execution, "host-local");
    assert.ok(profile.trust.technicallyEnforced.length > 0);
    assert.ok(profile.trust.contractOnly.length > 0);
  }

  const repeated = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes(),
    inspectProfile: fakeProfileInspector(),
  });
  assert.equal(repeated.profileSetFingerprint, report.profileSetFingerprint);
});

test("profile doctor honors the native Hermes home", async () => {
  const paths = await fixture();
  const hermesHome = join(paths.home, "isolated-hermes");
  await rename(join(paths.home, ".hermes"), hermesHome);
  for (const name of PROFILE_NAMES) {
    const profileHome = join(hermesHome, "profiles", name);
    const provider = name === "critic" ? "anthropic" : "openai-codex";
    await writeFile(
      join(profileHome, "auth.json"),
      JSON.stringify({
        providers: { [provider]: { access_token: "test-only" } },
      }),
      { mode: 0o600 },
    );
  }

  const report = await doctorProfiles({
    home: paths.home,
    hermesHome,
    runHermes: fakeHermes(),
    inspectProfile: fakeProfileInspector(),
  });

  assert.equal(report.ok, true);
});

test("profile doctor rejects drift in host trust and concurrency posture", async () => {
  const paths = await fixture();
  const report = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes(),
    inspectProfile: fakeProfileInspector({
      builder: { terminalHomeMode: "profile" },
      gate: {
        terminalProbe: {
          home: "/Users/test",
          homeReadable: true,
          ordinaryEnvInherited: true,
          providerSecretFilteredByDefault: false,
          gatewaySecretFiltered: true,
          homeIsOsUserHome: true,
          agentFlowPath: null,
        },
      },
      "flow-controller": {
        concurrency: {
          maxInProgress: 12,
          maxInProgressPerProfile: 3,
          maxSpawn: 6,
        },
      },
    }),
  });

  const trust = report.checks.find(({ id }) => id === "trust-posture");
  assert.equal(trust.ok, false);
  assert.match(trust.details.join("\n"), /builder.*home_mode=profile/);
  assert.match(
    trust.details.join("\n"),
    /gate.*default provider-secret filtering/,
  );
  assert.match(trust.details.join("\n"), /flow-controller.*max_in_progress=12/);
  assert.match(trust.details.join("\n"), /gate.*agent-flow command/);
});

test("profile doctor rejects unexpected worker tools even when the count matches", async () => {
  const paths = await fixture();
  for (const name of PROFILE_NAMES) {
    const provider = name === "critic" ? "anthropic" : "openai-codex";
    await writeFile(
      join(paths.home, ".hermes", "profiles", name, "auth.json"),
      JSON.stringify({ providers: { [provider]: { access_token: "test" } } }),
    );
  }

  const analystTools = [...expectedWorkerTools.analyst];
  analystTools[analystTools.indexOf("read_file")] = "dangerous_shell";
  const report = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes(),
    inspectProfile: fakeProfileInspector({ analyst: { tools: analystTools } }),
  });

  const toolCheck = report.checks.find(({ id }) => id === "toolsets");
  assert.equal(toolCheck.ok, false);
  assert.match(toolCheck.details.join("\n"), /analyst.*dangerous_shell/);
  const trustCheck = report.checks.find(({ id }) => id === "trust-posture");
  assert.equal(trustCheck.ok, false);
  assert.match(
    report.profiles
      .find(({ name }) => name === "analyst")
      .trust.technicallyEnforced.join("\n"),
    /MCP absence not established/,
  );
});

test("profile doctor verifies Hermes-native dispatch and decomposition settings", async () => {
  const paths = await fixture();
  const report = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes(),
    inspectProfile: fakeProfileInspector({ gate: { autoDecompose: true } }),
  });

  const nativeConfig = report.checks.find(({ id }) => id === "native-config");
  assert.equal(nativeConfig.ok, false);
  assert.match(nativeConfig.details.join("\n"), /gate.*auto_decompose/);
});

test("profile doctor cannot approve trust when native inspection fails", async () => {
  const paths = await fixture();
  const inspectProfile = async (name) => {
    if (name === "builder") throw new Error("inspection unavailable");
    return fakeProfileInspector()(name);
  };
  const report = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes(),
    inspectProfile,
  });

  const trust = report.checks.find(({ id }) => id === "trust-posture");
  assert.equal(trust.ok, false);
  assert.match(trust.details.join("\n"), /builder.*could not verify/);
});

test("profile doctor rejects unvalidated Hermes patch releases", async () => {
  const paths = await fixture();
  const report = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes("0.18.3"),
    inspectProfile: fakeProfileInspector(),
  });

  const version = report.checks.find(({ id }) => id === "hermes-version");
  assert.equal(version.ok, false);
  assert.match(version.details.join("\n"), /validated version: 0\.18\.2/);
});

test("profile doctor rejects structurally empty credential stores", async () => {
  const paths = await fixture();
  await mkdir(join(paths.home, ".codex"), { recursive: true });
  await mkdir(join(paths.home, ".claude"), { recursive: true });
  await writeFile(join(paths.home, ".codex", "auth.json"), "{}\n");
  await writeFile(join(paths.home, ".claude", ".credentials.json"), "{}\n");
  for (const name of PROFILE_NAMES) {
    const provider = name === "critic" ? "anthropic" : "openai-codex";
    const emptyEnv =
      name === "critic"
        ? 'ANTHROPIC_TOKEN="" # empty\n'
        : "OPENAI_CODEX_TOKEN=''\n";
    await writeFile(
      join(paths.home, ".hermes", "profiles", name, "auth.json"),
      JSON.stringify({ providers: { [provider]: {} } }),
    );
    await writeFile(
      join(paths.home, ".hermes", "profiles", name, ".env"),
      emptyEnv,
    );
  }

  const report = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes(),
    inspectProfile: fakeProfileInspector(),
  });

  assert.equal(report.checks.find(({ id }) => id === "credentials").ok, false);
});

test("credential preflight accepts only Hermes-readable Codex auth", { concurrency: false }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-flow-codex-credential-"));
  const profileHome = join(home, ".hermes", "profiles", "critic");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(profileHome, { recursive: true });
  await writeFile(
    join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "codex-only" } }),
  );
  const priorToken = process.env.OPENAI_CODEX_TOKEN;
  process.env.OPENAI_CODEX_TOKEN = "unsupported-environment-token";
  t.after(() => {
    if (priorToken === undefined) delete process.env.OPENAI_CODEX_TOKEN;
    else process.env.OPENAI_CODEX_TOKEN = priorToken;
  });

  const result = await inspectProfileCredentials({
    config: { model: { provider: "openai-codex", default: "gpt-5.3-codex" } },
    home,
    profileHome,
  });

  assert.equal(result.available, false);
  assert.match(result.failures.join("\n"), /openai-codex/);
});

test("credential preflight reads shared auth from the selected Hermes home", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-flow-hermes-home-auth-"));
  const hermesHome = join(home, "isolated-hermes");
  const profileHome = join(hermesHome, "profiles", "critic");
  await mkdir(join(home, ".hermes"), { recursive: true });
  await mkdir(profileHome, { recursive: true });
  await writeFile(
    join(home, ".hermes", "auth.json"),
    JSON.stringify({
      providers: { "openai-codex": { access_token: "wrong-root" } },
    }),
  );
  const config = {
    model: { provider: "openai-codex", default: "test-model" },
  };

  const unavailable = await inspectProfileCredentials({
    config,
    hermesHome,
    home,
    profileHome,
  });
  assert.equal(unavailable.available, false);

  await writeFile(
    join(hermesHome, "auth.json"),
    JSON.stringify({
      providers: { "openai-codex": { access_token: "selected-root" } },
    }),
  );
  const available = await inspectProfileCredentials({
    config,
    hermesHome,
    home,
    profileHome,
  });
  assert.equal(available.available, true);
});

test("profile doctor accepts Hermes credential pools", async () => {
  const paths = await fixture();
  for (const name of PROFILE_NAMES) {
    const provider = name === "critic" ? "anthropic" : "openai-codex";
    await writeFile(
      join(paths.home, ".hermes", "profiles", name, "auth.json"),
      JSON.stringify({
        credential_pool: {
          [provider]: [{ access_token: "pooled-test-token" }],
        },
      }),
    );
  }

  const report = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes(),
    inspectProfile: fakeProfileInspector(),
  });

  assert.equal(report.checks.find(({ id }) => id === "credentials").ok, true);
});

test("profile doctor honors a custom provider key_env", async () => {
  const routing = completeRouting();
  routing.profiles.builder = {
    model: { provider: "custom:work", default: "work-model" },
    custom_providers: [
      {
        name: "work",
        base_url: "https://models.example.test/v1",
        key_env: "WORK_API_KEY",
      },
    ],
  };
  const paths = await fixture(routing);
  for (const name of PROFILE_NAMES.filter((name) => name !== "builder")) {
    const provider = name === "critic" ? "anthropic" : "openai-codex";
    await writeFile(
      join(paths.home, ".hermes", "profiles", name, "auth.json"),
      JSON.stringify({ providers: { [provider]: { access_token: "test" } } }),
    );
  }
  await writeFile(
    join(paths.home, ".hermes", "profiles", "builder", ".env"),
    "WORK_API_KEY=available\n",
  );

  const report = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes(),
    inspectProfile: fakeProfileInspector(),
  });

  assert.equal(report.checks.find(({ id }) => id === "credentials").ok, true);
  assert.equal(
    report.profiles.find(({ name }) => name === "builder").available,
    true,
  );
});

test("profile doctor verifies every configured fallback credential", async () => {
  const routing = completeRouting();
  routing.profiles.analyst.fallback_providers = [
    { provider: "custom:fallback", model: "fallback-model" },
  ];
  routing.profiles.analyst.custom_providers = [
    {
      name: "fallback",
      base_url: "https://fallback.example.test/v1",
      key_env: "FALLBACK_API_KEY",
    },
  ];
  const paths = await fixture(routing);
  for (const name of PROFILE_NAMES) {
    const provider = name === "critic" ? "anthropic" : "openai-codex";
    await writeFile(
      join(paths.home, ".hermes", "profiles", name, "auth.json"),
      JSON.stringify({ providers: { [provider]: { access_token: "test" } } }),
    );
  }

  const missing = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes(),
    inspectProfile: fakeProfileInspector(),
  });
  const missingCredentials = missing.checks.find(
    ({ id }) => id === "credentials",
  );
  assert.equal(missingCredentials.ok, false);
  assert.match(
    missingCredentials.details.join("\n"),
    /analyst.*fallback.*custom:fallback/,
  );

  await writeFile(
    join(paths.home, ".hermes", "profiles", "analyst", ".env"),
    "FALLBACK_API_KEY=available\n",
  );
  const available = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes(),
    inspectProfile: fakeProfileInspector(),
  });
  assert.equal(
    available.checks.find(({ id }) => id === "credentials").ok,
    true,
  );
});

test("profile doctor explains every unavailable prerequisite", async () => {
  const paths = await fixture({
    schema: "dotfiles.hermes-routing/v1",
    profiles: {
      builder: {
        model: { provider: "openai-codex", default: "builder-model" },
      },
    },
  });

  const report = await doctorProfiles({
    ...paths,
    runHermes: fakeHermes("0.19.0", false),
    inspectProfile: fakeProfileInspector(),
  });

  assert.equal(report.ok, false);
  for (const id of [
    "hermes-version",
    "routing",
    "credentials",
    "dispatch-owner",
  ]) {
    const check = report.checks.find((candidate) => candidate.id === id);
    assert.equal(check.ok, false, `${id} unexpectedly passed`);
    assert.ok(check.details.length > 0, `${id} did not explain its failure`);
  }
});
