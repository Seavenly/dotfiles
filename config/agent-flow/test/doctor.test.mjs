import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { doctorProfiles } from "../src/doctor.mjs";
import { PROFILE_NAMES, renderProfiles } from "../src/profiles.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const expectedToolsets = {
  "flow-controller": [],
  analyst: ["web", "file"],
  critic: ["web", "file"],
  builder: ["terminal", "file"],
  artifact: ["file"],
  gate: ["terminal"],
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
  return async (args, options = {}) => {
    if (args[0] === "--version") {
      return `Hermes Agent v${version} (test)\n`;
    }
    if (args[0] === "gateway" && args[1] === "list") {
      return gatewayRunning
        ? "Gateways:\n  ✓ flow-controller          - PID 123\n"
        : "Gateways:\n  ✗ flow-controller          - not running\n";
    }
    const profile = args[1];
    if (args[2] === "prompt-size") {
      assert.equal(
        options.env.HERMES_KANBAN_TASK,
        "agent-flow-doctor-inspection",
      );
      const counts = {
        "flow-controller": 7,
        analyst: 11,
        critic: 11,
        builder: 13,
        artifact: 11,
        gate: 9,
      };
      return JSON.stringify({ tools: { count: counts[profile] } });
    }
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

  const report = await doctorProfiles({ ...paths, runHermes: fakeHermes() });

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map(({ id, ok }) => [id, ok]),
    [
      ["hermes-version", true],
      ["routing", true],
      ["credentials", true],
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
    7,
  );
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

  const report = await doctorProfiles({ ...paths, runHermes: fakeHermes() });

  assert.equal(report.checks.find(({ id }) => id === "credentials").ok, false);
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
