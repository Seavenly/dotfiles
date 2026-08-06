import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyTrustObservation,
  preflightQualificationTrust,
  readNativeTrustSource,
  trustPreflightBinding,
  trustPreflightReady,
} from "../src/qualification-trust.mjs";

const workspace = "/tmp/drovr-qualification/workspace";

function bindingFacts(overrides = {}) {
  return {
    harness: "codex",
    workspace: { path: workspace, identity: "sha256:workspace" },
    executable: {
      path: "/opt/codex/bin/codex",
      version: "codex-cli 0.142.5",
    },
    expectedVersion: "codex-cli 0.142.5",
    observedVersion: "codex-cli 0.142.5",
    integration: {
      id: "herdr-codex/v7",
      detail: "current (v7)",
    },
    source: {
      status: "present",
      path: "/home/operator/.codex/config.toml",
      digest: "sha256:config",
      workspace_path: workspace,
      trust_level: "trusted",
    },
    ...overrides,
  };
}

test("trust observation classification fails closed for trusted, untrusted, changed, and ambiguous states", () => {
  const cases = [
    ["trusted", {}, "trusted"],
    [
      "untrusted",
      { source: { ...bindingFacts().source, trust_level: "untrusted" } },
      "untrusted",
    ],
    [
      "changed",
      { source: { ...bindingFacts().source, status: "changed" } },
      "changed",
    ],
    [
      "ambiguous",
      { source: { ...bindingFacts().source, trust_level: null } },
      "ambiguous",
    ],
  ];

  for (const [label, overrides, expected] of cases) {
    const result = classifyTrustObservation(bindingFacts(overrides));
    assert.equal(result.status, expected, label);
    if (expected === "trusted") {
      assert.equal(result.action, null, label);
    } else {
      assert.equal(result.action.code, "pretrust_exact_workspace", label);
      assert.match(result.action.message, /will not submit native keys/u, label);
    }
  }

  assert.equal(
    classifyTrustObservation(
      bindingFacts({
        observedVersion: "codex-cli 0.146.1",
      }),
    ).status,
    "changed",
  );
  assert.equal(
    classifyTrustObservation(
      bindingFacts({
        harness: "claude",
        executable: { path: "/opt/claude/bin/claude" },
        expectedVersion: "2.1.199 (Claude Code)",
        observedVersion: "2.1.199 (Claude Code)",
        integration: {
          id: "herdr-claude/v7",
          detail: "current (v7)",
        },
        source: { ...bindingFacts().source, trust_level: false },
      }),
    ).status,
    "untrusted",
  );
});

test("trust preflight binds both native trust records to exact executable, integration, and workspace facts", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-trust-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const bin = join(scratch, "bin");
  const codexHome = join(scratch, "codex");
  const claudeConfigDir = join(scratch, "claude");
  const workspacePath = join(scratch, "workspace");
  await Promise.all([
    mkdir(bin),
    mkdir(codexHome),
    mkdir(claudeConfigDir),
    mkdir(workspacePath),
  ]);
  const targetWorkspace = await realpath(workspacePath);
  await writeFile(
    join(codexHome, "config.toml"),
    `[projects."${targetWorkspace}"]\ntrust_level = "trusted"\n`,
  );
  await writeFile(
    join(claudeConfigDir, ".claude.json"),
    JSON.stringify({
      projects: {
        [targetWorkspace]: { hasTrustDialogAccepted: true },
      },
    }),
  );
  await writeFile(
    join(bin, "codex"),
    "#!/usr/bin/env bash\nprintf '%s\\n' 'codex-cli 0.142.5'\n",
  );
  await writeFile(
    join(bin, "claude"),
    "#!/usr/bin/env bash\nprintf '%s\\n' '2.1.199 (Claude Code)'\n",
  );
  await Promise.all([
    chmod(join(bin, "codex"), 0o755),
    chmod(join(bin, "claude"), 0o755),
  ]);

  const result = await preflightQualificationTrust({
    harnesses: ["codex", "claude"],
    workspace: targetWorkspace,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
    versions: {
      codex: "codex-cli 0.142.5",
      claude: "2.1.199 (Claude Code)",
      integration: {
        codex: "current (v7)",
        claude: "current (v7)",
      },
    },
  });

  assert.equal(result.status, "trusted");
  assert.equal(result.configuration.created, false);
  assert.equal(result.harnesses.codex.status, "trusted");
  assert.equal(result.harnesses.claude.status, "trusted");
  assert.equal(result.harnesses.codex.source.trust_level, "trusted");
  assert.equal(result.harnesses.claude.source.trust_level, true);
  assert.equal(result.harnesses.codex.workspace.path, targetWorkspace);
  assert.equal(result.harnesses.claude.workspace.path, targetWorkspace);
  assert.equal(result.harnesses.codex.integration.id, "herdr-codex/v7");
  assert.equal(result.harnesses.claude.integration.id, "herdr-claude/v7");
  assert.equal(
    result.harnesses.codex.executable.version,
    "codex-cli 0.142.5",
  );
  assert.equal(
    result.harnesses.claude.executable.version,
    "2.1.199 (Claude Code)",
  );
  assert.equal(result.native_work_started, false);
  assert.match(result.binding, /^sha256:[0-9a-f]{64}$/u);

  assert.equal(
    await readFile(join(codexHome, "config.toml"), "utf8"),
    `[projects."${targetWorkspace}"]\ntrust_level = "trusted"\n`,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(claudeConfigDir, ".claude.json"))),
    { projects: { [targetWorkspace]: { hasTrustDialogAccepted: true } } },
  );
});

test("Codex trust parsing ends project scope at unrelated tables", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-trust-codex-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const workspacePath = join(scratch, "workspace");
  await mkdir(workspacePath);
  const targetWorkspace = await realpath(workspacePath);
  const sourcePath = join(scratch, "config.toml");
  await writeFile(
    sourcePath,
    `[projects."${targetWorkspace}"]\n\n[sandbox_workspace_write]\ntrust_level = "trusted"\n`,
  );

  const source = await readNativeTrustSource({
    harness: "codex",
    path: sourcePath,
    workspacePath: targetWorkspace,
  });
  assert.equal(source.status, "ambiguous");
  assert.equal(source.entry, "unreadable");
  assert.doesNotMatch(source.error, /trusted/u);
});

test("Claude malformed trust configuration does not leak parser input", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-trust-claude-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const targetWorkspace = join(scratch, "workspace");
  const sourcePath = join(scratch, ".claude.json");
  await mkdir(targetWorkspace);
  await writeFile(sourcePath, "sk-ant-oat01-SUPERSECRET-TOKEN-VALUE {\"projects\":{}}");

  const source = await readNativeTrustSource({
    harness: "claude",
    path: sourcePath,
    workspacePath: targetWorkspace,
  });
  assert.equal(source.status, "ambiguous");
  assert.equal(source.entry, "unreadable");
  assert.doesNotMatch(source.error, /SUPERSECRET|sk-ant/u);
});

test("trust preflight readiness rejects fabricated or drifted bindings", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-trust-binding-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const bin = join(scratch, "bin");
  const codexHome = join(scratch, "codex");
  const targetWorkspace = join(scratch, "workspace");
  await Promise.all([mkdir(bin), mkdir(codexHome), mkdir(targetWorkspace)]);
  await writeFile(
    join(codexHome, "config.toml"),
    `[projects."${targetWorkspace}"]\ntrust_level = "trusted"\n`,
  );
  await writeFile(join(bin, "codex"), "#!/usr/bin/env bash\nprintf '%s\\n' 'codex-cli 0.142.5'\n");
  await chmod(join(bin, "codex"), 0o755);
  const result = await preflightQualificationTrust({
    harnesses: ["codex"],
    workspace: targetWorkspace,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CODEX_HOME: codexHome,
    },
    versions: {
      codex: "codex-cli 0.142.5",
      integration: { codex: "current (v7)" },
    },
  });
  assert.equal(trustPreflightReady(result, ["codex"]), true);
  assert.equal(result.binding, trustPreflightBinding(result, ["codex"]));
  assert.equal(
    trustPreflightReady({ ...result, binding: "sha256:test" }, ["codex"]),
    false,
  );
  assert.equal(
    trustPreflightReady(
      {
        ...result,
        harnesses: {
          codex: {
            ...result.harnesses.codex,
            source: { ...result.harnesses.codex.source, digest: "sha256:test" },
          },
        },
        binding: trustPreflightBinding(
          {
            ...result,
            harnesses: {
              codex: {
                ...result.harnesses.codex,
                source: { ...result.harnesses.codex.source, digest: "sha256:test" },
              },
            },
          },
          ["codex"],
        ),
      },
      ["codex"],
    ),
    false,
  );
});
