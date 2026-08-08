export const MAX_INLINE_HANDOFF_BYTES = 256 * 1024;

export function serializeInlineArtifact(inline) {
  if (typeof inline === "string") return Buffer.from(inline, "utf8");
  return Buffer.from(`${JSON.stringify(sortJson(inline), null, 2)}\n`, "utf8");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}
