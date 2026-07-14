import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

import {
  PROFILE_NAMES,
  atomicWrite,
  deepMerge,
  renderProfiles,
  validateRoutingOverlay,
} from "../src/profiles.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function completeRouting() {
  const profiles = Object.fromEntries(
    PROFILE_NAMES.map((name) => [
      name,
      {
        model: {
          provider: name === "critic" ? "anthropic" : "openai-codex",
          default: name === "critic" ? "critic-model" : `${name}-model`,
        },
      },
    ]),
  );
  return { schema: "dotfiles.hermes-routing/v1", profiles };
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "agent-flow-profiles-"));
  const home = join(base, "home");
  const configHome = join(home, ".config");
  const routingFile = join(configHome, "dotfiles", "hermes-routing.yaml");
  await mkdir(join(configHome, "dotfiles"), { recursive: true });
  return { home, configHome, routingFile };
}

test("deep merge replaces arrays and scalars while preserving maps", () => {
  assert.deepEqual(
    deepMerge(
      { nested: { kept: true, changed: "old" }, values: ["old"], scalar: 1 },
      { nested: { changed: "new" }, values: ["new"], scalar: 2 },
    ),
    {
      nested: { kept: true, changed: "new" },
      values: ["new"],
      scalar: 2,
    },
  );
});

test("routing validation rejects unknown profiles and secret-like keys", () => {
  assert.throws(
    () =>
      validateRoutingOverlay({
        schema: "dotfiles.hermes-routing/v1",
        profiles: {
          reviewer: { model: { provider: "test", default: "test" } },
        },
      }),
    /unknown profile: reviewer/,
  );
  assert.throws(
    () =>
      validateRoutingOverlay({
        schema: "dotfiles.hermes-routing/v1",
        profiles: {
          builder: {
            custom_providers: { local: { api_key: "must-not-be-here" } },
          },
        },
      }),
    /secret-like key: api_key/,
  );
  assert.throws(
    () =>
      validateRoutingOverlay({
        schema: "dotfiles.hermes-routing/v1",
        profiles: {
          builder: {
            custom_providers: { local: { apiKey: "must-not-be-here" } },
          },
        },
      }),
    /secret-like key: apiKey/,
  );
  for (const key of [
    "accessToken",
    "clientSecret",
    "Authorization",
    "passwordHash",
    "credentials",
  ]) {
    assert.throws(
      () =>
        validateRoutingOverlay({
          schema: "dotfiles.hermes-routing/v1",
          profiles: {
            builder: { providers: { test: { [key]: "must-not-be-here" } } },
          },
        }),
      new RegExp(`secret-like key: ${key}`),
    );
  }
});

test("routing validation rejects invalid native section shapes", () => {
  for (const fragment of [
    { fallback_providers: {} },
    { fallback_providers: ["anthropic"] },
    { fallback_providers: [{ provider: "anthropic" }] },
    { provider_routing: [] },
    { provider_routing: { data_collection: false } },
    { provider_routing: { unsupported: true } },
    { providers: [] },
    { providers: { anthropic: {} } },
    { providers: { anthropic: { request_timeout_seconds: "slow" } } },
    { custom_providers: {} },
  ]) {
    assert.throws(
      () =>
        validateRoutingOverlay({
          schema: "dotfiles.hermes-routing/v1",
          profiles: { builder: fragment },
        }),
      /must (?:be|name|define)|unsupported/,
    );
  }
});

test("routing validation accepts complete native provider sections", () => {
  assert.doesNotThrow(() =>
    validateRoutingOverlay({
      schema: "dotfiles.hermes-routing/v1",
      profiles: {
        builder: {
          model: { provider: "custom:work", default: "work-model" },
          fallback_providers: [
            { provider: "anthropic", model: "fallback-model" },
          ],
          provider_routing: {
            sort: "latency",
            order: ["anthropic"],
            require_parameters: true,
            data_collection: "deny",
          },
          providers: { anthropic: { request_timeout_seconds: 60 } },
          custom_providers: [
            {
              name: "work",
              base_url: "https://models.example.test/v1",
              key_env: "WORK_API_KEY",
            },
          ],
        },
      },
    }),
  );
});

test("complete routing renders native configs with restricted toolsets", async () => {
  const paths = await fixture();
  await writeFile(paths.routingFile, JSON.stringify(completeRouting()));

  const result = await renderProfiles({ root, ...paths });

  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.rendered, PROFILE_NAMES);
  for (const name of PROFILE_NAMES) {
    const target = join(paths.home, ".hermes", "profiles", name, "config.yaml");
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const config = parse(await readFile(target, "utf8"));
    assert.equal(
      config.model.provider,
      name === "critic" ? "anthropic" : "openai-codex",
    );
    assert.equal(config.kanban.dispatch_in_gateway, name === "flow-controller");
    assert.equal(config.kanban.auto_decompose, false);
    assert.equal(config.kanban.max_in_progress, 6);
    assert.equal(config.kanban.max_in_progress_per_profile, 3);
    assert.equal(config.kanban.max_spawn, 6);
    assert.equal(config.terminal.backend, "local");
    assert.equal(config.terminal.home_mode, "real");
  }

  const controller = parse(
    await readFile(
      join(paths.home, ".hermes", "profiles", "flow-controller", "config.yaml"),
      "utf8",
    ),
  );
  assert.deepEqual(controller.platform_toolsets.cli, ["kanban", "no_mcp"]);
  const analyst = parse(
    await readFile(
      join(paths.home, ".hermes", "profiles", "analyst", "config.yaml"),
      "utf8",
    ),
  );
  assert.deepEqual(analyst.platform_toolsets.cli, ["file", "web", "no_mcp"]);
});

test("render is idempotent and preserves Hermes state and unmanaged profiles", async () => {
  const paths = await fixture();
  await writeFile(paths.routingFile, JSON.stringify(completeRouting()));
  const hermesHome = join(paths.home, ".hermes");
  const builderHome = join(hermesHome, "profiles", "builder");
  const unmanagedHome = join(hermesHome, "profiles", "local-only");
  await renderProfiles({ root, ...paths });
  await mkdir(join(builderHome, "memory"), { recursive: true });
  await mkdir(unmanagedHome, { recursive: true });
  await writeFile(join(builderHome, ".env"), "SECRET=preserved\n");
  await writeFile(join(builderHome, "auth.json"), '{"preserved":true}\n');
  await writeFile(join(builderHome, "memory", "notes.md"), "preserved\n");
  await writeFile(join(unmanagedHome, "config.yaml"), "unmanaged: true\n");

  const first = await readFile(join(builderHome, "config.yaml"), "utf8");
  await renderProfiles({ root, ...paths });

  assert.equal(await readFile(join(builderHome, "config.yaml"), "utf8"), first);
  assert.equal(
    await readFile(join(builderHome, ".env"), "utf8"),
    "SECRET=preserved\n",
  );
  assert.equal(
    await readFile(join(builderHome, "auth.json"), "utf8"),
    '{"preserved":true}\n',
  );
  assert.equal(
    await readFile(join(builderHome, "memory", "notes.md"), "utf8"),
    "preserved\n",
  );
  assert.equal(
    await readFile(join(unmanagedHome, "config.yaml"), "utf8"),
    "unmanaged: true\n",
  );
});

test("render refuses to claim an existing unmanaged profile", async () => {
  const paths = await fixture();
  await writeFile(paths.routingFile, JSON.stringify(completeRouting()));
  const builderHome = join(paths.home, ".hermes", "profiles", "builder");
  await mkdir(builderHome, { recursive: true });
  await writeFile(join(builderHome, "config.yaml"), "user_owned: true\n");

  await assert.rejects(
    () => renderProfiles({ root, ...paths }),
    /unmanaged Hermes profile.*builder.*--force/,
  );

  assert.equal(
    await readFile(join(builderHome, "config.yaml"), "utf8"),
    "user_owned: true\n",
  );
  for (const name of PROFILE_NAMES.filter((name) => name !== "builder")) {
    await assert.rejects(
      readFile(
        join(paths.home, ".hermes", "profiles", name, "config.yaml"),
        "utf8",
      ),
      { code: "ENOENT" },
    );
  }
});

test("render refuses to claim a markerless profile containing only runtime state", async () => {
  const paths = await fixture();
  await writeFile(paths.routingFile, JSON.stringify(completeRouting()));
  const gateHome = join(paths.home, ".hermes", "profiles", "gate");
  await mkdir(join(gateHome, "sessions"), { recursive: true });
  await writeFile(join(gateHome, "auth.json"), '{"user_owned":true}\n');
  await writeFile(join(gateHome, "sessions", "one.json"), "{}\n");

  await assert.rejects(
    () => renderProfiles({ root, ...paths }),
    /unmanaged Hermes profile.*gate.*--force/,
  );

  assert.equal(
    await readFile(join(gateHome, "auth.json"), "utf8"),
    '{"user_owned":true}\n',
  );
});

test("force deliberately claims an unmanaged profile", async () => {
  const paths = await fixture();
  await writeFile(paths.routingFile, JSON.stringify(completeRouting()));
  const builderHome = join(paths.home, ".hermes", "profiles", "builder");
  await mkdir(builderHome, { recursive: true });
  await writeFile(join(builderHome, "config.yaml"), "user_owned: true\n");

  await renderProfiles({ root, ...paths, force: true });

  const rendered = parse(
    await readFile(join(builderHome, "config.yaml"), "utf8"),
  );
  assert.equal(rendered.model.default, "builder-model");
  assert.equal(
    await readFile(join(builderHome, ".dotfiles-managed-profile"), "utf8"),
    "dotfiles.hermes-profile/v1\n",
  );
});

test("invalid routing cannot partially replace managed configs", async () => {
  const paths = await fixture();
  await writeFile(paths.routingFile, JSON.stringify(completeRouting()));
  await renderProfiles({ root, ...paths });
  const targets = PROFILE_NAMES.map((name) =>
    join(paths.home, ".hermes", "profiles", name, "config.yaml"),
  );
  const before = await Promise.all(
    targets.map((target) => readFile(target, "utf8")),
  );
  await writeFile(
    paths.routingFile,
    JSON.stringify({
      ...completeRouting(),
      profiles: {
        ...completeRouting().profiles,
        unknown: { model: { provider: "test", default: "test" } },
      },
    }),
  );

  await assert.rejects(
    () => renderProfiles({ root, ...paths }),
    /unknown profile/,
  );
  assert.deepEqual(
    await Promise.all(targets.map((target) => readFile(target, "utf8"))),
    before,
  );
});

test("partial routing renders safe base configs and reports unavailable lanes", async () => {
  const paths = await fixture();
  await writeFile(
    paths.routingFile,
    JSON.stringify({
      schema: "dotfiles.hermes-routing/v1",
      profiles: {
        builder: {
          model: { provider: "openai-codex", default: "builder-model" },
        },
      },
    }),
  );

  const result = await renderProfiles({ root, ...paths });

  assert.deepEqual(
    result.unavailable,
    PROFILE_NAMES.filter((name) => name !== "builder"),
  );
  assert.equal(
    parse(
      await readFile(
        join(paths.home, ".hermes", "profiles", "analyst", "config.yaml"),
        "utf8",
      ),
    ).model,
    undefined,
  );
});

test("personal and work-style routing both resolve every stable lane", async () => {
  const environments = [
    completeRouting(),
    {
      schema: "dotfiles.hermes-routing/v1",
      profiles: Object.fromEntries(
        PROFILE_NAMES.map((name) => [
          name,
          {
            model: {
              provider: name === "critic" ? "openai-codex" : "anthropic",
              default: `work-${name}-model`,
            },
          },
        ]),
      ),
    },
  ];

  for (const routing of environments) {
    const paths = await fixture();
    await writeFile(paths.routingFile, JSON.stringify(routing));
    assert.deepEqual(
      (await renderProfiles({ root, ...paths })).unavailable,
      [],
    );
  }
});

test("atomic write preserves the target and removes its temporary file on rename failure", async () => {
  const base = await mkdtemp(join(tmpdir(), "agent-flow-atomic-"));
  const target = join(base, "config.yaml");
  await writeFile(target, "preserved: true\n", { mode: 0o600 });

  await assert.rejects(
    () =>
      atomicWrite(target, "replacement: true\n", {
        renameFile: async () => {
          throw new Error("injected rename failure");
        },
      }),
    /injected rename failure/,
  );

  assert.equal(await readFile(target, "utf8"), "preserved: true\n");
  assert.deepEqual(await readdir(base), ["config.yaml"]);
});
