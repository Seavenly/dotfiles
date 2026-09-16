export const DETERMINISTIC_QUALIFICATION_SCOPE =
  "deterministic_route_and_host_fault_conformance";

export const DETERMINISTIC_QUALIFICATION_ASSERTIONS = Object.freeze([
  "legacy Claude remains the repeated default policy selection",
  "dark opt-in resolves only exact feature verify and local review routes",
  "dynamic, unknown, and mixed dangerous executor routes are rejected",
  "failed, blocked, not-run, and tampered qualification withholds admission",
  "feature verify and local review pass core conformance with the Drovr port",
  "unavailable feature operations fail before a public route is admitted",
  "public host fault, restart, and reboot suites pass without remote authority",
  "phase-one host-fault suites use the registered-operation test runtime; production positives are qualified separately",
  "release content binds the exact governed tree and contained regular files",
  "normal use and remote mutation authority remain false",
  "prerequisite integrity remains bound to the declared qualification base",
]);

const commands = [
  {
    id: "launch_selector",
    command: "node --test tools/flow/test/launch-selector.test.mjs",
    args: ["--test", "tools/flow/test/launch-selector.test.mjs"],
    receipt_path: "evidence/receipts/launch-selector.tap",
  },
  {
    id: "release_tree_integrity",
    command: "node --test --test-name-pattern='release content binds|release content validates from a fresh clone|release-content generator excludes ignored files|Git tree derivation matches|release manifest with a missing governed file|candidate-tree bytes|wrong or unavailable candidate tree binding|evidence symlink outside authority|external symlink before reading' tools/flow/test/transition-projection.test.mjs",
    args: [
      "--test",
      "--test-name-pattern=release content binds|release content validates from a fresh clone|release-content generator excludes ignored files|Git tree derivation matches|release manifest with a missing governed file|candidate-tree bytes|wrong or unavailable candidate tree binding|evidence symlink outside authority|external symlink before reading",
      "tools/flow/test/transition-projection.test.mjs",
    ],
    receipt_path: "evidence/receipts/release-tree-integrity.tap",
  },
  {
    id: "contract_catalog",
    command: "node --test tools/flow/test/contract-catalog.test.mjs",
    args: ["--test", "tools/flow/test/contract-catalog.test.mjs"],
    receipt_path: "evidence/receipts/contract-catalog.tap",
  },
  {
    id: "feature_review_drovr_conformance",
    command: "node --test tools/flow/test/feature-flow.test.mjs tools/flow/test/review-flow.test.mjs tools/flow/test/delegated-agent-port.test.mjs",
    args: [
      "--test",
      "tools/flow/test/feature-flow.test.mjs",
      "tools/flow/test/review-flow.test.mjs",
      "tools/flow/test/delegated-agent-port.test.mjs",
    ],
    receipt_path: "evidence/receipts/feature-review-drovr.tap",
  },
  {
    id: "production_runtime_reboot",
    command: "node --test --test-name-pattern='default FlowRuntime is durable|default production work evidence fails closed|production reboot observation|production critique evidence is strict' config/flow/test/production-runtime.test.mjs",
    args: [
      "--test",
      "--test-name-pattern=default FlowRuntime is durable|default production work evidence fails closed|production reboot observation|production critique evidence is strict",
      "config/flow/test/production-runtime.test.mjs",
    ],
    receipt_path: "evidence/receipts/production-runtime-reboot.tap",
  },
  {
    id: "public_host_negative_routes",
    command: "node --test --test-name-pattern='public prepare withholds|public launch withholds|public dynamic prepare|public dynamic plans cannot|exact-definition graph with a registered push|public launch with opt-in rejects|public prepare requires explicit|public launch cannot bypass|public dark feature verify fails closed|public verify plans requiring unavailable|public local review rejects forged extra' config/flow/test/runtime.test.mjs",
    args: [
      "--test",
      "--test-name-pattern=public prepare withholds|public launch withholds|public dynamic prepare|public dynamic plans cannot|exact-definition graph with a registered push|public launch with opt-in rejects|public prepare requires explicit|public launch cannot bypass|public dark feature verify fails closed|public verify plans requiring unavailable|public local review rejects forged extra",
      "config/flow/test/runtime.test.mjs",
    ],
    receipt_path: "evidence/receipts/public-host-negative-routes.tap",
  },
  {
    id: "host_fault_reboot",
    command: "node --test --test-skip-pattern='public host (?:rebuilds the review inbox after the producing client exits|supersedes a production review and rejects stale follow-up actions)' config/flow/test/host-lifecycle.test.mjs config/flow/test/public-process.test.mjs",
    args: [
      "--test",
      "--test-skip-pattern=public host (?:rebuilds the review inbox after the producing client exits|supersedes a production review and rejects stale follow-up actions)",
      "config/flow/test/host-lifecycle.test.mjs",
      "config/flow/test/public-process.test.mjs",
    ],
    receipt_path: "evidence/receipts/host-fault-reboot.tap",
  },
  {
    id: "schema_contracts",
    command: "node --test config/flow/test/schema-contracts.test.mjs",
    args: ["--test", "config/flow/test/schema-contracts.test.mjs"],
    receipt_path: "evidence/receipts/schema-contracts.tap",
  },
];

export const DETERMINISTIC_QUALIFICATION_COMMANDS = Object.freeze(
  commands.map((command) => Object.freeze({
    ...command,
    args: Object.freeze([...command.args]),
    working_directory: ".",
  })),
);

export const PRODUCTION_ROUTE_CONFORMANCE_SCOPE =
  "production_public_route_conformance";

export const PRODUCTION_ROUTE_CONFORMANCE_ASSERTIONS = Object.freeze([
  "real production feature verify mutates and verifies a local candidate through production runtime, gate, composition, workspace authority, and deterministic Drovr-port adapter",
  "public local review prepares and launches through production runtime, gate, composition, review authority, and inbox projection",
  "production route cases use isolated local repositories and do not authorize remote mutations",
]);

export const PRODUCTION_ROUTE_CONFORMANCE_ROUTES = Object.freeze([
  Object.freeze({ flow: "feature", mode: "verify" }),
  Object.freeze({ flow: "review", mode: "local" }),
]);

const productionRouteCommands = [
  {
    id: "production_feature_verify",
    command: "node --test --test-name-pattern='production feature runs a real Git mutation through a local candidate' config/flow/test/production-runtime.test.mjs",
    args: [
      "--test",
      "--test-name-pattern=production feature runs a real Git mutation through a local candidate",
      "config/flow/test/production-runtime.test.mjs",
    ],
    receipt_path: "evidence/receipts/production-feature-verify.tap",
    working_directory: ".",
  },
  {
    id: "public_local_review_process",
    command: "node --test --test-name-pattern='public host rebuilds the review inbox after the producing client exits|public host supersedes a production review and rejects stale follow-up actions' config/flow/test/public-process.test.mjs",
    args: [
      "--test",
      "--test-name-pattern=public host rebuilds the review inbox after the producing client exits|public host supersedes a production review and rejects stale follow-up actions",
      "config/flow/test/public-process.test.mjs",
    ],
    receipt_path: "evidence/receipts/public-local-review-process.tap",
    working_directory: ".",
  },
  {
    id: "public_drovr_finding_schema",
    command: "node --test --test-name-pattern='public preparation normalizes real Drovr feature findings' config/flow/test/runtime.test.mjs",
    args: [
      "--test",
      "--test-name-pattern=public preparation normalizes real Drovr feature findings",
      "config/flow/test/runtime.test.mjs",
    ],
    receipt_path: "evidence/receipts/public-drovr-finding-schema.tap",
    working_directory: ".",
  },
];

export const PRODUCTION_ROUTE_CONFORMANCE_COMMANDS = Object.freeze(
  productionRouteCommands.map((command) => Object.freeze({
    ...command,
    args: Object.freeze([...command.args]),
  })),
);

export function createProductionRouteConformanceEvidence({
  releaseId,
  qualificationBaseCommit,
  candidateTreeSha,
  releaseContentDigest,
  status = "not_run",
  phase1EvidenceSha256 = null,
  generationId = null,
  generationBindingSha256 = null,
  recipe = null,
  capturedAt,
  environment,
}) {
  return {
    schema: "flow.production-route-conformance-evidence/v1",
    release_id: releaseId,
    qualification_base_commit: qualificationBaseCommit,
    candidate_tree_sha: candidateTreeSha,
    release_content_digest: releaseContentDigest,
    status,
    scope: PRODUCTION_ROUTE_CONFORMANCE_SCOPE,
    routes: PRODUCTION_ROUTE_CONFORMANCE_ROUTES.map((route) => ({ ...route })),
    assertions: [...PRODUCTION_ROUTE_CONFORMANCE_ASSERTIONS],
    phase1_evidence_sha256: phase1EvidenceSha256,
    generation_id: generationId,
    generation_binding_sha256: generationBindingSha256,
    recipe,
    captured_at: capturedAt,
    environment,
  };
}
