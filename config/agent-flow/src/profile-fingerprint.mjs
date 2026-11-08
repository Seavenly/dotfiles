import { createHash } from "node:crypto";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function fingerprint(value) {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
  return `sha256:${digest}`;
}

export function profileConfigurationFingerprint({
  config,
  hermesVersion,
  inspection,
  name,
}) {
  return fingerprint({
    schema: "agent-flow.profile-configuration/v1",
    hermesVersion,
    name,
    config,
    effective: {
      workerTools: inspection.tools.toSorted(),
      dispatchInGateway: inspection.dispatchInGateway,
      autoDecompose: inspection.autoDecompose,
      terminalBackend: inspection.terminalBackend,
      terminalHomeMode: inspection.terminalHomeMode,
      memoryEnabled: inspection.memoryEnabled,
      userProfileEnabled: inspection.userProfileEnabled,
      concurrency: inspection.concurrency,
    },
  });
}

export function profileSetFingerprint(profiles) {
  return fingerprint({
    schema: "agent-flow.profile-set/v1",
    profiles: profiles
      .map(({ configurationFingerprint, name }) => ({
        configurationFingerprint,
        name,
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  });
}
