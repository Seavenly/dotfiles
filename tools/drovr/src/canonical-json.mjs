import { createHash } from "node:crypto";

import { DrovrError } from "./errors.mjs";

export function digestCanonical(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalizeJson(value)))
    .digest("hex")}`;
}

export function canonicalizeJson(value, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) invalidValue();
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    if (
      Reflect.ownKeys(value).length !== value.length + 1 ||
      value.some((_, index) => !Object.hasOwn(value, index))
    ) {
      invalidValue();
    }
    result = value.map((item) => canonicalizeJson(item, ancestors));
  } else {
    if (
      !isRecord(value) ||
      Reflect.ownKeys(value).length !== Object.keys(value).length
    ) {
      invalidValue();
    }
    result = Object.fromEntries(
      Object.keys(value)
        .sort(compare)
        .map((key) => [key, canonicalizeJson(value[key], ancestors)]),
    );
  }
  ancestors.delete(value);
  return result;
}

function invalidValue() {
  throw new DrovrError("values must be lossless JSON", {
    code: 2,
    outcome: "invalid_arguments",
  });
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
