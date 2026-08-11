import {
  CanonicalValueError,
  digest,
  freezeCanonical,
  isPlainRecord,
} from "./canonical.mjs";

/**
 * The evidence-safety contract is deliberately independent of FlowRuntime and
 * all work-domain authorities.  It only classifies caller-supplied canonical
 * JSON values and returns content-addressed data.
 */
export const EVIDENCE_SAFETY_REQUEST_SCHEMA =
  "flow.evidence-safety-request/v1";
export const EVIDENCE_SAFETY_RECEIPT_SCHEMA =
  "flow.evidence-safety-receipt/v1";
export const EVIDENCE_SAFETY_REJECTION_SCHEMA =
  "flow.evidence-safety-rejection/v1";
export const EVIDENCE_SAFETY_BINDING_SCHEMA =
  "flow.evidence-safety-binding/v1";
export const EVIDENCE_SAFETY_POLICY_ID = "flow.evidence-safety-policy/v1";
export const EVIDENCE_SAFETY_CATALOG_ID = "flow.contract-catalog/v1@21";

export const EVIDENCE_SAFETY_BOUNDARIES = Object.freeze([
  "delegate_transfer",
  "artifact_acceptance",
  "resource_handoff_publication",
]);

export const EVIDENCE_SAFETY_CLASSIFICATIONS = Object.freeze([
  "research",
  "delegate_evidence",
  "artifact_evidence",
  "resource_handoff_evidence",
]);

export const EVIDENCE_SAFETY_LIMITS = Object.freeze({
  max_depth: 32,
  max_nodes: 512,
  max_string_length: 8_192,
  max_total_string_length: 65_536,
  max_encoded_layers: 3,
  max_nested_structured_strings: 16,
});

const REQUEST_FIELDS = Object.freeze([
  "schema",
  "policy_id",
  "catalog_id",
  "classification",
  "allowed_use",
  "input_digest",
  "input",
]);

const FACTORY_FIELDS = Object.freeze([
  "classification",
  "allowed_use",
  "input",
]);

const RECEIPT_FIELDS = Object.freeze([
  "schema",
  "policy_id",
  "catalog_id",
  "classification",
  "allowed_use",
  "input_digest",
  "receipt_digest",
  "self_digest",
]);

const SENSITIVE_KEY = /^(?:(?:api|auth|authorization|authentication|oauth|bearer)[_-]?(?:key|token|secret)(?:[_-]?key)?|api[_-]?keys?|api[_-]?tokens?|access[_-]?key|aws[_-]?secret[_-]?access[_-]?key|secret(?:s)?|secret[_-]?keys?|secret[_-]?(?:refs?|references?)|client[_-]?(?:secret|token)|password|passwd|passphrase|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?|cookie|session(?:[_-]?id)?|private[_-]?keys?|credential(?:s)?|credential[_-]?(?:refs?|references?)|token[_-]?(?:refs?|references?)|auth[_-]?ref)$/i;
const NORMALIZED_SENSITIVE_KEY = /^(?:(?:x)?(?:api|auth|authorization|authentication|oauth|bearer)(?:key|token|secret|credential|ref|reference)(?:key)?|(?:aws)?secretaccesskey|(?:x)?(?:access|refresh|id|client|aws|secret|private|session|cookie|password|passwd|passphrase|token|credential)(?:access|key|token|secret|credential|id|ref|reference)?s?)$/i;

const CONCEPTUAL_SENSITIVE_KEY = /^(?:auth(?:orization|entication)?|credential(?:s)?)$/i;
const CONCEPTUAL_COMPOUND_SENSITIVE_KEY = /^(?:api[_-]?keys|api[_-]?tokens|secrets|secret[_-]?keys|secret[_-]?(?:refs|references)|private[_-]?keys|credential[_-]?(?:refs|references)|token[_-]?(?:refs|references))$/i;

const CAPABILITY_KEY = /^(?:capability(?:[_-]?(?:refs?|references?|envelopes?|grants?|ids?|identifiers?))?|capabilities|envelope|effective[_-]?authority|delegated[_-]?authority|permission(?:s)?|grant(?:s)?|credential[_-]?(?:refs?|references?)|token[_-]?(?:refs?|references?)|auth[_-]?ref)$/i;

const LATE_EVIDENCE_KEY = /^(?:status|outcome|disposition|late[_-]?result|(?:evidence|result|output|turn)[_-]?disposition)$/i;

const AMBIENT_KEY = /^(?:path|paths|file|filename|directory|dir|root|cwd|working[_-]?directory|workdir|workspace[_-]?path|mount|socket|unix[_-]?socket|pipe|home)$/i;

const MATERIAL_KEY = /^(?:id|ref|reference|value|material|bytes|raw|data|content|scope|grant|envelope|token|secret|key|credential|permission(?:s)?)$/i;

const SENSITIVE_QUERY_KEY = /^(?:api[_-]?key|apikey|access[_-]?key|secret|password|passwd|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|authorization|credential|session|cookie)$/i;
const NORMALIZED_SENSITIVE_QUERY_KEY = /^(?:signature|sig|credential|credentials|accesskeyid|securitytoken|xapikey|xauthtoken|xamz(?:signature|credential|securitytoken|accesskeyid)|xgoog(?:signature|credential|securitytoken|accesskeyid)|oauth(?:signature|credential|securitytoken|consumerkey|token)|awsaccesskeyid|googleaccessid)$/i;

const TOKEN_PREFIX = /(?:gh[pousr]_[A-Za-z0-9_\-]{8,}|github_pat_[A-Za-z0-9_\-]{8,}|glpat-[A-Za-z0-9_\-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|(?:sk|rk)_(?:live|test|secret|restricted)_[A-Za-z0-9_\-]{8,}|sk(?:-[A-Za-z0-9]+){1,}-[A-Za-z0-9_\-]{12,}|sk-[A-Za-z0-9]{16,}|rk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_\-]{20,}|ya29\.[0-9A-Za-z_\-]{12,}|npm_[A-Za-z0-9]{12,}|pypi-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{12,}|dop_v1_[A-Za-z0-9]{12,}|pat_[A-Za-z0-9]{12,})/i;

const BEARER_OR_BASIC = /\b(?:bearer|basic)\s+([A-Za-z0-9+/=_\-.]+)/i;
const AUTHORIZATION_PROSE = /\b(?:algorithm(?:s)?|auth(?:entication|orization)?|concept(?:ual)?|documentation|discussion|model(?:s)?|research|semantics?)\b/i;
const AUTHORIZATION_CONCEPT = /^(?:algorithm(?:s)?|auth(?:entication|orization)?|model(?:s)?|protocol|scheme|semantics?|token)$/i;
const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i;
const PGP_PRIVATE_KEY = /-----BEGIN PGP PRIVATE KEY BLOCK-----/i;
const SSH_PUBLIC_KEY = /\bssh-(?:rsa|ed25519|ecdsa-[a-z0-9-]+)\s+[A-Za-z0-9+/]{32,}(?:=*)?(?:\s|$)/i;
const ASSIGNMENT_SECRET = /\b(?:(?:api|auth|oauth|authorization)[_-]?(?:key|secret|token)|apikey|access[_-]?key|(?:aws[_-]?)?secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?(?:secret|token)|secret|password|passwd|token|access[_-]?token|refresh[_-]?token|authorization|cookie)\s*[:=]\s*([^\s,;&}]+)/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i;
const ENCODED_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+%3a[^\s/@]+@/i;
const URI_SCHEME = /\b([a-z][a-z0-9+.-]*):\/\//i;
const LOCAL_HOST = /^(?:localhost|localhost\.local|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|\[?0:0:0:0:0:0:0:1\]?)$/i;
const IMMUTABLE_SHA = /(?:^|\/)(?:[0-9a-f]{40}|[0-9a-f]{64})(?:$|[/?#])/i;
const PLACEHOLDER = /^(?:<[^>]{1,128}>|\$\{[^}]{1,128}\}|\[redacted\]|redacted|(?:example|sample|dummy|placeholder|not[-_ ]?real|fake|masked|unknown)|(?:your|the)[-_ ]?(?:token|secret|key|password)|(?:token|secret|key|password)[-_ ]?(?:value|here)|\.{3,}|xxx+|n\/a|null)$/i;

/**
 * Return the public policy/catalog view used by callers and documentation.
 * The returned object is deeply immutable and contains no implementation
 * details such as private patterns or traversal paths.
 */
export function getEvidenceSafetyCatalog() {
  return freezeCanonical({
    schema: "flow.evidence-safety-catalog/v1",
    policy_id: EVIDENCE_SAFETY_POLICY_ID,
    catalog_id: EVIDENCE_SAFETY_CATALOG_ID,
    request: {
      schema: EVIDENCE_SAFETY_REQUEST_SCHEMA,
      fields: [...REQUEST_FIELDS],
      input: "canonical_json_value",
      input_digest: "sha256_of_canonical_input_bytes",
    },
    receipt: {
      schema: EVIDENCE_SAFETY_RECEIPT_SCHEMA,
      fields: [...RECEIPT_FIELDS],
      digest: "self_digest_bound_to_receipt_identity",
    },
    rejection: {
      schema: EVIDENCE_SAFETY_REJECTION_SCHEMA,
      redaction: "no_rejected_input_bytes_or_fragments",
      reason_shape: "stable_code_only",
    },
    classifications: [...EVIDENCE_SAFETY_CLASSIFICATIONS],
    allowed_uses: [...EVIDENCE_SAFETY_BOUNDARIES],
    boundaries: {
      delegate_transfer: "receipt_only_non_authoritative_binding",
      artifact_acceptance: "receipt_only_non_authoritative_binding",
      resource_handoff_publication: "receipt_only_non_authoritative_binding",
    },
    prohibited_inputs: [
      "credential_material",
      "capability_reference_or_envelope",
      "ambient_filesystem_path",
      "ambiguous_or_malformed_encoding",
    ],
    limits: { ...EVIDENCE_SAFETY_LIMITS },
  });
}

/** Build an exact request without consulting any ambient source. */
export function createEvidenceSafetyRequest(options = {}) {
  const optionsIssue = validateFactoryOptions(options);
  if (optionsIssue) {
    throw new CanonicalValueError(
      optionsIssue,
      "request factory options must be bounded own data properties",
    );
  }
  const classification = options.classification;
  const allowedUse = options.allowed_use;
  const input = options.input;
  const allowedUseIssue = validateDataProperties(allowedUse);
  if (allowedUseIssue) {
    throw new CanonicalValueError(
      allowedUseIssue,
      "request factory allowed use must be canonical",
    );
  }
  const inputSnapshot = boundedCanonicalSnapshot(input);
  return freezeCanonical({
    schema: EVIDENCE_SAFETY_REQUEST_SCHEMA,
    policy_id: EVIDENCE_SAFETY_POLICY_ID,
    catalog_id: EVIDENCE_SAFETY_CATALOG_ID,
    classification,
    allowed_use: normalizeAllowedUses(allowedUse),
    input_digest: digest(inputSnapshot),
    input: inputSnapshot,
  });
}

/**
 * Validate one caller-supplied evidence request.  Every branch returns a
 * stable, redacted result; malformed values never escape as transport errors.
 */
export function validateEvidenceSafety(request) {
  try {
    const requestIssue = validateRequestShape(request);
    if (requestIssue) return rejected(requestIssue);

    const inputSnapshot = boundedCanonicalSnapshot(request.input);
    const inputDigest = digest(inputSnapshot);
    if (request.input_digest !== inputDigest) {
      return rejected("input_digest_mismatch");
    }

    const scan = scanInput(inputSnapshot);
    if (scan) return rejected(scan);

    const allowedUse = normalizeAllowedUses(request.allowed_use);
    const identity = {
      schema: EVIDENCE_SAFETY_RECEIPT_SCHEMA,
      policy_id: EVIDENCE_SAFETY_POLICY_ID,
      catalog_id: EVIDENCE_SAFETY_CATALOG_ID,
      classification: request.classification,
      allowed_use: allowedUse,
      input_digest: inputDigest,
    };
    const receiptDigest = digest(identity);
    const receipt = freezeCanonical({
      ...identity,
      receipt_digest: receiptDigest,
      self_digest: receiptDigest,
    });
    return { accepted: true, receipt };
  } catch (error) {
    return rejected(canonicalFailure(error));
  }
}

/**
 * Bind one accepted safety receipt to a non-authoritative boundary.  The
 * binder carries only immutable digest identities and cannot grant lifecycle,
 * publication, mutation, or capability authority.
 */
export function bindEvidenceReceipt(receiptOrRequest, context = {}) {
  try {
    const prepared = prepareBindingArguments(receiptOrRequest, context);
    if (prepared.invalidContext) {
      return rejected(prepared.invalidContext, "bind");
    }
    return bindPreparedEvidenceReceipt(prepared);
  } catch (error) {
    return rejected(canonicalFailure(error), "bind");
  }
}

export function bindDelegateEvidenceReceipt(receiptOrRequest, context = {}) {
  return bindBoundaryReceipt(receiptOrRequest, context, "delegate_transfer");
}

export function bindArtifactAcceptanceReceipt(receiptOrRequest, context = {}) {
  return bindBoundaryReceipt(receiptOrRequest, context, "artifact_acceptance");
}

export function bindResourceHandoffReceipt(receiptOrRequest, context = {}) {
  return bindBoundaryReceipt(
    receiptOrRequest,
    context,
    "resource_handoff_publication",
  );
}

function bindBoundaryReceipt(receiptOrRequest, context, boundary) {
  try {
    const prepared = prepareBindingArguments(receiptOrRequest, context);
    if (prepared.invalidContext) {
      return rejected(prepared.invalidContext, "bind");
    }
    if (prepared.boundary !== undefined && prepared.boundary !== boundary) {
      return rejected("invalid_binding_context", "bind");
    }
    if (!prepared.wrapper && Object.hasOwn(prepared.receipt, "boundary") &&
        prepared.receipt.boundary !== boundary) {
      return rejected("invalid_binding_context", "bind");
    }
    prepared.boundary = boundary;
    return bindPreparedEvidenceReceipt(prepared);
  } catch (error) {
    return rejected(canonicalFailure(error), "bind");
  }
}

function bindPreparedEvidenceReceipt({ receipt, boundary, subjectDigest }) {
  if (!EVIDENCE_SAFETY_BOUNDARIES.includes(boundary)) {
    return rejected("unknown_boundary", "bind");
  }
  const receiptIssue = validateReceipt(receipt);
  if (receiptIssue) return rejected(receiptIssue, "bind");
  if (!receipt.allowed_use.includes(boundary)) {
    return rejected("allowed_use_mismatch", "bind");
  }
  if (subjectDigest !== null && !isDigest(subjectDigest)) {
    return rejected("invalid_subject_digest", "bind");
  }
  const identity = {
    schema: EVIDENCE_SAFETY_BINDING_SCHEMA,
    boundary,
    receipt_digest: receipt.receipt_digest,
    input_digest: receipt.input_digest,
    subject_digest: subjectDigest,
  };
  const bindingDigest = digest(identity);
  const binding = freezeCanonical({
    ...identity,
    binding_digest: bindingDigest,
    self_digest: bindingDigest,
  });
  return { accepted: true, binding };
}

function validateRequestShape(request) {
  if (!isPlainRecord(request)) {
    return "invalid_request_shape";
  }
  if (!hasOnlyDataProperties(request)) return "non_canonical_input";
  if (!hasExactKeys(request, REQUEST_FIELDS)) return "invalid_request_shape";
  if (request.schema !== EVIDENCE_SAFETY_REQUEST_SCHEMA) {
    return "unsupported_request_schema";
  }
  if (request.policy_id !== EVIDENCE_SAFETY_POLICY_ID) {
    return "policy_identity_mismatch";
  }
  if (request.catalog_id !== EVIDENCE_SAFETY_CATALOG_ID) {
    return "catalog_identity_mismatch";
  }
  if (!EVIDENCE_SAFETY_CLASSIFICATIONS.includes(request.classification)) {
    return "unsupported_classification";
  }
  const allowedUseIssue = validateDataProperties(request.allowed_use);
  if (allowedUseIssue) return allowedUseIssue;
  try {
    normalizeAllowedUses(request.allowed_use);
  } catch {
    return "invalid_allowed_use";
  }
  if (!isDigest(request.input_digest)) {
    return "invalid_input_digest";
  }
  return null;
}

function hasOnlyDataProperties(value) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
    return keys.every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable &&
        Object.hasOwn(descriptor, "value");
    });
  } catch {
    return false;
  }
}

function validateFactoryOptions(options) {
  if (!isPlainRecord(options) || !hasOnlyDataProperties(options)) {
    return "non_canonical_input";
  }
  try {
    if (!hasExactKeys(options, FACTORY_FIELDS)) {
      return "invalid_request_shape";
    }
  } catch {
    return "non_canonical_input";
  }
  return null;
}

function validateDataProperties(
  value,
  ancestors = new Set(),
  state = { depth: 0, nodes: 0, totalStringLength: 0 },
) {
  state.nodes += 1;
  if (state.nodes > EVIDENCE_SAFETY_LIMITS.max_nodes) {
    return "evidence_too_large";
  }
  if (state.depth > EVIDENCE_SAFETY_LIMITS.max_depth) {
    return "evidence_too_deep";
  }

  if (typeof value === "string") {
    const size = stringByteLength(value);
    if (size > EVIDENCE_SAFETY_LIMITS.max_string_length ||
        state.totalStringLength + size >
          EVIDENCE_SAFETY_LIMITS.max_total_string_length) {
      return "evidence_too_large";
    }
    state.totalStringLength += size;
    return null;
  }
  if (value === null || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : "non_canonical_input";
  }
  if (typeof value !== "object") return "non_canonical_input";
  if (ancestors.has(value)) return "cyclic_input";

  if (!Array.isArray(value) && !isPlainRecord(value)) {
    return "non_canonical_input";
  }

  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return "non_canonical_input";
  }
  ancestors.add(value);
  state.depth += 1;

  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) {
      state.depth -= 1;
      ancestors.delete(value);
      return "non_canonical_input";
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!keys.includes(String(index))) {
        state.depth -= 1;
        ancestors.delete(value);
        return "non_canonical_input";
      }
    }
  } else if (keys.length !== Object.keys(value).length) {
    state.depth -= 1;
    ancestors.delete(value);
    return "non_canonical_input";
  }

  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string") {
      state.depth -= 1;
      ancestors.delete(value);
      return "non_canonical_input";
    }
    if (!Array.isArray(value)) {
      const size = stringByteLength(key);
      if (size > EVIDENCE_SAFETY_LIMITS.max_string_length ||
          state.totalStringLength + size >
            EVIDENCE_SAFETY_LIMITS.max_total_string_length) {
        state.depth -= 1;
        ancestors.delete(value);
        return "evidence_too_large";
      }
      state.totalStringLength += size;
    }
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      state.depth -= 1;
      ancestors.delete(value);
      return "non_canonical_input";
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      state.depth -= 1;
      ancestors.delete(value);
      return "non_canonical_input";
    }
    const issue = validateDataProperties(descriptor.value, ancestors, state);
    if (issue) {
      state.depth -= 1;
      ancestors.delete(value);
      return issue;
    }
  }
  state.depth -= 1;
  ancestors.delete(value);
  return null;
}

function boundedCanonicalSnapshot(value) {
  const issue = validateDataProperties(value);
  if (issue) {
    throw new CanonicalValueError(
      issue,
      "value does not satisfy the bounded canonical evidence contract",
    );
  }
  try {
    return freezeCanonical(value);
  } catch (error) {
    if (error instanceof CanonicalValueError) throw error;
    throw new CanonicalValueError(
      "non_canonical_input",
      "value could not be canonically snapshotted",
    );
  }
}

function normalizeAllowedUses(value) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some((item) =>
    !EVIDENCE_SAFETY_BOUNDARIES.includes(item))) {
    throw new Error("invalid allowed use");
  }
  const unique = [...new Set(values)];
  if (unique.length !== values.length) throw new Error("duplicate allowed use");
  return EVIDENCE_SAFETY_BOUNDARIES.filter((boundary) =>
    unique.includes(boundary));
}

function scanInput(input) {
  const state = {
    depth: 0,
    nodes: 0,
    totalStringLength: 0,
    nestedStructuredStrings: 0,
    inspectedUriMetadata: new Set(),
    ancestors: new Set(),
  };
  try {
    return scanValue(input, state, "input");
  } catch (error) {
    return canonicalFailure(error);
  }
}

function scanValue(value, state, keyName, inheritedLateKey = null) {
  const activeLateKey = LATE_EVIDENCE_KEY.test(keyName)
    ? keyName
    : inheritedLateKey;
  state.nodes += 1;
  if (state.nodes > EVIDENCE_SAFETY_LIMITS.max_nodes) return "evidence_too_large";
  if (state.depth > EVIDENCE_SAFETY_LIMITS.max_depth) return "evidence_too_deep";
  if (value === null || typeof value === "boolean") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : "non_canonical_input";
  }
  if (typeof value === "string") {
    return scanString(value, state, activeLateKey ?? keyName);
  }
  if (typeof value !== "object") return "non_json_input";
  if (state.ancestors.has(value)) return "cyclic_input";
  state.ancestors.add(value);
  state.depth += 1;

  let issue = null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && !issue; index += 1) {
      if (!Object.hasOwn(value, index)) {
        issue = "non_canonical_input";
        break;
      }
      issue = scanValue(value[index], state, String(index), activeLateKey);
    }
    if (!issue && Reflect.ownKeys(value).length !== value.length + 1) {
      issue = "unexpected_input_fields";
    }
  } else if (!isPlainRecord(value)) {
    issue = "non_canonical_input";
  } else {
    if (looksLikeStructuralCapabilityEnvelope(value)) {
      issue = "capability_reference";
    }
    // Canonical JSON sorts object keys; array traversal above intentionally
    // retains caller-declared order.
    for (const key of Object.keys(value).sort()) {
      if (issue) break;
      const child = value[key];
      let semanticKey = key;
      issue = scanString(
        key,
        state,
        "object_key",
        (candidate) => {
          semanticKey = candidate;
          return inspectKeyAndValue(candidate, child);
        },
        { base64MinimumLength: 4 },
      );
      if (issue) break;
      issue = scanValue(child, state, semanticKey, activeLateKey);
      if (issue) break;
    }
    if (!issue && Reflect.ownKeys(value).length !== Object.keys(value).length) {
      issue = "non_canonical_input";
    }
  }
  state.depth -= 1;
  state.ancestors.delete(value);
  return issue;
}

function inspectKeyAndValue(key, value) {
  if (isLateResultKey(key) && hasSubstantiveLateResult(value)) {
    return "cancelled_or_late_evidence";
  }
  if (isLateEvidenceMarker(key, value)) {
    return "cancelled_or_late_evidence";
  }
  if (isCapabilityKey(key)) {
    if (isPlaceholderValue(value) || isConceptualProse(value)) return null;
    if (isPlainRecord(value) || Array.isArray(value)) {
      return containsMaterial(value) ? "capability_reference" : null;
    }
    return "capability_reference";
  }
  if (isSensitiveKey(key)) {
    if (isPlaceholderValue(value) || value === null || value === false) {
      return null;
    }
    if ((isConceptualSensitiveKey(key) ||
        CONCEPTUAL_COMPOUND_SENSITIVE_KEY.test(key)) &&
        isConceptualProse(value)) {
      return null;
    }
    if (isPlainRecord(value) || Array.isArray(value)) {
      return containsMaterial(value) ? "credential_material" : null;
    }
    return "credential_material";
  }
  if (AMBIENT_KEY.test(key) && typeof value === "string" &&
      !isPlaceholder(value) && !isConceptualProse(value)) {
    return "ambient_filesystem_path";
  }
  return null;
}

function normalizeSemanticKey(key) {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(key) ||
    NORMALIZED_SENSITIVE_KEY.test(normalizeSemanticKey(key));
}

function isConceptualSensitiveKey(key) {
  return CONCEPTUAL_SENSITIVE_KEY.test(key) ||
    /^(?:auth|authentication|authorization|credential|credentials)$/i.test(
      normalizeSemanticKey(key),
    );
}

function isCapabilityKey(key) {
  return CAPABILITY_KEY.test(key) ||
    /^(?:capability(?:ref|reference|envelope|envelopes|grant|grants|id|ids|identifier|identifiers)?|capabilities|envelope|(?:effective|delegated|requested|authority)(?:authority|ref|reference|envelope|envelopes|id|ids|identifier|identifiers|grant|grants|permission|permissions|scope|capability|capabilities)?|permissions?|grants?)$/i.test(
      normalizeSemanticKey(key),
    );
}

function isLateResultKey(key) {
  return /^late[_-]?result$/i.test(key);
}

function hasSubstantiveLateResult(value) {
  if (value === null || value === false || isPlaceholderValue(value)) {
    return false;
  }
  if (typeof value === "string") return !isConceptualProse(value);
  if (typeof value !== "object") return true;
  if (Array.isArray(value)) return value.some(hasSubstantiveLateResult);
  if (!isPlainRecord(value)) return true;
  return Object.values(value).some(hasSubstantiveLateResult);
}

function isConceptualProse(value) {
  if (typeof value !== "string" || isPlaceholder(value)) return false;
  const words = value.trim().split(/\s+/u);
  if (words.length < 3 || !/[A-Za-z]/u.test(value)) return false;
  return /\b(?:about|algorithm(?:s)?|concept(?:ual)?|discussion|discuss(?:es|ed|ion)?|documentation|example|models?|normalization|overview|prose|research|theor(?:y|ies)|vocabulary)\b/i.test(value) ||
    /\b(?:is|are|means?|describes?|represents?|explains?|contains?|uses?|supports?|covers?|defines?)\b/i.test(value) &&
    !/[/:\\]/.test(value);
}

function containsMaterial(value) {
  if (typeof value === "string") {
    return !isPlaceholder(value) && !isConceptualProse(value);
  }
  if (value === null || value === false) return false;
  if (typeof value !== "object") return true;
  if (Array.isArray(value)) return value.some((child) => containsMaterial(child));
  if (!isPlainRecord(value)) return true;
  return Object.entries(value).some(([key, child]) => MATERIAL_KEY.test(key) ||
    containsMaterial(child));
}

function looksLikeStructuralCapabilityEnvelope(value) {
  if (!isPlainRecord(value)) return false;
  const entries = Object.entries(value);
  const marker = entries.some(([key, child]) => {
    return semanticKeyMatches(
      key,
      /^(?:type|kind|contract|schema|envelopetype)$/,
    ) && typeof child === "string" &&
      semanticValueMatches(
        child,
        /(?:capability|authority|grant|permission|delegat|envelope)/i,
      );
  });
  const subject = entries.find(([key]) =>
    semanticKeyMatches(
      key,
      /^(?:subject|target|resource|object|resourceid|resourcekey)$/,
    ));
  const grant = entries.find(([key]) =>
    semanticKeyMatches(
      key,
      /^(?:scope|grant|grants|permission|permissions|action|actions|authority|authorityscope|capability|capabilities|command|commands|mutation|mutations|operation|operations|right|rights|privilege|privileges|effect|effects)$/,
    ));
  const substantiveEnvelope = subject !== undefined && grant !== undefined &&
    hasSubstantiveEnvelopeMaterial(subject[1]) &&
    hasSubstantiveEnvelopeMaterial(grant[1]);
  if (substantiveEnvelope) return true;

  const markerlessSubject = entries.find(([key]) =>
    semanticKeyMatches(key, /^(?:subject|target)$/));
  const markerlessGrant = entries.find(([key]) =>
    semanticKeyMatches(
      key,
      /^(?:scope|grant|grants|permission|permissions|action|actions|authority|authorityscope|capability|capabilities|command|commands|mutation|mutations|operation|operations|right|rights|privilege|privileges|effect|effects)$/,
    ));
  return !marker && markerlessSubject !== undefined &&
    markerlessGrant !== undefined &&
    hasSubstantiveEnvelopeMaterial(markerlessSubject[1]) &&
    hasSubstantiveEnvelopeMaterial(markerlessGrant[1]);
}

function semanticKeyMatches(key, pattern) {
  return semanticStringCandidates(key, 4).some((candidate) =>
    pattern.test(normalizeSemanticKey(candidate)));
}

function semanticValueMatches(value, pattern) {
  return semanticStringCandidates(value, 4).some((candidate) =>
    pattern.test(candidate));
}

function semanticStringCandidates(value, base64MinimumLength) {
  if (typeof value !== "string") return [];
  const candidates = [];
  let candidate = value;
  for (let layer = 0;
    layer <= EVIDENCE_SAFETY_LIMITS.max_encoded_layers;
    layer += 1) {
    candidates.push(candidate);
    const decoded = nextEncodedValue(candidate, { base64MinimumLength });
    if (decoded === null || decoded === candidate) break;
    candidate = decoded;
  }
  return candidates;
}

function hasSubstantiveEnvelopeMaterial(value) {
  if (value === null || value === false || isPlaceholderValue(value)) {
    return false;
  }
  if (typeof value === "string") return !isConceptualProse(value);
  if (typeof value !== "object") return true;
  if (Array.isArray(value)) return value.some(hasSubstantiveEnvelopeMaterial);
  if (!isPlainRecord(value)) return true;
  return Object.values(value).some(hasSubstantiveEnvelopeMaterial);
}

function scanString(
  value,
  state,
  keyName,
  onCandidate = null,
  { base64MinimumLength = 8 } = {},
) {
  const size = stringByteLength(value);
  state.totalStringLength += size;
  if (size > EVIDENCE_SAFETY_LIMITS.max_string_length ||
      state.totalStringLength > EVIDENCE_SAFETY_LIMITS.max_total_string_length) {
    return "evidence_too_large";
  }
  let candidate = value;
  for (let layer = 0;
    layer <= EVIDENCE_SAFETY_LIMITS.max_encoded_layers;
    layer += 1) {
    const issue = inspectString(candidate, state, keyName, {
      checkRawUriPercent: layer === 0,
    });
    if (issue) return issue;
    if (onCandidate) {
      const candidateIssue = onCandidate(candidate);
      if (candidateIssue) return candidateIssue;
    }
    if (isImmutableSourceUri(candidate)) return null;
    const decoded = nextEncodedValue(candidate, {
      base64MinimumLength: layer > 0 ? 4 : base64MinimumLength,
    });
    if (decoded === null || decoded === candidate) return null;
    if (layer === EVIDENCE_SAFETY_LIMITS.max_encoded_layers) {
      return "ambiguous_normalization";
    }
    const decodedSize = stringByteLength(decoded);
    state.totalStringLength += decodedSize;
    if (decodedSize > EVIDENCE_SAFETY_LIMITS.max_string_length ||
        state.totalStringLength > EVIDENCE_SAFETY_LIMITS.max_total_string_length) {
      return "evidence_too_large";
    }
    candidate = decoded;
  }
  return "ambiguous_normalization";
}

function inspectString(
  value,
  state,
  keyName,
  { checkRawUriPercent = true } = {},
) {
  if (value !== value.normalize("NFC")) return "ambiguous_normalization";
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    return "malformed_encoding";
  }
  if (isLateEvidenceMarker(keyName, value)) {
    return "cancelled_or_late_evidence";
  }
  if (looksLikeCredential(value)) return "credential_material";
  if (looksLikeCapabilityReference(value)) return "capability_reference";
  if (looksLikeMalformedPercentEncoding(value)) return "malformed_encoding";
  if (decodePercentOnce(value).malformed) return "malformed_encoding";
  const immutableMetadataIssue = inspectImmutableUrlMetadata(value, {
    checkRawPercent: checkRawUriPercent,
    state,
  }) ?? inspectEmbeddedImmutableUrlMetadata(value, {
    checkRawPercent: checkRawUriPercent,
    state,
  });
  if (immutableMetadataIssue) return immutableMetadataIssue;
  const nested = parseNestedStructuredString(value);
  const hasNestedStructure = nested !== null && typeof nested === "object";
  if (!hasNestedStructure && isPathLike(value, checkRawUriPercent)) {
    return "ambient_filesystem_path";
  }
  const explicitBase64 = decodeExplicitBase64(value);
  if (explicitBase64.present && explicitBase64.decoded === null) {
    return "malformed_encoding";
  }
  if (looksLikeMalformedEncoding(value, keyName)) return "malformed_encoding";

  if (nested === "duplicate_keys") return "non_canonical_input";
  if (nested === "too_deep") return "evidence_too_deep";
  if (nested === "too_large") return "evidence_too_large";
  if (nested === "malformed") return "malformed_encoding";
  if (nested !== null) {
    state.nestedStructuredStrings += 1;
    if (state.nestedStructuredStrings >
        EVIDENCE_SAFETY_LIMITS.max_nested_structured_strings) {
      return "evidence_too_large";
    }
    const nestedIssue = scanValue(nested, state, keyName);
    if (nestedIssue) return nestedIssue;
  }
  return null;
}

function isLateEvidenceMarker(key, value) {
  return typeof key === "string" && LATE_EVIDENCE_KEY.test(key) &&
    typeof value === "string" &&
    /^(?:cancelled|canceled|late|quarantined|late[_-]quarantined|late[_-]unclaimed)$/i.test(value.trim());
}

function nextEncodedValue(value, { base64MinimumLength = 8 } = {}) {
  const explicitBase64 = decodeExplicitBase64(value);
  if (explicitBase64.present) return explicitBase64.decoded;
  const percentDecoded = decodePercentOnce(value);
  if (percentDecoded.malformed) return null;
  if (percentDecoded.decoded !== value) return percentDecoded.decoded;
  return decodeBoundedBase64(value, { minimumLength: base64MinimumLength });
}

function looksLikeCredential(value) {
  if (isPlaceholder(value)) return false;
  const bearer = value.match(BEARER_OR_BASIC);
  const authorizationProse = bearer &&
    !isPlaceholder(bearer[1]) && AUTHORIZATION_PROSE.test(value) &&
    (AUTHORIZATION_CONCEPT.test(bearer[1]) ||
      (bearer[1].toLowerCase() === "token" && isConceptualProse(value)));
  return TOKEN_PREFIX.test(value) ||
    (bearer && !isPlaceholder(bearer[1]) &&
      !authorizationProse) ||
    PRIVATE_KEY.test(value) ||
    PGP_PRIVATE_KEY.test(value) ||
    SSH_PUBLIC_KEY.test(value) ||
    looksLikeAssignmentSecret(value) ||
    JWT.test(value) ||
    USERINFO.test(value) ||
    ENCODED_USERINFO.test(value) ||
    sensitiveQueryValue(value);
}

function looksLikeAssignmentSecret(value) {
  const assignment = value.match(ASSIGNMENT_SECRET);
  return assignment !== null && !isPlaceholder(assignment[1]);
}

function looksLikeCapabilityReference(value) {
  if (isPlaceholder(value)) return false;
  if (/^(?:cap|capability|credential|cred|secret|vault|drovr|herdr):/i.test(value)) {
    return true;
  }
  return /\b(?:capability|credential|secret|token)[-_ ]?(?:ref|reference|envelope)\b/i.test(value) &&
    /[:#/]/.test(value);
}

function sensitiveQueryValue(value) {
  const match = value.match(/[?&]([^=&#\s]+)=([^&#\s]*)/g);
  if (!match) return false;
  return match.some((entry) => {
    const [key, queryValue = ""] = entry.slice(1).split("=");
    return (SENSITIVE_QUERY_KEY.test(key) ||
      isSensitiveKey(key) ||
      NORMALIZED_SENSITIVE_QUERY_KEY.test(normalizeSemanticKey(key))) &&
      queryValue.length > 0 &&
      !isPlaceholder(queryValue);
  });
}

function inspectImmutableUrlMetadata(
  value,
  { checkRawPercent = true, state = null } = {},
) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !IMMUTABLE_SHA.test(url.pathname)) {
    return null;
  }
  if (checkRawPercent && hasMalformedRawUrlMetadata(value)) {
    return "malformed_encoding";
  }
  if (state) {
    const metadataIdentity = `${url.origin}${url.pathname}?${url.searchParams.toString()}${normalizedUrlFragment(url)}`;
    if (state.inspectedUriMetadata.has(metadataIdentity)) return null;
    state.inspectedUriMetadata.add(metadataIdentity);
  }

  for (const [key, queryValue] of url.searchParams.entries()) {
    const issue = state
      ? scanUrlMetadataValue(queryValue, state, key)
      : classifyUrlMetadataPart(key, queryValue, { inspectUrlMetadata: false });
    if (issue) return issue;
  }
  if (url.hash.length > 1) {
    let fragment;
    try {
      fragment = decodeURIComponent(url.hash.slice(1));
    } catch {
      if (checkRawPercent) return "malformed_encoding";
      fragment = url.hash.slice(1);
    }
    for (const part of fragment.split("&")) {
      const separator = part.indexOf("=");
      const key = separator < 0 ? "" : part.slice(0, separator);
      const partValue = separator < 0 ? part : part.slice(separator + 1);
      const issue = state
        ? scanUrlMetadataValue(partValue, state, key)
        : classifyUrlMetadataPart(key, partValue, {
          inspectUrlMetadata: false,
        });
      if (issue) return issue;
    }
  }
  return null;
}

function scanUrlMetadataValue(value, state, key) {
  if (typeof value !== "string") return null;
  let candidate = value;
  for (let layer = 0;
    layer <= EVIDENCE_SAFETY_LIMITS.max_encoded_layers;
    layer += 1) {
    const explicitBase64 = decodeExplicitBase64(candidate);
    if (explicitBase64.present && explicitBase64.decoded === null) {
      return "malformed_encoding";
    }
    const nested = parseNestedStructuredString(candidate);
    if (nested === "duplicate_keys") return "non_canonical_input";
    if (nested === "too_deep") return "evidence_too_deep";
    if (nested === "too_large") return "evidence_too_large";
    if (nested === "malformed") return "malformed_encoding";

    const issue = classifyUrlMetadataPart(key, candidate, {
      inspectUrlMetadata: false,
      structuredValue: nested !== null && typeof nested === "object",
    });
    if (issue) return issue;

    if (nested !== null) {
      state.nestedStructuredStrings += 1;
      if (state.nestedStructuredStrings >
          EVIDENCE_SAFETY_LIMITS.max_nested_structured_strings) {
        return "evidence_too_large";
      }
      const nestedIssue = scanValue(nested, state, key);
      if (nestedIssue) return nestedIssue;
    }

    const decoded = nextEncodedValue(candidate, {
      base64MinimumLength: layer > 0 ? 4 : 8,
    });
    if (decoded === null || decoded === candidate) return null;
    if (layer === EVIDENCE_SAFETY_LIMITS.max_encoded_layers) {
      return "ambiguous_normalization";
    }
    const decodedSize = stringByteLength(decoded);
    state.totalStringLength += decodedSize;
    if (decodedSize > EVIDENCE_SAFETY_LIMITS.max_string_length ||
        state.totalStringLength > EVIDENCE_SAFETY_LIMITS.max_total_string_length) {
      return "evidence_too_large";
    }
    candidate = decoded;
  }
  return "ambiguous_normalization";
}

function hasMalformedRawUrlMetadata(value) {
  const queryStart = value.indexOf("?");
  const fragmentStart = value.indexOf("#");
  const query = queryStart < 0
    ? ""
    : value.slice(queryStart + 1, fragmentStart < 0 ? value.length : fragmentStart);
  const fragment = fragmentStart < 0 ? "" : value.slice(fragmentStart + 1);
  return hasMalformedRawPercent(query) || hasMalformedRawPercent(fragment);
}

function hasMalformedRawPercent(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") continue;
    if (!/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      return true;
    }
    index += 2;
  }
  return false;
}

function inspectEmbeddedImmutableUrlMetadata(
  value,
  { checkRawPercent = true, state = null } = {},
) {
  if (typeof value !== "string") return null;
  if (isImmutableSourceUri(value)) return null;
  for (const match of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi)) {
    const embeddedUri = match[0];
    if (embeddedUri === value.trim()) continue;
    const issue = inspectImmutableUrlMetadata(embeddedUri, {
      checkRawPercent,
      state,
    });
    if (issue) return issue;
  }
  return null;
}

function isImmutableSourceUri(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && IMMUTABLE_SHA.test(url.pathname);
  } catch {
    return false;
  }
}

function normalizedUrlFragment(url) {
  if (!url.hash) return "";
  const rawFragment = url.hash.slice(1);
  try {
    return `#${encodeURIComponent(decodeURIComponent(rawFragment))}`;
  } catch {
    return `#${rawFragment}`;
  }
}

function classifyUrlMetadataPart(
  key,
  value,
  { inspectUrlMetadata = true, structuredValue = false } = {},
) {
  if (looksLikeMalformedPercentEncoding(key) ||
      looksLikeMalformedPercentEncoding(value)) {
    return "malformed_encoding";
  }
  if (isSensitiveQueryKey(key) && !isPlaceholderValue(value) &&
      !isConceptualProse(value)) {
    return "credential_material";
  }
  if (isCapabilityKey(key) && !isPlaceholderValue(value) &&
      !isConceptualProse(value)) {
    return "capability_reference";
  }
  if (structuredValue) return null;
  if (looksLikeCapabilityReference(value)) return "capability_reference";
  if (AMBIENT_KEY.test(key) && !isPlaceholderValue(value) &&
      !isConceptualProse(value) && isPathLike(value, false)) {
    return "ambient_filesystem_path";
  }
  if (looksLikeCredential(value)) return "credential_material";
  if (!key && looksLikeMetadataAmbientPath(value)) {
    return "ambient_filesystem_path";
  }
  if (isPathLike(value, inspectUrlMetadata)) {
    return "ambient_filesystem_path";
  }
  return null;
}

function looksLikeMetadataAmbientPath(value) {
  return /(?:^|[^A-Za-z0-9])\/{1,}[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/.test(value) ||
    /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/][^\s]+/i.test(value) ||
    /(?:^|[^A-Za-z0-9])\\\\[^\s]+/.test(value);
}

function isSensitiveQueryKey(key) {
  return SENSITIVE_QUERY_KEY.test(key) || isSensitiveKey(key) ||
    NORMALIZED_SENSITIVE_QUERY_KEY.test(normalizeSemanticKey(key));
}

function isPathLike(value, inspectUrlMetadata = true) {
  if (typeof value !== "string" || isPlaceholder(value)) return false;
  const trimmed = value.trim();
  if (/^(?:[a-z]:[\\/]|[a-z]:[^\\/\s]+[\\/]|\\[^\s]|\\\\|\/{2,}(?:[^/]|$)|\/\/[^/]|\/(?:[^/]|$)|~[\\/])/i.test(trimmed)) {
    return true;
  }
  if (/(?:^|[\\/])(?:\.\.?)(?:[\\/]|$)/.test(trimmed)) return true;
  const embeddedUri = trimmed.match(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/i)?.[0];
  let hasEmbeddedUri = false;
  if (embeddedUri && embeddedUri !== trimmed) {
    hasEmbeddedUri = true;
    if (isPathLike(embeddedUri, inspectUrlMetadata)) return true;
  }
  if (embeddedAmbientPath(trimmed)) return true;
  if (hasEmbeddedUri) return false;
  const singleSlashScheme = trimmed.match(/^([a-z][a-z0-9+.-]*):(?:\/|$)/i)?.[1]
    ?.toLowerCase();
  if (singleSlashScheme && !trimmed.includes("://")) return true;
  const scheme = trimmed.match(URI_SCHEME)?.[1]?.toLowerCase();
  if (!scheme) return false;
  if (["file", "ssh", "sftp", "scp", "smb", "nfs", "unix", "pipe", "vscode", "docker"].includes(scheme)) {
    return true;
  }
  if (!["http", "https"].includes(scheme)) return true;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password || sensitiveQueryValue(value)) return true;
    if (LOCAL_HOST.test(url.hostname) || isPrivateHost(url.hostname)) return true;
    if (/(?:^|\/)\.\.(?:\/|$)/.test(url.pathname)) return true;
    if (url.protocol === "https:" && IMMUTABLE_SHA.test(url.pathname)) {
      return inspectUrlMetadata
        ? inspectImmutableUrlMetadata(trimmed) !== null
        : false;
    }
    return true;
  } catch {
    return true;
  }
}

function embeddedAmbientPath(value) {
  const delimiter = `[\\s(\"'\`=,;#?]`;
  const pathDelimiter = `[\\s(\"'\`=,;#?:]`;
  return new RegExp(`(?:^|${delimiter})\\/{2,}[A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+)*`).test(value) ||
    new RegExp(`(?:^|${pathDelimiter})\\/[A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+)*`).test(value) ||
    new RegExp(`(?:^|${pathDelimiter})[A-Za-z]:[\\\\/][^\\s,;)'\`]+`, "i").test(value) ||
    new RegExp(`(?:^|${pathDelimiter})[A-Za-z]:[^\\\\/\\s]+[\\\\/][^\\s,;)'\`]+`, "i").test(value) ||
    new RegExp(`(?:^|${pathDelimiter})\\\\(?!u[0-9a-fA-F]{4})[^\\s,;)'\`]+`).test(value) ||
    new RegExp(`(?:^|${pathDelimiter})\\\\\\\\[^\\s,;)'\`]+`).test(value) ||
    new RegExp(`(?:^|${pathDelimiter})~[\\\\/][^\\s,;)'\`]+`).test(value) ||
    new RegExp(`(?:^|${pathDelimiter})(?:\\$PWD|\\$\\{PWD\\})(?:[\\\\/][^\\s,;)'\`]+|$)`, "i").test(value) ||
    new RegExp(`(?:^|${pathDelimiter})(?:\\.\\.?[\\\\/])\\S+`).test(value) ||
    new RegExp(`(?:^|${pathDelimiter})\\S+[\\\\/]\\.\\.(?:[\\\\/]|$)`).test(value);
}

function isPrivateHost(hostname) {
  const normalized = hostname.toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  if (isPrivateIpv4(normalized)) return true;
  if (normalized === "localhost" || normalized === "localhost.localdomain") {
    return true;
  }
  if (normalized === "::" || normalized === "::1" ||
      /^f[cd][0-9a-f]*:/.test(normalized) ||
      /^fe[89abcdef][0-9a-f]*:/.test(normalized)) {
    return true;
  }
  const compatible = normalized.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (compatible) {
    const first = Number.parseInt(compatible[1], 16);
    const second = Number.parseInt(compatible[2], 16);
    return isPrivateIpv4([
      first >>> 8,
      first & 0xff,
      second >>> 8,
      second & 0xff,
    ].join("."));
  }
  return normalized.endsWith(".local") || normalized.endsWith(".internal");
}

function isPrivateIpv4(hostname) {
  return /^0\.|^10\.|^127\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname);
}

function looksLikeMalformedPercentEncoding(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") continue;
    const suffix = value.slice(index + 1, index + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(suffix)) {
      index += 2;
      continue;
    }
    if (suffix.length > 0 && !/\s/u.test(suffix[0])) {
      return true;
    }
  }
  return false;
}

function looksLikeMalformedEncoding(value, keyName) {
  if (typeof keyName !== "string" || keyName === "input" ||
      !/(?:base64|encoded|encoding)/i.test(keyName) || isPlaceholder(value)) {
    return false;
  }
  if (/^base64:/i.test(value)) {
    return decodeExplicitBase64(value).decoded === null;
  }
  if (/%[0-9A-Fa-f]{2}/.test(value)) return false;
  if (value.length < 4) {
    return true;
  }
  return /[^A-Za-z0-9+/_=-]/.test(value) ||
    value.length % 4 === 1 ||
    decodeBoundedBase64(value, { minimumLength: 4 }) === null;
}

function decodeExplicitBase64(value) {
  if (!/^base64:/i.test(value)) return { present: false, decoded: null };
  return {
    present: true,
    decoded: decodeBoundedBase64(value.slice("base64:".length), {
      minimumLength: 1,
    }),
  };
}

function decodePercentOnce(value) {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) {
    return { decoded: value, malformed: false };
  }
  try {
    return { decoded: decodeURIComponent(value), malformed: false };
  } catch {
    return { decoded: null, malformed: true };
  }
}

function decodeBoundedBase64(value, { minimumLength = 8 } = {}) {
  if (typeof value !== "string" || value.length < minimumLength) return null;

  const hasStandardAlphabet = /[+/]/.test(value);
  const hasUrlAlphabet = /[-_]/.test(value);
  if (hasStandardAlphabet && hasUrlAlphabet) return null;

  let normalized = value;
  let expectedRoundTrip;
  if (hasStandardAlphabet || value.includes("=")) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
      return null;
    }
    expectedRoundTrip = value;
  } else {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
      return null;
    }
    normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    expectedRoundTrip = value;
  }

  if (normalized.length % 4 !== 0) {
    normalized += "=".repeat((4 - (normalized.length % 4)) % 4);
  }
  try {
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.length === 0 || bytes.length > EVIDENCE_SAFETY_LIMITS.max_string_length) {
      return null;
    }
    const roundTrip = bytes.toString("base64");
    const canonicalRoundTrip = hasStandardAlphabet || value.includes("=")
      ? roundTrip
      : roundTrip.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
    if (canonicalRoundTrip !== expectedRoundTrip) return null;
    const decoded = bytes.toString("utf8");
    if (Buffer.from(decoded, "utf8").compare(bytes) !== 0 ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function parseNestedStructuredString(value) {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  const scan = scanJsonStructure(trimmed);
  if (scan !== null) return scan;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return "malformed";
  }
}

function scanJsonStructure(text) {
  let index = 0;
  let nodes = 0;

  function skipWhitespace() {
    while (index < text.length && /\s/u.test(text[index])) index += 1;
  }

  function readString() {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return { ok: true, value: JSON.parse(text.slice(start, index)) };
        } catch {
          return { ok: false };
        }
      }
      if (character === "\\") {
        index += 1;
        if (index >= text.length) return { ok: false };
        if (text[index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(index + 1, index + 5))) {
            return { ok: false };
          }
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/u.test(text[index])) return { ok: false };
        index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) return { ok: false };
      index += 1;
    }
    return { ok: false };
  }

  function parseValue(depth) {
    nodes += 1;
    if (nodes > EVIDENCE_SAFETY_LIMITS.max_nodes) return "too_large";
    if (depth > EVIDENCE_SAFETY_LIMITS.max_depth) return "too_deep";
    skipWhitespace();
    const character = text[index];
    if (character === "{") return parseObject(depth);
    if (character === "[") return parseArray(depth);
    if (character === '"') return readString().ok ? null : "malformed";
    if (text.startsWith("true", index)) {
      index += 4;
      return null;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return null;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    const number = text.slice(index).match(
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u,
    );
    if (!number) return "malformed";
    index += number[0].length;
    return null;
  }

  function parseObject(depth) {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[index] === "}") {
      index += 1;
      return null;
    }
    while (index < text.length) {
      if (text[index] !== '"') return "malformed";
      const key = readString();
      if (!key.ok) return "malformed";
      if (keys.has(key.value)) return "duplicate_keys";
      keys.add(key.value);
      skipWhitespace();
      if (text[index] !== ":") return "malformed";
      index += 1;
      const issue = parseValue(depth + 1);
      if (issue) return issue;
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return null;
      }
      if (text[index] !== ",") return "malformed";
      index += 1;
      skipWhitespace();
      if (text[index] === "}") return "malformed";
    }
    return "malformed";
  }

  function parseArray(depth) {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return null;
    }
    while (index < text.length) {
      const issue = parseValue(depth + 1);
      if (issue) return issue;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return null;
      }
      if (text[index] !== ",") return "malformed";
      index += 1;
      skipWhitespace();
      if (text[index] === "]") return "malformed";
    }
    return "malformed";
  }

  const issue = parseValue(0);
  if (issue) return issue;
  skipWhitespace();
  return index === text.length ? null : "malformed";
}

function isPlaceholder(value) {
  return typeof value === "string" && PLACEHOLDER.test(value.trim());
}

function stringByteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function isPlaceholderValue(value) {
  return value === null || value === false || isPlaceholder(value);
}

function prepareBindingArguments(receiptOrRequest, context) {
  if (!isPlainRecord(receiptOrRequest)) {
    return { invalidContext: "invalid_receipt_shape" };
  }
  const contextValue = context === undefined ? {} : context;
  if (!isPlainRecord(contextValue)) {
    return { invalidContext: "invalid_binding_context" };
  }

  const receiptIssue = validateDataProperties(receiptOrRequest);
  if (receiptIssue) return { invalidContext: receiptIssue };
  const contextIssue = validateDataProperties(contextValue);
  if (contextIssue) return { invalidContext: contextIssue };

  let envelopeSnapshot;
  let contextSnapshot;
  try {
    envelopeSnapshot = freezeCanonical(receiptOrRequest);
    contextSnapshot = freezeCanonical(contextValue);
  } catch (error) {
    return { invalidContext: canonicalFailure(error) };
  }

  const wrapper = Object.hasOwn(envelopeSnapshot, "receipt");
  const allowedWrapperKeys = ["receipt", "boundary", "subject_digest"];
  const allowedContextKeys = ["boundary", "subject_digest"];
  if ((wrapper && !hasOnlyKeys(envelopeSnapshot, allowedWrapperKeys)) ||
      !hasOnlyKeys(contextSnapshot, allowedContextKeys)) {
    return { invalidContext: "invalid_binding_context" };
  }
  if (wrapper && conflictingOwnValue(
    envelopeSnapshot,
    contextSnapshot,
    "boundary",
  )) {
    return { invalidContext: "invalid_binding_context" };
  }
  if (wrapper && conflictingOwnValue(
    envelopeSnapshot,
    contextSnapshot,
    "subject_digest",
  )) {
    return { invalidContext: "invalid_binding_context" };
  }

  let receipt = envelopeSnapshot;
  let boundary = contextSnapshot.boundary;
  let subjectDigest = contextSnapshot.subject_digest ?? null;
  if (wrapper) {
    receipt = envelopeSnapshot.receipt;
    boundary = envelopeSnapshot.boundary ?? boundary;
    subjectDigest = envelopeSnapshot.subject_digest ?? subjectDigest;
  }
  return { receipt, boundary, subjectDigest, wrapper };
}

function conflictingOwnValue(left, right, key) {
  return Object.hasOwn(left, key) && Object.hasOwn(right, key) &&
    left[key] !== right[key];
}

function validateReceipt(receipt) {
  if (!isPlainRecord(receipt) || !hasExactKeys(receipt, RECEIPT_FIELDS)) {
    return "invalid_receipt_shape";
  }
  if (receipt.schema !== EVIDENCE_SAFETY_RECEIPT_SCHEMA ||
      receipt.policy_id !== EVIDENCE_SAFETY_POLICY_ID ||
      receipt.catalog_id !== EVIDENCE_SAFETY_CATALOG_ID ||
      !EVIDENCE_SAFETY_CLASSIFICATIONS.includes(receipt.classification) ||
      !isDigest(receipt.input_digest) || !isDigest(receipt.receipt_digest) ||
      !isDigest(receipt.self_digest)) {
    return "invalid_receipt_identity";
  }
  let allowedUse;
  try {
    allowedUse = normalizeAllowedUses(receipt.allowed_use);
  } catch {
    return "invalid_receipt_allowed_use";
  }
  if (digest({
    schema: receipt.schema,
    policy_id: receipt.policy_id,
    catalog_id: receipt.catalog_id,
    classification: receipt.classification,
    allowed_use: allowedUse,
    input_digest: receipt.input_digest,
  }) !== receipt.receipt_digest || receipt.receipt_digest !== receipt.self_digest) {
    return "receipt_digest_mismatch";
  }
  return null;
}

function rejected(code, operation = "validate") {
  return {
    accepted: false,
    rejection: freezeCanonical({
      schema: EVIDENCE_SAFETY_REJECTION_SCHEMA,
      operation,
      code,
      reason: code,
      redacted: true,
    }),
  };
}

function canonicalFailure(error) {
  if (error instanceof CanonicalValueError) {
    if ([
      "evidence_too_deep",
      "evidence_too_large",
      "non_canonical_input",
      "cyclic_input",
    ].includes(error.reason)) {
      return error.reason;
    }
    return error.reason === "cyclic_canonical_value"
      ? "cyclic_input"
      : "non_canonical_input";
  }
  return "invalid_input";
}

function hasExactKeys(value, expected) {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length && expected.every((key) =>
      keys.includes(key));
  } catch {
    return false;
  }
}

function hasOnlyKeys(value, allowed) {
  try {
    return Reflect.ownKeys(value).every((key) =>
      typeof key === "string" && allowed.includes(key));
  } catch {
    return false;
  }
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
