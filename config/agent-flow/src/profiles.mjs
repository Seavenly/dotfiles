import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";

export const PROFILE_NAMES = [
  "flow-controller",
  "analyst",
  "critic",
  "builder",
  "artifact",
  "gate",
];

const ROUTING_SCHEMA = "dotfiles.hermes-routing/v1";
const ROUTING_KEYS = new Set([
  "model",
  "fallback_providers",
  "provider_routing",
  "providers",
  "custom_providers",
]);
const SECRET_KEY = /(apikey|token|secret|password|credential|authorization)/;

function isMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isMap(base) || !isMap(override)) {
    return structuredClone(override);
  }
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    merged[key] =
      key in merged ? deepMerge(merged[key], value) : structuredClone(value);
  }
  return merged;
}

function findSecretKey(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSecretKey(item);
      if (found) return found;
    }
    return null;
  }
  if (!isMap(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (normalized === "auth" || SECRET_KEY.test(normalized)) return key;
    const found = findSecretKey(child);
    if (found) return found;
  }
  return null;
}

function validateStringArray(profile, section, value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${profile}.${section} must be a list of strings`);
  }
}

function validateRoutingFragment(profile, fragment) {
  if ("model" in fragment) validateModel(profile, fragment.model);
  if ("fallback_providers" in fragment) {
    if (!Array.isArray(fragment.fallback_providers)) {
      throw new Error(`${profile}.fallback_providers must be a list`);
    }
    for (const fallback of fragment.fallback_providers) {
      if (
        !isMap(fallback) ||
        typeof fallback.provider !== "string" ||
        fallback.provider.length === 0 ||
        typeof fallback.model !== "string" ||
        fallback.model.length === 0
      ) {
        throw new Error(
          `${profile}.fallback_providers entries must name a provider and model`,
        );
      }
    }
  }
  if ("provider_routing" in fragment) {
    const routing = fragment.provider_routing;
    if (!isMap(routing))
      throw new Error(`${profile}.provider_routing must be a map`);
    const supportedRoutingKeys = new Set([
      "sort",
      "only",
      "ignore",
      "order",
      "require_parameters",
      "data_collection",
    ]);
    for (const key of Object.keys(routing)) {
      if (!supportedRoutingKeys.has(key)) {
        throw new Error(`${profile}.provider_routing.${key} is unsupported`);
      }
    }
    for (const key of ["only", "ignore", "order"]) {
      if (key in routing)
        validateStringArray(profile, `provider_routing.${key}`, routing[key]);
    }
    if (
      "sort" in routing &&
      !["price", "throughput", "latency"].includes(routing.sort)
    ) {
      throw new Error(
        `${profile}.provider_routing.sort must be price, throughput, or latency`,
      );
    }
    if (
      "require_parameters" in routing &&
      typeof routing.require_parameters !== "boolean"
    ) {
      throw new Error(
        `${profile}.provider_routing.require_parameters must be a boolean`,
      );
    }
    if (
      "data_collection" in routing &&
      !["allow", "deny"].includes(routing.data_collection)
    ) {
      throw new Error(
        `${profile}.provider_routing.data_collection must be allow or deny`,
      );
    }
  }
  if ("providers" in fragment) {
    if (!isMap(fragment.providers))
      throw new Error(`${profile}.providers must be a map`);
    for (const [name, provider] of Object.entries(fragment.providers)) {
      if (!isMap(provider))
        throw new Error(`${profile}.providers.${name} must be a map`);
      const recognized = [
        "name",
        "base_url",
        "default_model",
        "models",
        "key_env",
        "api_mode",
        "url",
        "request_timeout_seconds",
        "stale_timeout_seconds",
      ];
      if (!recognized.some((key) => key in provider)) {
        throw new Error(
          `${profile}.providers.${name} must define native provider settings`,
        );
      }
      for (const key of [
        "name",
        "base_url",
        "default_model",
        "key_env",
        "api_mode",
        "url",
      ]) {
        if (
          key in provider &&
          (typeof provider[key] !== "string" || provider[key].length === 0)
        ) {
          throw new Error(
            `${profile}.providers.${name}.${key} must be a non-empty string`,
          );
        }
      }
      if ("models" in provider && !isMap(provider.models)) {
        throw new Error(`${profile}.providers.${name}.models must be a map`);
      }
      for (const key of ["request_timeout_seconds", "stale_timeout_seconds"]) {
        if (
          key in provider &&
          (typeof provider[key] !== "number" || provider[key] <= 0)
        ) {
          throw new Error(
            `${profile}.providers.${name}.${key} must be a positive number`,
          );
        }
      }
    }
  }
  if ("custom_providers" in fragment) {
    if (!Array.isArray(fragment.custom_providers)) {
      throw new Error(`${profile}.custom_providers must be a list`);
    }
    for (const provider of fragment.custom_providers) {
      if (
        !isMap(provider) ||
        typeof provider.name !== "string" ||
        provider.name.length === 0 ||
        typeof provider.base_url !== "string" ||
        provider.base_url.length === 0
      ) {
        throw new Error(
          `${profile}.custom_providers entries must name a provider and base_url`,
        );
      }
      for (const key of ["key_env", "api_mode", "model", "default_model"]) {
        if (
          key in provider &&
          (typeof provider[key] !== "string" || provider[key].length === 0)
        ) {
          throw new Error(
            `${profile}.custom_providers.${provider.name}.${key} must be a non-empty string`,
          );
        }
      }
      if ("models" in provider && !isMap(provider.models)) {
        throw new Error(
          `${profile}.custom_providers.${provider.name}.models must be a map`,
        );
      }
    }
  }
}

function validateModel(profile, model) {
  if (!isMap(model)) throw new Error(`${profile}.model must be a map`);
  if (typeof model.provider !== "string" || model.provider.length === 0) {
    throw new Error(`${profile}.model.provider must be a non-empty string`);
  }
  const selected = model.default ?? model.model;
  if (typeof selected !== "string" || selected.length === 0) {
    throw new Error(`${profile}.model.default must be a non-empty string`);
  }
}

export function validateRoutingOverlay(overlay) {
  if (!isMap(overlay)) throw new Error("routing overlay must be a map");
  for (const key of Object.keys(overlay)) {
    if (key !== "schema" && key !== "profiles") {
      throw new Error(`unknown routing key: ${key}`);
    }
  }
  if (overlay.schema !== ROUTING_SCHEMA) {
    throw new Error(`routing schema must be ${ROUTING_SCHEMA}`);
  }
  if (!isMap(overlay.profiles))
    throw new Error("routing profiles must be a map");

  for (const [name, fragment] of Object.entries(overlay.profiles)) {
    if (!PROFILE_NAMES.includes(name))
      throw new Error(`unknown profile: ${name}`);
    if (!isMap(fragment)) throw new Error(`${name} routing must be a map`);
    for (const key of Object.keys(fragment)) {
      if (!ROUTING_KEYS.has(key))
        throw new Error(`unsupported routing key: ${name}.${key}`);
    }
    const secretKey = findSecretKey(fragment);
    if (secretKey) throw new Error(`secret-like key: ${secretKey}`);
    validateRoutingFragment(name, fragment);
  }

  const builderProvider = overlay.profiles.builder?.model?.provider;
  const criticProvider = overlay.profiles.critic?.model?.provider;
  if (builderProvider && criticProvider && builderProvider === criticProvider) {
    throw new Error("critic and builder must use distinct providers");
  }
  return overlay;
}

function validateBaseConfig(name, config) {
  if (!isMap(config)) throw new Error(`${name} base config must be a map`);
  if (!Array.isArray(config.platform_toolsets?.cli)) {
    throw new Error(`${name} base config must define platform_toolsets.cli`);
  }
  if (typeof config.kanban?.dispatch_in_gateway !== "boolean") {
    throw new Error(
      `${name} base config must define kanban.dispatch_in_gateway`,
    );
  }
  if (config.kanban.auto_decompose !== false) {
    throw new Error(`${name} must disable kanban.auto_decompose`);
  }
}

export async function atomicWrite(
  target,
  contents,
  { renameFile = rename } = {},
) {
  const suffix = randomBytes(8).toString("hex");
  const temporary = `${target}.tmp-${process.pid}-${suffix}`;
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await renameFile(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function renderProfiles({ root, home, configHome, routingFile }) {
  const resolvedHome = home ?? process.env.HOME;
  if (!resolvedHome) throw new Error("HOME is required");
  const resolvedConfigHome =
    configHome ?? process.env.XDG_CONFIG_HOME ?? join(resolvedHome, ".config");
  const resolvedRouting =
    routingFile ?? join(resolvedConfigHome, "dotfiles", "hermes-routing.yaml");
  const overlay = validateRoutingOverlay(
    parse(await readFile(resolvedRouting, "utf8")),
  );

  const plans = await Promise.all(
    PROFILE_NAMES.map(async (name) => {
      const source = join(
        root,
        "config",
        "agents",
        "profiles",
        name,
        "hermes",
        "config.yaml",
      );
      const base = parse(await readFile(source, "utf8"));
      validateBaseConfig(name, base);
      const fragment = overlay.profiles[name] ?? {};
      const config = deepMerge(base, fragment);
      validateBaseConfig(name, config);
      validateRoutingFragment(name, config);
      return {
        name,
        targetDirectory: join(resolvedHome, ".hermes", "profiles", name),
        contents: stringify(config, { lineWidth: 100 }),
        available: Boolean(fragment.model),
      };
    }),
  );

  for (const plan of plans) {
    await mkdir(plan.targetDirectory, { recursive: true });
    await atomicWrite(join(plan.targetDirectory, "config.yaml"), plan.contents);
  }

  return {
    rendered: plans.map(({ name }) => name),
    unavailable: plans
      .filter(({ available }) => !available)
      .map(({ name }) => name),
  };
}
