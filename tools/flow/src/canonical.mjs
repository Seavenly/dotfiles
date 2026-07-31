import { createHash } from "node:crypto";

export function canonicalize(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" ||
      typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical values must use lossless JSON types");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("canonical values must use lossless JSON types");
  }
  if (ancestors.has(value)) {
    throw new Error("canonical values must not contain cycles");
  }
  ancestors.add(value);

  let canonical;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new Error("canonical values must use lossless JSON types");
      }
    }
    canonical = value.map((item) => canonicalize(item, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical values must use plain JSON objects");
    }
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
      throw new Error("canonical values must use lossless JSON types");
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

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
