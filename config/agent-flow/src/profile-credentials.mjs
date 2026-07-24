import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PROVIDER_ENV = {
  anthropic: [
    "ANTHROPIC_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ],
  "openai-codex": [],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  nous: ["NOUS_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

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
    return (
      hasCredentialValue(auth.providers?.[provider]) ||
      hasCredentialValue(auth.credential_pool?.[provider])
    );
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

function credentialRequirement(config, provider) {
  const customName = provider.startsWith("custom:")
    ? provider.slice("custom:".length)
    : provider;
  const customProvider = config.custom_providers?.find(
    (candidate) => candidate.name === customName,
  );
  const providerConfig =
    config.providers?.[provider] ?? config.providers?.[customName];
  const explicitKey = customProvider?.key_env ?? providerConfig?.key_env;
  if (customProvider) {
    return {
      provider,
      authProviders: [provider, customName],
      keys: explicitKey ? [explicitKey] : [],
      required: Boolean(explicitKey),
    };
  }
  return {
    provider,
    authProviders: [provider],
    keys: explicitKey
      ? [explicitKey]
      : (PROVIDER_ENV[provider] ?? [
          `${provider.replaceAll("-", "_").toUpperCase()}_API_KEY`,
        ]),
    required: true,
  };
}

async function credentialAvailable({
  hermesHome,
  home,
  profileHome,
  requirement,
}) {
  if (!requirement.required) return true;
  for (const provider of requirement.authProviders) {
    if (await authStoreHasProvider(join(profileHome, "auth.json"), provider))
      return true;
    if (await authStoreHasProvider(join(hermesHome, "auth.json"), provider))
      return true;
  }

  const keys = new Set(requirement.keys);
  if ([...keys].some((key) => envValueIsPresent(process.env[key] ?? ""))) {
    return true;
  }
  for (const envFile of [
    join(profileHome, ".env"),
    join(hermesHome, ".env"),
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
    requirement.provider === "anthropic" &&
    (await credentialFileHasValue(join(home, ".claude", ".credentials.json")))
  ) {
    return true;
  }
  return false;
}

export async function inspectProfileCredentials({
  config,
  home,
  hermesHome = join(home, ".hermes"),
  profileHome,
}) {
  const primaryProvider = config.model?.provider;
  const providers = primaryProvider
    ? [
        { role: "primary", provider: primaryProvider },
        ...(config.fallback_providers ?? []).map((fallback) => ({
          role: "fallback",
          provider: fallback.provider,
        })),
      ]
    : [];
  const failures = [];
  for (const selected of providers) {
    const requirement = credentialRequirement(config, selected.provider);
    if (!(await credentialAvailable({
      hermesHome,
      home,
      profileHome,
      requirement,
    }))) {
      failures.push(
        `no credential source found for ${selected.role} provider ${selected.provider}`,
      );
    }
  }
  if (!primaryProvider) {
    failures.push("no credential source found for unconfigured provider");
  }
  return {
    providers,
    available: providers.length > 0 && failures.length === 0,
    failures,
  };
}
