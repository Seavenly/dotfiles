import { createHash } from "node:crypto";

export class CanonicalValueError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "CanonicalValueError";
    this.reason = reason;
  }
}

export function canonicalize(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" ||
      typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalValueError(
        "non_lossless_json_value",
        "canonical values must use lossless JSON types",
      );
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new CanonicalValueError(
      "non_lossless_json_value",
      "canonical values must use lossless JSON types",
    );
  }
  if (ancestors.has(value)) {
    throw new CanonicalValueError(
      "cyclic_canonical_value",
      "canonical values must not contain cycles",
    );
  }
  ancestors.add(value);

  let canonical;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new CanonicalValueError(
          "sparse_canonical_array",
          "canonical values must use lossless JSON types",
        );
      }
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      throw new CanonicalValueError(
        "decorated_canonical_array",
        "canonical arrays must not contain extra properties",
      );
    }
    canonical = value.map((item) => canonicalize(item, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalValueError(
        "non_plain_canonical_object",
        "canonical values must use plain JSON objects",
      );
    }
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
      throw new CanonicalValueError(
        "non_lossless_json_value",
        "canonical values must use lossless JSON types",
      );
    }
    canonical = Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key], ancestors)]),
    );
  }
  ancestors.delete(value);
  return canonical;
}

export function digest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

export function freezeCanonical(value) {
  return deepFreeze(canonicalize(value));
}

export function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function uniqueCanonical(values) {
  const byDigest = new Map(values.map((value) => [digest(value), value]));
  return [...byDigest].sort(([left], [right]) => left < right ? -1 : 1)
    .map(([, value]) => value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
