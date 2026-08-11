import assert from "node:assert/strict";
import test from "node:test";

import { CanonicalValueError, digest } from "../src/canonical.mjs";
import {
  EVIDENCE_SAFETY_CATALOG_ID,
  EVIDENCE_SAFETY_LIMITS,
  EVIDENCE_SAFETY_POLICY_ID,
  bindArtifactAcceptanceReceipt,
  bindDelegateEvidenceReceipt,
  bindEvidenceReceipt,
  bindResourceHandoffReceipt,
  createEvidenceSafetyRequest,
  getEvidenceSafetyCatalog,
  validateEvidenceSafety,
} from "../src/evidence-safety.mjs";

const baseRequest = {
  schema: "flow.evidence-safety-request/v1",
  policy_id: EVIDENCE_SAFETY_POLICY_ID,
  catalog_id: EVIDENCE_SAFETY_CATALOG_ID,
  classification: "research",
  allowed_use: [
    "delegate_transfer",
    "artifact_acceptance",
    "resource_handoff_publication",
  ],
  input_digest: "sha256:2552feacf71d906f5e65729cde650fc36a28da0bda3acdfc5544783c6eb1a3b7",
  input: {
    title: "Evidence safety contract research",
    summary: "A bounded note about canonical evidence.",
  },
};

const fixtureTokenSuffix = ["1234567890", "abcdef"].join("");
const fixtureGithubToken = () => ["gh", "p_", fixtureTokenSuffix].join("");
const fixtureGithubLeak = () => [
  "gh",
  "p_",
  "super_secret_value_that_must_not_be_returned",
].join("");
const fixtureContextSecret = () => [
  "gh",
  "p_",
  "context_secret_must_not_escape",
].join("");
const fixtureEncodedGithubToken = () => ["%67%68%70_", fixtureTokenSuffix].join("");
const fixtureDoubleEncodedGithubToken = () =>
  fixtureEncodedGithubToken().replaceAll("%", "%25");
const fixtureServiceToken = (kind, environment) => [
  kind,
  "_",
  environment,
  "_1234567890abcdefghijklmnop",
].join("");
const fixturePattern = (value) =>
  new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

test("the public validator returns a deterministic digest-bound receipt", () => {
  const result = validateEvidenceSafety(baseRequest);

  assert.equal(result.accepted, true);
  assert.equal(result.receipt.schema, "flow.evidence-safety-receipt/v1");
  assert.equal(result.receipt.input_digest, baseRequest.input_digest);
  assert.equal(result.receipt.policy_id, EVIDENCE_SAFETY_POLICY_ID);
  assert.equal(result.receipt.catalog_id, EVIDENCE_SAFETY_CATALOG_ID);
  assert.match(result.receipt.receipt_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.receipt.receipt_digest, result.receipt.self_digest);
});

test("the request factory emits the exact digest-bound public shape", () => {
  const request = createEvidenceSafetyRequest({
    classification: "research",
    allowed_use: [
      "resource_handoff_publication",
      "delegate_transfer",
      "artifact_acceptance",
    ],
    input: baseRequest.input,
  });
  assert.deepEqual(request, baseRequest);
  assert.equal(validateEvidenceSafety(request).accepted, true);
});

test("the request factory bounds input before digesting or freezing it", () => {
  let tooDeep = { leaf: "safe" };
  for (let index = 0; index < EVIDENCE_SAFETY_LIMITS.max_depth + 2; index += 1) {
    tooDeep = { nested: tooDeep };
  }
  assert.throws(
    () => createEvidenceSafetyRequest({
      classification: "research",
      allowed_use: ["delegate_transfer"],
      input: tooDeep,
    }),
    (error) => error instanceof CanonicalValueError &&
      error.reason === "evidence_too_deep",
  );

  assert.throws(
    () => createEvidenceSafetyRequest({
      classification: "research",
      allowed_use: ["delegate_transfer"],
      input: { note: "x".repeat(EVIDENCE_SAFETY_LIMITS.max_string_length + 1) },
    }),
    (error) => error instanceof CanonicalValueError &&
      error.reason === "evidence_too_large",
  );
});

test("request factory preflights its options container before reading fields", () => {
  let reads = 0;
  const options = {
    classification: "research",
    allowed_use: ["delegate_transfer"],
    input: { note: "safe" },
  };
  Object.defineProperty(options, "input", {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      throw new Error("credential option getter must not run");
    },
  });

  assert.throws(
    () => createEvidenceSafetyRequest(options),
    (error) => error instanceof CanonicalValueError &&
      error.reason === "non_canonical_input",
  );
  assert.equal(reads, 0);
});

test("the catalog view exposes the public policy and redaction boundary", () => {
  const catalog = getEvidenceSafetyCatalog();
  assert.equal(catalog.schema, "flow.evidence-safety-catalog/v1");
  assert.equal(catalog.policy_id, EVIDENCE_SAFETY_POLICY_ID);
  assert.equal(catalog.catalog_id, EVIDENCE_SAFETY_CATALOG_ID);
  assert.deepEqual(catalog.allowed_uses, [
    "delegate_transfer",
    "artifact_acceptance",
    "resource_handoff_publication",
  ]);
  assert.deepEqual(catalog.prohibited_inputs, [
    "credential_material",
    "capability_reference_or_envelope",
    "ambient_filesystem_path",
    "ambiguous_or_malformed_encoding",
  ]);
  assert.equal(catalog.rejection.redaction, "no_rejected_input_bytes_or_fragments");
  assert(Object.isFrozen(catalog));
});

test("canonical-equivalent input objects produce the same receipt", () => {
  const reordered = {
    ...baseRequest,
    input: {
      summary: baseRequest.input.summary,
      title: baseRequest.input.title,
    },
  };

  assert.deepEqual(
    validateEvidenceSafety(baseRequest),
    validateEvidenceSafety(reordered),
  );
});

test("canonical-equivalent unsafe objects produce the same rejection", () => {
  const firstInput = {
    path: "/tmp/private-evidence.json",
    token: fixtureGithubToken(),
  };
  const reversedInput = {
    token: fixtureGithubToken(),
    path: "/tmp/private-evidence.json",
  };
  const firstRequest = {
    ...baseRequest,
    input: firstInput,
    input_digest: digest(firstInput),
  };
  const reversedRequest = {
    ...baseRequest,
    input: reversedInput,
    input_digest: digest(reversedInput),
  };

  assert.equal(firstRequest.input_digest, reversedRequest.input_digest);
  assert.deepEqual(
    validateEvidenceSafety(firstRequest),
    validateEvidenceSafety(reversedRequest),
  );
});

test("digest mismatch is a typed redacted rejection", () => {
  const result = validateEvidenceSafety({
    ...baseRequest,
    input_digest: `sha256:${"0".repeat(64)}`,
    input: {
      note: `Bearer ${fixtureGithubLeak()}`,
    },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.rejection.schema, "flow.evidence-safety-rejection/v1");
  assert.equal(result.rejection.code, "input_digest_mismatch");
  assert.equal(result.rejection.redacted, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    fixturePattern(fixtureGithubLeak()),
  );
});

test("extra request fields are rejected without echoing request bytes", () => {
  const result = validateEvidenceSafety({
    ...baseRequest,
    unexpected: "credential=do-not-echo-this",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, "invalid_request_shape");
  assert.doesNotMatch(JSON.stringify(result), /do-not-echo-this/);
});

test("request fields must be enumerable own data properties", () => {
  const request = { ...baseRequest };
  Object.defineProperty(request, "input", {
    configurable: true,
    enumerable: false,
    value: baseRequest.input,
    writable: true,
  });

  const result = validateEvidenceSafety(request);
  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, "non_canonical_input");
});

test("accessor-backed requests and input are rejected before reading values", () => {
  const literalSecret = { note: fixtureGithubToken() };
  const request = requestFor(literalSecret);
  let inputReads = 0;
  Object.defineProperty(request.input, "note", {
    configurable: true,
    enumerable: true,
    get() {
      inputReads += 1;
      return inputReads === 1
        ? fixtureGithubToken()
        : "Research prose is safe.";
    },
  });

  const inputResult = validateEvidenceSafety(request);
  assert.equal(inputResult.accepted, false);
  assert.equal(inputResult.rejection.code, "non_canonical_input");
  assert.equal(inputReads, 0);
  assert.doesNotMatch(JSON.stringify(inputResult), fixturePattern(fixtureGithubToken()));

  const requestWithGetter = requestFor({ note: "Research prose is safe." });
  const literalDigest = requestWithGetter.input_digest;
  let requestReads = 0;
  Object.defineProperty(requestWithGetter, "input_digest", {
    configurable: true,
    enumerable: true,
    get() {
      requestReads += 1;
      return literalDigest;
    },
  });
  const requestResult = validateEvidenceSafety(requestWithGetter);
  assert.equal(requestResult.accepted, false);
  assert.equal(requestResult.rejection.code, "non_canonical_input");
  assert.equal(requestReads, 0);
});

function requestFor(input, overrides = {}) {
  return {
    ...baseRequest,
    ...overrides,
    input,
    input_digest: digest(input),
  };
}

test("actual credentials are rejected through nested keys, values, and encodings", () => {
  const cases = [
    { auth: { token: fixtureGithubToken() } },
    { note: "Authorization: Bearer abcdefghijklmnop" },
    { note: "https://user:password@example.test/source" },
    { note: "https://example.test/source?access_token=abcdefghijklmnop" },
    { key: "-----BEGIN PRIVATE KEY-----" },
    { key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
    { nested: '{"password":"not-a-placeholder"}' },
    { encoded: fixtureEncodedGithubToken() },
    { encoded: fixtureDoubleEncodedGithubToken() },
    { encoded: Buffer.from(fixtureGithubToken()).toString("base64") },
  ];

  for (const input of cases) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, "credential_material");
    assert.doesNotMatch(JSON.stringify(result), /1234567890abcdef|password/);
  }
});

test("capability references and envelopes are rejected while conceptual prose is accepted", () => {
  const rejected = [
    { capability_ref: "capability://flow/run/123" },
    { credential_reference: "vault://prod/flow-token" },
    { capability: { envelope: "grant:flow.write" } },
  ];
  for (const input of rejected) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, "capability_reference");
  }

  const prose = validateEvidenceSafety(requestFor({
    note: "Research discusses capability references and credential envelopes as concepts.",
  }));
  assert.equal(prose.accepted, true);

  const conceptualCapability = validateEvidenceSafety(requestFor({
    capability: "A capability is a bounded authority object.",
  }));
  assert.equal(conceptualCapability.accepted, true);

  const envelope = validateEvidenceSafety(requestFor({
    capability: { type: "write" },
  }));
  assert.equal(envelope.accepted, false);
  assert.equal(envelope.rejection.code, "capability_reference");
});

test("ambient paths are rejected recursively while conceptual prose and immutable public sources remain accepted", () => {
  const rejected = [
    { path: "/var/lib/flow/evidence.json" },
    { nested: { windows: "C:\\Users\\operator\\secret.txt" } },
    { nested: { unc: "\\\\server\\share\\evidence.json" } },
    { nested: { traversal: "../outside/evidence" } },
    { nested: { drive_relative: "C:foo\\bar" } },
    { nested: { root_relative: "\\foo\\bar" } },
    { nested: { encoded: "%2Fetc%2Fpasswd" } },
    { nested: { local: "file:///tmp/evidence.json" } },
    { nested: { local: "file:/tmp/evidence.json" } },
    { nested: { local: "https://127.0.0.1:8080/state" } },
    { nested: { mutable: "https://example.test/latest/evidence.json" } },
    { note: "Evidence came from C:foo\\bar before transfer." },
    { note: "Evidence came from \\foo\\bar before transfer." },
    { note: "Evidence came from ///etc/passwd before transfer." },
    { note: "Evidence mentions //https://example.test/source before transfer." },
    { nested: { encoded: "%2F%2F%2Fetc%2Fpasswd" } },
  ];
  for (const input of rejected) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, "ambient_filesystem_path");
  }

  const accepted = validateEvidenceSafety(requestFor({
    note: "A path is discussed conceptually; no host path is supplied. 100% prose is allowed.",
    source_uri: "https://github.com/Seavenly/dotfiles/blob/8fa9d02504a18b4a01d015403b47c097fc99e5f3/README.md",
  }));
  assert.equal(accepted.accepted, true);
});

test("structured conceptual research remains usable while material-bearing keys stay guarded", () => {
  const conceptual = validateEvidenceSafety(requestFor({
    credentials: "Research about credentials and authentication.",
    capabilities: "Research about capability models.",
    path: "Research about path normalization.",
    authority: "Research about authority and lifecycle vocabulary.",
  }));
  assert.equal(conceptual.accepted, true);

  const actual = [
    { credentials: fixtureGithubToken() },
    { credentials: { value: "opaque-secret-material" } },
    { capabilities: "capability://flow/run/123" },
    { capabilities: { id: "opaque-capability-id" } },
    { path: "/tmp/evidence.json" },
  ];
  for (const input of actual) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
  }
});

test("independent one-layer encoded strings do not consume one shared normalization budget", () => {
  const result = validateEvidenceSafety(requestFor({
    encoded: ["%65vidence", "%65vidence", "%65vidence", "%65vidence"],
  }));
  assert.equal(result.accepted, true);
});

test("mixed encoded transformations are recursively classified", () => {
  const result = validateEvidenceSafety(requestFor({
    payload: "JTJGZXRjJTJGcGFzc3dk",
  }));
  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, "ambient_filesystem_path");
});

test("a short base64 layer is decoded after an explicit percent transform", () => {
  const result = validateEvidenceSafety(requestFor({
    payload: "%4c%33%52%74%63%43%39%68",
  }));
  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, "ambient_filesystem_path");
});

test("ambient paths embedded in research prose remain prohibited", () => {
  for (const note of [
    "Evidence was read from /home/operator/private/report.md before transfer.",
    "The temporary evidence was kept in /tmp before transfer.",
    "source=/etc/passwd",
    "source=C:\\Users\\operator\\secret.txt",
    "source=../outside/evidence",
    "source=%2Fetc%2Fpasswd",
    "source,#/etc/passwd",
    "Evidence source:/etc/passwd before transfer.",
    "path:C:\\Users\\op\\secret.txt",
    "source:../outside",
  ]) {
    const result = validateEvidenceSafety(requestFor({ note }));
    assert.equal(result.accepted, false);
    assert.equal(result.rejection.code, "ambient_filesystem_path");
  }
});

test("private and local aliases in immutable URI hosts remain ambient", () => {
  const sha = "a".repeat(40);
  for (const host of [
    "[fc00::1]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]",
    "[fec0::1]",
    "[::127.0.0.1]",
    "localhost.",
    "localhost.localdomain",
  ]) {
    const result = validateEvidenceSafety(requestFor({
      source_uri: `https://${host}/commit/${sha}`,
    }));
    assert.equal(result.accepted, false, host);
    assert.equal(result.rejection.code, "ambient_filesystem_path", host);
  }
});

test("repeated leading POSIX slashes remain ambient paths", () => {
  for (const input of [
    { path: "///etc/passwd" },
    { note: "Evidence was read from ///etc/passwd before transfer." },
  ]) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, "ambient_filesystem_path");
  }
});

test("immutable source URI metadata is classified independently of its pinned path", () => {
  const immutable = "https://github.com/Seavenly/dotfiles/commit/8fa9d02504a18b4a01d015403b47c097fc99e5f3";
  for (const [suffix, code] of [
    ["?path=%2Fetc%2Fpasswd", "ambient_filesystem_path"],
    ["?authority_envelope=repository%3Awrite", "capability_reference"],
    ["?signature=opaque", "credential_material"],
    ["#%2Fetc%2Fpasswd", "ambient_filesystem_path"],
    ["#authority_envelope=repository%3Awrite", "capability_reference"],
    ["#signature=opaque", "credential_material"],
  ]) {
    const result = validateEvidenceSafety(requestFor({
      source_uri: `${immutable}${suffix}`,
    }));
    assert.equal(result.accepted, false, suffix);
    assert.equal(result.rejection.code, code, suffix);
  }

  for (const source_uri of [
    `${immutable}?line=42#L10-L20`,
    `${immutable}#section-2`,
  ]) {
    assert.equal(validateEvidenceSafety(requestFor({ source_uri })).accepted, true);
  }
});

test("embedded immutable source URI metadata uses the same safety policy", () => {
  const immutable = "https://github.com/Seavenly/dotfiles/commit/8fa9d02504a18b4a01d015403b47c097fc99e5f3";
  for (const [suffix, code] of [
    ["?path=%2Fetc%2Fpasswd", "ambient_filesystem_path"],
    ["?authority_envelope=repository%3Awrite", "capability_reference"],
  ]) {
    const result = validateEvidenceSafety(requestFor({
      note: `See ${immutable}${suffix} for evidence.`,
    }));
    assert.equal(result.accepted, false, suffix);
    assert.equal(result.rejection.code, code, suffix);
  }

  for (const note of [
    `See ${immutable}?line=42#L10-L20 for evidence.`,
    `See ${immutable}#section-2 for evidence.`,
  ]) {
    assert.equal(validateEvidenceSafety(requestFor({ note })).accepted, true);
  }
});

test("immutable URI metadata decodes bounded credential, path, and nested forms", () => {
  const immutable = "https://github.com/Seavenly/dotfiles/commit/8fa9d02504a18b4a01d015403b47c097fc99e5f3";
  for (const [query, code] of [
    [`?note=${Buffer.from(fixtureGithubToken()).toString("base64")}`, "credential_material"],
    ["?note=L2V0Yy9wYXNzd2Q=", "ambient_filesystem_path"],
    ["?note=%7B%22capability%22%3A%22capability%3A%2F%2Fflow%2Frun%2F123%22%7D", "capability_reference"],
    ["?note=%7B%22password%22%3A%22opaque-secret%22%7D", "credential_material"],
  ]) {
    const result = validateEvidenceSafety(requestFor({
      source_uri: `${immutable}${query}`,
    }));
    assert.equal(result.accepted, false, query);
    assert.equal(result.rejection.code, code, query);
  }
});

test("safe structured URI metadata is not rescanned or over-counted", () => {
  const immutable = "https://github.com/Seavenly/dotfiles/commit/8fa9d02504a18b4a01d015403b47c097fc99e5f3";
  const structured = validateEvidenceSafety(requestFor({
    source_uri: `${immutable}?note=%7B%22x%22%3A%22y%22%7D`,
  }));
  assert.equal(structured.accepted, true);
  const embeddedStructured = validateEvidenceSafety(requestFor({
    note: `See ${immutable}?note=%7B%22x%22%3A%22y%22%7D for evidence.`,
  }));
  assert.equal(embeddedStructured.accepted, true);

  const query = Array.from({ length: 9 }, (_, index) =>
    `k${index}=%5B1%5D`).join("&");
  const repeatedStructures = validateEvidenceSafety(requestFor({
    source_uri: `${immutable}?${query}`,
  }));
  assert.equal(repeatedStructures.accepted, true);
  const embeddedRepeatedStructures = validateEvidenceSafety(requestFor({
    note: `See ${immutable}?${query} for evidence.`,
  }));
  assert.equal(embeddedRepeatedStructures.accepted, true);
});

test("raw immutable URI metadata percent escapes fail closed", () => {
  const immutable = "https://github.com/Seavenly/dotfiles/commit/8fa9d02504a18b4a01d015403b47c097fc99e5f3";
  for (const suffix of ["?line=%", "#section-%"]) {
    const result = validateEvidenceSafety(requestFor({
      source_uri: `${immutable}${suffix}`,
    }));
    assert.equal(result.accepted, false, suffix);
    assert.equal(result.rejection.code, "malformed_encoding");
  }

  for (const source_uri of [
    `${immutable}?line=%25`,
    `${immutable}#section-%25`,
  ]) {
    assert.equal(validateEvidenceSafety(requestFor({ source_uri })).accepted, true);
  }
});

test("credential material in object keys is classified like credential values", () => {
  for (const input of [
    { [fixtureGithubToken()]: "research label" },
    { [fixtureEncodedGithubToken()]: "research label" },
  ]) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, "credential_material");
    assert.doesNotMatch(JSON.stringify(result), /1234567890abcdef/);
  }
});

test("decoded sensitive and capability keys retain contextual classification", () => {
  const rejected = [
    [{ "%70assword": "opaque-secret" }, "credential_material"],
    [{ aws_secret_access_key: "opaque-secret" }, "credential_material"],
    [{ secret_access_key: "opaque-secret" }, "credential_material"],
    [{ api_token: "opaque-secret-material" }, "credential_material"],
    [{ api_secret: "opaque-secret-material" }, "credential_material"],
    [{ auth_token: "opaque-secret-material" }, "credential_material"],
    [{ authorization_token: "opaque-secret-material" }, "credential_material"],
    [{ capability_id: "opaque-capability-id" }, "capability_reference"],
    [{ capability_identifier: "opaque-capability-id" }, "capability_reference"],
    [{ "cGFzc3dvcmQ=": "opaque-secret-material" }, "credential_material"],
  ];
  for (const [input, code] of rejected) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, code);
  }

  const shortBase64Value = validateEvidenceSafety(requestFor({
    note: "cGFzc3dvcmQ=",
  }));
  assert.equal(shortBase64Value.accepted, true);
});

test("compound credential and capability families remain guarded", () => {
  for (const [input, code] of [
    [{ note: "aws_secret_access_key=abcdefghijklmnop" }, "credential_material"],
    [{ api_keys: { value: "opaque-api-key-material" } }, "credential_material"],
    [{ secret_refs: ["opaque-secret-reference"] }, "credential_material"],
    [{ capability_envelopes: { grant: "repository:write" } }, "capability_reference"],
  ]) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, code);
  }
});

test("expanded credential and authority key families remain contextual", () => {
  for (const [input, code] of [
    [{ secrets: "opaque-secret-material" }, "credential_material"],
    [{ secret_keys: { value: "opaque-secret-key-material" } }, "credential_material"],
    [{ api_tokens: ["opaque-api-token-material"] }, "credential_material"],
    [{ private_keys: ["opaque-private-key-material"] }, "credential_material"],
    [{ note: "secret_key=opaque-secret-material" }, "credential_material"],
    [{ note: "client_secret=opaque-client-secret-material" }, "credential_material"],
    [{ capability_grants: { scope: "repository:write" } }, "capability_reference"],
    [{ authority_envelopes: { scope: "repository:write" } }, "capability_reference"],
  ]) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, code);
  }

  for (const input of [
    { secrets: "Research about secret management models and terminology." },
    { secret_keys: "<secret keys>" },
    { api_tokens: "Research about API token algorithms and formats." },
    { capability_grants: "Research about capability grants as concepts." },
    { authority_envelopes: "Research about authority envelopes and lifecycle." },
  ]) {
    assert.equal(validateEvidenceSafety(requestFor(input)).accepted, true, JSON.stringify(input));
  }
});

test("credential and capability classifications take precedence over path-like forms", () => {
  const capability = validateEvidenceSafety(requestFor({
    note: "capability://flow/run/123",
  }));
  assert.equal(capability.accepted, false);
  assert.equal(capability.rejection.code, "capability_reference");

  const userInfo = validateEvidenceSafety(requestFor({
    note: "https://user%3Apass@example.test/source",
  }));
  assert.equal(userInfo.accepted, false);
  assert.equal(userInfo.rejection.code, "credential_material");
});

test("credential key families and signed public URI queries remain guarded", () => {
  for (const key of [
    "X-API-Key",
    "x_api_key",
    "API-Key",
    "auth-token",
    "X-Auth-Token",
    "oauth_secret",
    "X-OAuth-Secret",
    "Authorization-Token",
  ]) {
    const result = validateEvidenceSafety(requestFor({ [key]: "opaque-secret" }));
    assert.equal(result.accepted, false, key);
    assert.equal(result.rejection.code, "credential_material");
  }

  const immutableSource = "https://github.com/Seavenly/dotfiles/commit/8fa9d02504a18b4a01d015403b47c097fc99e5f3";
  for (const query of [
    "signature=opaque",
    "sig=opaque",
    "X-Amz-Signature=opaque",
    "X-Amz-Credential=opaque",
    "X-Goog-Signature=opaque",
    "X-Goog-Credential=opaque",
    "oauth_signature=opaque",
    "AWSAccessKeyId=opaque",
    "%73ignature=opaque",
  ]) {
    const result = validateEvidenceSafety(requestFor({
      source_uri: `${immutableSource}?${query}`,
    }));
    assert.equal(result.accepted, false, query);
    assert.equal(result.rejection.code, "credential_material");
  }
});

test("explicit base64 payloads decode recursively and malformed forms fail closed", () => {
  const ambient = validateEvidenceSafety(requestFor({
    encoded_base64: "base64:L2V0Yy9wYXNzd2Q=",
  }));
  assert.equal(ambient.accepted, false);
  assert.equal(ambient.rejection.code, "ambient_filesystem_path");

  const malformed = validateEvidenceSafety(requestFor({
    payload: "base64:%%%not-valid%%%",
  }));
  assert.equal(malformed.accepted, false);
  assert.equal(malformed.rejection.code, "malformed_encoding");
});

test("base64 requires a canonical standard or URL-safe round trip", () => {
  for (const encoded of [
    "base64:YWJj====",
    "base64:YWJj===",
    "base64:YW=Jj",
    "base64:YWJj=",
    "base64:YWJjY",
    "base64:++__",
  ]) {
    const result = validateEvidenceSafety(requestFor({ encoded }));
    assert.equal(result.accepted, false, encoded);
    assert.equal(result.rejection.code, "malformed_encoding");
  }

  const shortRawPath = validateEvidenceSafety(requestFor({
    note: "L2V0Yw==",
  }));
  assert.equal(shortRawPath.accepted, false);
  assert.equal(shortRawPath.rejection.code, "ambient_filesystem_path");

  const safeRaw = validateEvidenceSafety(requestFor({
    note: "YWJj",
  }));
  assert.equal(safeRaw.accepted, true);
});

test("cwd-qualified ambient paths embedded in prose remain prohibited", () => {
  for (const note of [
    "Evidence came from $PWD/private/report.md.",
    "Evidence came from ${PWD}/private/report.md.",
  ]) {
    const result = validateEvidenceSafety(requestFor({ note }));
    assert.equal(result.accepted, false);
    assert.equal(result.rejection.code, "ambient_filesystem_path");
  }
});

test("singular material-bearing keys reject substantive prose-shaped values", () => {
  for (const input of [
    { token: "research token material abcdefghijklmnopqrstuvwxyz" },
    { secret: "research secret material abcdefghijklmnopqrstuvwxyz" },
    { password: "research password material abcdefghijklmnopqrstuvwxyz" },
    { api_key: "research api key material abcdefghijklmnopqrstuvwxyz" },
  ]) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, "credential_material");
  }
});

test("ordinary research prose remains a usable negative control corpus", () => {
  for (const input of [
    { note: "Research about credentials and authentication." },
    { note: "Documentation explains token algorithms and authentication semantics." },
    { note: "Discussion of capability models and references as concepts." },
    { note: "Filesystem concepts and path normalization are documented here." },
    {
      credentials: "Research about credentials and authentication.",
      capabilities: "Research about capability models.",
      path: "Research about path normalization.",
    },
    { authority: "Research about authority and lifecycle vocabulary." },
  ]) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, true, JSON.stringify(input));
  }
});

test("current vendor-prefixed sk token forms are rejected without blocking prose", () => {
  for (const note of [
    "sk-proj-1234567890abcdefghijklmnop",
    "sk-ant-api03-1234567890abcdefghijklmnop",
    "sk-or-v1-1234567890abcdefghijklmnop",
  ]) {
    const result = validateEvidenceSafety(requestFor({ note }));
    assert.equal(result.accepted, false, note);
    assert.equal(result.rejection.code, "credential_material");
  }

  for (const input of [
    { note: "Research discusses sk-proj-token formats as concepts." },
    { token: "<token>" },
  ]) {
    assert.equal(validateEvidenceSafety(requestFor(input)).accepted, true);
  }
});

test("service-token and PGP private-key forms remain credentials", () => {
  for (const note of [
    fixtureServiceToken("sk", "live"),
    fixtureServiceToken("sk", "test"),
    fixtureServiceToken("rk", "live"),
    fixtureServiceToken("rk", "test"),
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  ]) {
    const result = validateEvidenceSafety(requestFor({ note }));
    assert.equal(result.accepted, false, note);
    assert.equal(result.rejection.code, "credential_material");
  }

  for (const note of [
    `Research discusses ${["sk", "_live_"].join("")} token formats as concepts.`,
    "Documentation explains PGP private key blocks conceptually.",
  ]) {
    assert.equal(validateEvidenceSafety(requestFor({ note })).accepted, true);
  }
});

test("malformed encodings and normalization ambiguity fail closed with typed reasons", () => {
  for (const note of ["%ZZ", "%/", "%_", "%?", "%é", "%ED%A0%80"]) {
    const malformed = validateEvidenceSafety(requestFor({ note }));
    assert.equal(malformed.accepted, false);
    assert.equal(malformed.rejection.code, "malformed_encoding");
  }

  for (const note of ["100%", "100% prose"]) {
    assert.equal(validateEvidenceSafety(requestFor({ note })).accepted, true);
  }

  const malformedBase64 = validateEvidenceSafety(requestFor({
    encoded_base64: "base64:%%%not-valid%%%",
  }));
  assert.equal(malformedBase64.accepted, false);
  assert.equal(malformedBase64.rejection.code, "malformed_encoding");

  const decomposed = validateEvidenceSafety(requestFor({ note: "e\u0301vidence" }));
  assert.equal(decomposed.accepted, false);
  assert.equal(decomposed.rejection.code, "ambiguous_normalization");

  const repeated = validateEvidenceSafety(requestFor({
    encoded: "%252525252Fetc%252525252Fpasswd",
  }));
  assert.equal(repeated.accepted, false);
  assert.equal(repeated.rejection.code, "ambiguous_normalization");

  let nested = { value: "leaf" };
  for (let index = 0; index < 40; index += 1) nested = { nested };
  const tooDeep = validateEvidenceSafety(requestFor(nested));
  assert.equal(tooDeep.accepted, false);
  assert.equal(tooDeep.rejection.code, "evidence_too_deep");
});

test("nested structured strings reject duplicate keys before JSON parsing", () => {
  const escapedProse = validateEvidenceSafety(requestFor({
    nested: '{"note":"Research says \\"path\\" and newline\\n escapes are conceptual."}',
  }));
  assert.equal(escapedProse.accepted, true);

  for (const nested of [
    '{"outer":{"name":"one","name":"two"}}',
    '{"outer":{"\\u006eame":"one","name":"two"}}',
  ]) {
    const result = validateEvidenceSafety(requestFor({ nested }));
    assert.equal(result.accepted, false);
    assert.equal(result.rejection.code, "non_canonical_input");
  }

  const duplicateLookingValue = validateEvidenceSafety(requestFor({
    nested: '{"note":"The text {\\"name\\":1,\\"name\\":2} is prose."}',
  }));
  assert.equal(duplicateLookingValue.accepted, true);

  const nonFinite = validateEvidenceSafety(requestFor({
    nested: '{"n":1e999}',
  }));
  assert.equal(nonFinite.accepted, false);
  assert.equal(nonFinite.rejection.code, "non_canonical_input");
});

test("late evidence markers are rejected across lifecycle field spellings", () => {
  for (const key of ["status", "outcome", "disposition", "evidence_disposition"]) {
    for (const value of ["cancelled", "canceled", "late", "quarantined", "late_quarantined"]) {
      const result = validateEvidenceSafety(requestFor({ [key]: value }));
      assert.equal(result.accepted, false, `${key}:${value}`);
      assert.equal(result.rejection.code, "cancelled_or_late_evidence");
    }
  }

  const encoded = validateEvidenceSafety(requestFor({
    "%73tatus": "%6c%61%74%65",
  }));
  assert.equal(encoded.accepted, false);
  assert.equal(encoded.rejection.code, "cancelled_or_late_evidence");

  for (const input of [
    { status: { value: "cancelled" } },
    { outcome: ["late"] },
    { disposition: [{ value: "quarantined" }] },
    { evidence_disposition: { value: "late_quarantined" } },
    { late_result: { text: "late output" } },
    { output_disposition: "late_unclaimed" },
  ]) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, "cancelled_or_late_evidence");
  }

  const conceptual = validateEvidenceSafety(requestFor({
    status: { note: "Research discusses cancellation and late evidence as concepts." },
  }));
  assert.equal(conceptual.accepted, true);

  for (const input of [
    { late_result: null },
    { late_result: "Research discusses late evidence as a concept." },
  ]) {
    assert.equal(validateEvidenceSafety(requestFor(input)).accepted, true);
  }
});

test("authority envelopes reject substantive grants while accepting research prose", () => {
  for (const input of [
    { authority: "repository:write" },
    { authority_envelope: "repository:write" },
    { authority_grant: "repository:write" },
    { authority_scope: "repository:write" },
    { authority: { grants: ["repository:write"] } },
    { authority_ref: "authority://repository/write" },
  ]) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, "capability_reference");
  }

  const prose = validateEvidenceSafety(requestFor({
    authority: "Research about RunAuthority and lifecycle boundaries.",
  }));
  assert.equal(prose.accepted, true);
});

test("structural capability envelopes are rejected without a capability key", () => {
  for (const input of [
    { record: { type: "capability", subject: "workspace:repo", scope: "repository:write" } },
    { record: { kind: "authority", subject: "workspace:repo", scope: "repository:write" } },
    { record: { contract: "capability-envelope/v1", target: "workspace:repo", grant: "repository:write" } },
    { record: { type: "authority", target: "workspace:repo", commands: ["repository:write"] } },
    { record: { subject: "workspace:repo", scope: "repository:write" } },
    { record: { subject: "workspace:repo", rights: ["repository:write"] } },
  ]) {
    const result = validateEvidenceSafety(requestFor(input));
    assert.equal(result.accepted, false, JSON.stringify(input));
    assert.equal(result.rejection.code, "capability_reference");
  }

  const conceptual = validateEvidenceSafety(requestFor({
    record: {
      type: "capability",
      subject: "Research discusses capability subjects as concepts.",
      scope: "Research discusses authority scopes as concepts.",
    },
  }));
  assert.equal(conceptual.accepted, true);

  const conceptualMarkerless = validateEvidenceSafety(requestFor({
    record: {
      subject: "Research discusses subjects and authority scope concepts.",
      commands: "Documentation describes command vocabulary, not a grant.",
    },
  }));
  assert.equal(conceptualMarkerless.accepted, true);
});

test("descriptor-safe preflight rejects deep input before reading a later getter", () => {
  let input = { leaf: "safe" };
  let cursor = input;
  for (let index = 0; index < EVIDENCE_SAFETY_LIMITS.max_depth + 2; index += 1) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  const inputDigest = digest(input);
  let reads = 0;
  Object.defineProperty(cursor, "secret", {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return fixtureGithubToken();
    },
  });

  const result = validateEvidenceSafety({
    ...baseRequest,
    input,
    input_digest: inputDigest,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, "evidence_too_deep");
  assert.equal(reads, 0);
  assert.doesNotMatch(JSON.stringify(result), fixturePattern(fixtureGithubToken()));
});

test("short authorization assignments are rejected without blocking algorithm prose", () => {
  for (const note of [
    "Bearer abc",
    "Basic abc",
    "token=abc",
    "authorization: abc",
    "auth_token=abcdefghijklmnop",
    "oauth_token=abcdefghijklmnop",
    "authorization_token=abcdefghijklmnop",
    "api_secret=abcdefghijklmnop",
    "secret_access_key=abcdefghijklmnop",
  ]) {
    const result = validateEvidenceSafety(requestFor({ note }));
    assert.equal(result.accepted, false, note);
    assert.equal(result.rejection.code, "credential_material");
  }

  for (const note of [
    "Bearer algorithm",
    "Basic authentication",
    "Bearer algorithms are documented here.",
    "Basic authentication algorithms are discussed.",
    "Research discusses bearer algorithms and basic authentication.",
    "Documentation explains token algorithms without a presented value.",
  ]) {
    assert.equal(validateEvidenceSafety(requestFor({ note })).accepted, true, note);
  }
});

test("one accepted receipt can bind all three non-authoritative boundaries", () => {
  const validated = validateEvidenceSafety(baseRequest);
  assert.equal(validated.accepted, true);
  const { receipt } = validated;
  const subjectDigest = `sha256:${"1".repeat(64)}`;
  const bindings = [
    bindDelegateEvidenceReceipt(receipt, { subject_digest: subjectDigest }),
    bindArtifactAcceptanceReceipt(receipt, { subject_digest: subjectDigest }),
    bindResourceHandoffReceipt(receipt, { subject_digest: subjectDigest }),
  ];

  assert.deepEqual(bindings.map(({ accepted, binding }) => ({ accepted, binding: binding.boundary })), [
    { accepted: true, binding: "delegate_transfer" },
    { accepted: true, binding: "artifact_acceptance" },
    { accepted: true, binding: "resource_handoff_publication" },
  ]);
  for (const result of bindings) {
    assert.deepEqual(Object.keys(result.binding).sort(), [
      "binding_digest",
      "boundary",
      "input_digest",
      "receipt_digest",
      "schema",
      "self_digest",
      "subject_digest",
    ]);
    assert.equal(result.binding.binding_digest, result.binding.self_digest);
  }
});

test("binders preflight receipt, wrapper, and context data properties", () => {
  const { receipt } = validateEvidenceSafety(baseRequest);
  const subjectDigest = `sha256:${"1".repeat(64)}`;

  function accessorReceipt() {
    const copy = { ...receipt, allowed_use: [...receipt.allowed_use] };
    let reads = 0;
    Object.defineProperty(copy, "allowed_use", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? receipt.allowed_use : [];
      },
    });
    return { copy, get reads() { return reads; } };
  }

  const direct = accessorReceipt();
  const directResult = bindEvidenceReceipt(direct.copy, {
    boundary: "delegate_transfer",
    subject_digest: subjectDigest,
  });
  assert.equal(directResult.accepted, false);
  assert.equal(directResult.rejection.operation, "bind");
  assert.equal(directResult.rejection.code, "non_canonical_input");
  assert.equal(direct.reads, 0);

  const wrapped = accessorReceipt();
  const wrappedResult = bindDelegateEvidenceReceipt({
    receipt: wrapped.copy,
    boundary: "delegate_transfer",
    subject_digest: subjectDigest,
  });
  assert.equal(wrappedResult.accepted, false);
  assert.equal(wrappedResult.rejection.operation, "bind");
  assert.equal(wrappedResult.rejection.code, "non_canonical_input");
  assert.equal(wrapped.reads, 0);

  const throwingContext = {};
  Object.defineProperty(throwingContext, "subject_digest", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(fixtureContextSecret());
    },
  });
  let contextResult;
  assert.doesNotThrow(() => {
    contextResult = bindResourceHandoffReceipt(receipt, throwingContext);
  });
  assert.equal(contextResult.accepted, false);
  assert.equal(contextResult.rejection.operation, "bind");
  assert.equal(contextResult.rejection.code, "non_canonical_input");
  assert.doesNotMatch(JSON.stringify(contextResult), fixturePattern(fixtureContextSecret()));
});

test("receipt tampering, replay mismatch, and cancellation or late contexts fail closed", () => {
  const { receipt } = validateEvidenceSafety(baseRequest);
  const tampered = bindDelegateEvidenceReceipt({
    ...receipt,
    input_digest: `sha256:${"2".repeat(64)}`,
  });
  assert.equal(tampered.accepted, false);
  assert.equal(tampered.rejection.code, "receipt_digest_mismatch");

  const replay = bindDelegateEvidenceReceipt(receipt);
  const replayAgain = bindDelegateEvidenceReceipt(receipt);
  assert.deepEqual(replayAgain, replay);

  const cancellation = bindDelegateEvidenceReceipt(receipt, {
    status: "cancelled",
  });
  assert.equal(cancellation.accepted, false);
  assert.equal(cancellation.rejection.code, "invalid_binding_context");
  const late = bindDelegateEvidenceReceipt({
    receipt,
    status: "late",
  });
  assert.equal(late.accepted, false);
  assert.equal(late.rejection.code, "invalid_binding_context");

  const wrongBoundary = bindDelegateEvidenceReceipt(receipt, {
    boundary: "artifact_acceptance",
  });
  assert.equal(wrongBoundary.accepted, false);
  assert.equal(wrongBoundary.rejection.code, "invalid_binding_context");

  const conflictingBoundary = bindEvidenceReceipt({
    receipt,
    boundary: "delegate_transfer",
  }, {
    boundary: "artifact_acceptance",
  });
  assert.equal(conflictingBoundary.accepted, false);
  assert.equal(conflictingBoundary.rejection.code, "invalid_binding_context");

  const conflictingSubject = bindEvidenceReceipt({
    receipt,
    subject_digest: `sha256:${"1".repeat(64)}`,
  }, {
    subject_digest: `sha256:${"2".repeat(64)}`,
  });
  assert.equal(conflictingSubject.accepted, false);
  assert.equal(conflictingSubject.rejection.code, "invalid_binding_context");
});
