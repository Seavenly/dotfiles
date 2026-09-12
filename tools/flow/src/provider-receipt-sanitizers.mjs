/**
 * The generic provider receipt boundary composes versioned domain policies.
 * Domain modules own their schema fields; this module owns only recursive
 * default-deny traversal, credential-shape filtering, and evidence checks.
 */

import {
  CORE_NESTED_FIELDS,
  CORE_RECEIPT_SCHEMA_FIELDS,
  OBSERVATION_DERIVED_RECEIPT_FIELDS,
  SENSITIVE_PROVIDER_RECEIPT_KEYS,
} from "./provider-receipt-policies/core.mjs";
import {
  DELEGATE_NESTED_FIELDS,
  DELEGATE_RECEIPT_SCHEMA_FIELDS,
  DELEGATE_REQUIRED_RECEIPT_FIELDS,
} from "./provider-receipt-policies/delegate-drovr.mjs";
import {
  FEATURE_WORK_NESTED_FIELDS,
  FEATURE_WORK_RECEIPT_SCHEMA_FIELDS,
} from "./provider-receipt-policies/feature-work.mjs";
import {
  REVIEW_NESTED_FIELDS,
  REVIEW_RECEIPT_SCHEMA_FIELDS,
} from "./provider-receipt-policies/review-github.mjs";
import {
  TRACKER_SUBRUN_RESOURCE_NESTED_FIELDS,
  TRACKER_SUBRUN_RESOURCE_RECEIPT_SCHEMA_FIELDS,
} from "./provider-receipt-policies/tracker-subrun-resource.mjs";

const PROVIDER_RECEIPT_SCHEMA_FIELDS = new Map([
  ...CORE_RECEIPT_SCHEMA_FIELDS,
  ...DELEGATE_RECEIPT_SCHEMA_FIELDS,
  ...FEATURE_WORK_RECEIPT_SCHEMA_FIELDS,
  ...REVIEW_RECEIPT_SCHEMA_FIELDS,
  ...TRACKER_SUBRUN_RESOURCE_RECEIPT_SCHEMA_FIELDS,
]);

const SAFE_PROVIDER_RECEIPT_NESTED_FIELDS = new Set([
  ...CORE_NESTED_FIELDS,
  ...DELEGATE_NESTED_FIELDS,
  ...FEATURE_WORK_NESTED_FIELDS,
  ...REVIEW_NESTED_FIELDS,
  ...TRACKER_SUBRUN_RESOURCE_NESTED_FIELDS,
]);

const REQUIRED_PROVIDER_RECEIPT_FIELDS = new Map([
  ...DELEGATE_REQUIRED_RECEIPT_FIELDS,
]);

export function sanitizeProviderReceipt(value) {
  if (!isRecord(value)) return null;
  const sanitized = sanitizeProviderReceiptValue(value);
  return hasPositiveProviderEvidence(sanitized) ? sanitized : null;
}

export function isProviderReceiptSchema(schema) {
  return typeof schema === "string" &&
    (PROVIDER_RECEIPT_SCHEMA_FIELDS.has(schema) ||
      /receipt\/v[0-9]+$/u.test(schema));
}

// Tracker progress predates the versioned receipt envelope and deliberately
// carries its provider proof without a schema field.  Keep that established
// shape on the same default-deny receipt policy used by versioned receipts.
export function isProviderReceiptEvidence(value) {
  return isRecord(value) && (isProviderReceiptSchema(value.schema) ||
    typeof value.authority_watermark === "string" &&
    typeof value.content_sha256 === "string" &&
    typeof value.mutation === "string");
}

export function hasRequiredProviderReceiptShape(original, sanitized, outcome) {
  if (!isRecord(original) || !isRecord(sanitized)) return false;
  const required = REQUIRED_PROVIDER_RECEIPT_FIELDS.get(original.schema) ?? [];
  if (required.some((key) => Object.hasOwn(original, key) &&
      !Object.hasOwn(sanitized, key))) return false;
  if (outcome === "succeeded" &&
      original.schema === "flow.delegate-evidence/v1" &&
      Object.hasOwn(original, "validated_output") &&
      !Object.hasOwn(sanitized, "validated_output")) return false;
  return true;
}

export function hasPositiveProviderEvidence(value) {
  return hasPositiveEvidence(value);
}

export function isCredentialShapedString(value) {
  return typeof value === "string" &&
    /(?:^|[\s=:])(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}(?=$|[\s,;])|(?:^|[\s=:])(?:gh[pousr]|github_pat|xox[baprs])_[A-Za-z0-9_-]{8,}(?=$|[\s,;])|\b(?:api[_-]?key|authorization|bearer|cookie|password|credential|private[_ -]?key|secret|token)\s*[:=]\s*[^\s,;]+/iu.test(value);
}

export function sanitizeProviderReceiptValue(value, { root = true } = {}) {
  if (Array.isArray(value)) {
    return value.flatMap((candidate) => {
      if (isCredentialShapedString(candidate)) return [];
      const sanitized = sanitizeProviderReceiptValue(candidate, { root: false });
      return sanitized === null || sanitized === undefined ? [] : [sanitized];
    });
  }
  if (typeof value === "string") {
    return isCredentialShapedString(value) ? null : value;
  }
  if (!isRecord(value)) return value;
  const schema = typeof value.schema === "string" ? value.schema : null;
  const schemaFields = schema === null
    ? CORE_RECEIPT_SCHEMA_FIELDS.get("flow.provider-receipt/v1")
    : PROVIDER_RECEIPT_SCHEMA_FIELDS.get(schema) ??
      CORE_RECEIPT_SCHEMA_FIELDS.get("flow.provider-receipt/v1");
  const rootFields = new Set([
    ...schemaFields,
    ...OBSERVATION_DERIVED_RECEIPT_FIELDS,
  ]);
  const allowedFields = root
    ? rootFields
    : schema !== null && PROVIDER_RECEIPT_SCHEMA_FIELDS.has(schema)
      ? PROVIDER_RECEIPT_SCHEMA_FIELDS.get(schema)
      : SAFE_PROVIDER_RECEIPT_NESTED_FIELDS;
  const result = {};
  for (const [key, candidate] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    if (SENSITIVE_PROVIDER_RECEIPT_KEYS.has(normalizedKey) ||
        !allowedFields.has(key) || isCredentialShapedString(candidate)) {
      continue;
    }
    const sanitized = sanitizeProviderReceiptValue(candidate, { root: false });
    if (sanitized === undefined ||
        sanitized === null && candidate !== null) continue;
    if (isRecord(candidate) && isRecord(sanitized) &&
        Object.keys(sanitized).length === 0) continue;
    result[key] = sanitized;
  }
  return result;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasPositiveEvidence(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.some(hasPositiveEvidence);
  if (!isRecord(value)) return true;
  return Object.entries(value)
    .filter(([key]) => key !== "schema")
    .some(([, candidate]) => hasPositiveEvidence(candidate));
}
