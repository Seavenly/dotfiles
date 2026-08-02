import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  authorizeLegacyImport,
  loadContractCatalog,
} from "../src/contract-catalog.mjs";
const catalogPath = fileURLToPath(
  new URL("../../../config/flow/contracts/catalog.v1.json", import.meta.url),
);
const featureContractPath = fileURLToPath(new URL(
  "../../../config/flow/contracts/drovr-required-features.v1.json",
  import.meta.url,
));
const subjectBytes = Buffer.from("artifact\n");
const subjectDigest =
  "sha256:5b3513f580c8397212ff2c8f459c199efc0c90e4354a5f3533adf0a3fff3a530";

test("the public catalog exposes the settled interface and forbids legacy import", async () => {
  const catalog = await loadContractCatalog({ catalogPath });

  assert.deepEqual(catalog.flow_runtime.operations, [
    "prepare",
    "launch",
    "command",
    "query",
    "watch",
  ]);
  assert.equal(catalog.catalog_version, 11);
  assert.deepEqual(catalog.authority_persistence, {
    append_only_streams: true,
    authority_epoch: {
      boot_bound: true,
      effect_recheck: true,
      monotonic: true,
    },
    contract: "flow.sqlite-authority-store/v1",
    foreign_keys: true,
    journal_mode: "wal",
    mutation_lock: "sqlite_os_advisory_lock",
    synchronous: "full",
    schema_transition: {
      action_contract: "flow.command/v1",
      boundary_contract: "flow.authority-schema-transition-boundary/v1",
      compatibility_projection: "flow.authority-schema-compatibility/v1",
      current_version: 2,
      release: {
        schema: "flow.runtime-release/v1",
        id: "flow-runtime-authority-schema/v2",
        catalog_version: 8,
      },
      transition_contract: "flow.authority-schema-transition/v1",
    },
    takeover: "operating_system_lock_release_only",
    transactional_folds: true,
  });
  assert.deepEqual(catalog.flow_runtime.rejection_contract, {
    contract: "flow.rejection/v1",
    fields: [
      "schema",
      "operation",
      "code",
      "reason",
      "command_type",
      "run_id",
      "bundle_digest",
      "authority_watermark",
      "authority_watermark_domain",
      "legal_actions",
    ],
    watermark_domains: {
      host: "host_run_index_admission_and_authority_schema",
      run: "run_lifecycle_stream_authority_epoch_and_authority_schema",
    },
  });
  for (const contract of [
    "flow.dynamic-plan-proposal/v1",
    "flow.dynamic-plan-confirmation/v1",
    "flow.dynamic-plan-confirmation-decision/v1",
    "flow.closed-fact-observation/v1",
    "flow.prepared-run/v1",
    "flow.launch-receipt/v1",
    "flow.command-receipt/v1",
    "flow.run-projection/v1",
    "flow.run-index-projection/v1",
    "flow.card-block/v1",
    "flow.card-block-observation/v1",
    "flow.adapter/card-block-observation/v1",
    "flow.validator/card-block-observation/v1",
    "flow.revision-trigger/v1",
    "flow.plan-revision-template/v1",
    "flow.registered-operation/v1",
    "flow.validator/operation-receipt/v1",
    "flow.delegate-evidence/v1",
    "flow.authority-schema-compatibility/v1",
    "flow.authority-schema-transition/v1",
    "flow.authority-schema-transition-boundary/v1",
    "flow.runtime-release/v1",
  ]) {
    assert.equal(catalog.contracts.includes(contract), true, contract);
  }
  assert.equal(
    catalog.flow_runtime.operation_contracts.prepare.block_observations,
    "flow.card-block-observation/v1",
  );
  assert.ok(catalog.mechanism_adapters.includes("card_block_observation"));
  assert.deepEqual(catalog.flow_runtime.operation_execution, {
    authority: "RunAuthority",
    coordinator_authority: "mechanism_only",
    registration: "flow.registered-operation/v1",
    intent: "flow.effect-intent/v1",
    observation: "flow.effect-observation/v1",
    receipt: "flow.effect-receipt/v1",
    receipt_validator: "flow.validator/operation-receipt/v1",
    effect_classes: [
      "read_only",
      "caller_idempotent",
      "reconcilable",
      "one_shot_uncertain",
    ],
    execution_command: "operation_execute",
    recovery_command: "recovery",
    cancellation_command: "cancel",
    cancelled_recovery: "settle_cancelled",
    cancelled_attempt_disposition: "abandoned",
    late_effect_disposition: "quarantined",
    cancelled_resource_dispositions: ["released", "quarantined"],
  });
  assert.deepEqual(catalog.flow_runtime.delegate_execution, {
    authority: "RunAuthority",
    adapter_authority: "mechanism_only",
    port: "flow.delegated-agent-port/v1",
    intent: "flow.effect-intent/v1",
    receipt: "flow.effect-receipt/v1",
    evidence: "flow.delegate-evidence/v1",
    quarantine_record: "flow.delegate-quarantine/v1",
    block: "flow.delegate-card-block/v1",
    disposition_policy: "flow.delegate-terminal-disposition-policy/v1",
    execution_command: "delegate_execute",
    recovery_command: "recovery",
    attempt_identity: "run_card_reserved_attempt",
    dispatch_order: "discover_before_dispatch",
    settlement: "exact_binding_ordered_inputs_and_independent_validation",
    quarantine: "late_or_incompatible_correlated",
    terminal_disposition:
      "retire_receipt_or_named_durable_handoff_with_exact_working_turn_cancellation",
    exhausted_action: "terminal_disposition",
  });
  assert.ok(catalog.projections.includes("authority_schema_compatibility"));
  assert.deepEqual(catalog.work_domain_interfaces.handoff.atomic_finalization, [
    "workspace_promotion",
    "artifact_pin_transfer",
    "workspace_disposition",
    "handoff_activation",
    "producer_run_finalization",
  ]);
  for (const contract of [
    "work.workspace-authority/v1",
    "work.workspace-register-command/v1",
    "work.git-observation/v1",
    "work.artifact-authority/v1",
    "work.artifact-record-command/v1",
    "flow.resource-handoff-authority/v1",
    "work.command-receipt/v1",
    "work.rejection/v1",
    "work.workspace-projection/v1",
    "work.artifact-projection/v1",
    "flow.resource-handoff-publication/v1",
    "flow.resource-handoff-projection/v1",
    "flow.resource-handoff-consumer-binding/v1",
    "flow.resource-handoff-mutation-authorization/v1",
    "flow.git-retention-receipt/v1",
    "flow.git-retention-observation/v1",
    "work.idempotency-receipt/v1",
  ]) {
    assert.ok(catalog.contracts.includes(contract), contract);
  }
  assert.deepEqual(catalog.flow_runtime.operation_contracts.query.registered, {
    delegated_agent_description: {
      projection: "flow.delegated-agent-description-projection/v1",
      rejection: "flow.rejection/v1",
      request: "flow.query/v1",
    },
    legacy_compatibility_inventory: {
      projection: "flow.legacy-compatibility-inventory/v1",
      rejection: "flow.rejection/v1",
      request: "flow.query/v1",
    },
  });
  assert.ok(catalog.contracts.includes("flow.query/v1"));
  assert.ok(catalog.contracts.includes("flow.legacy-compatibility-inventory/v1"));
  assert.ok(catalog.projections.includes("legacy_compatibility_inventory"));
  assert.deepEqual(catalog.delegated_agent_port, {
    contract: "flow.delegated-agent-port/v1",
    authority: "non_authoritative",
    adapter: "drovr/v1",
    description_request: "flow.delegated-agent-description-request/v1",
    description_projection: "flow.delegated-agent-description-projection/v1",
    lifecycle_projection: "flow.delegated-agent-lifecycle-projection/v1",
    operations: {
      dispatch: "flow.delegated-agent-dispatch-request/v1",
      discover: "flow.delegated-agent-discover-request/v1",
      send: "flow.delegated-agent-send-request/v1",
      observe: "flow.delegated-agent-observe-request/v1",
      wait: "flow.delegated-agent-wait-request/v1",
      cancel: "flow.delegated-agent-cancel-request/v1",
      reconcile: "flow.delegated-agent-reconcile-request/v1",
      retire: "flow.delegated-agent-retire-request/v1",
    },
    drovr_description: "drovr.delegated-agent-description/v1",
    required_features: {
      contract: "flow.drovr-required-features/v1",
      content_sha256:
        "sha256:837aca5ff5debd64e355dbc6ea0e19504a53fe85cc411adecbe0e643585b0896",
    },
  });
  assert.deepEqual(catalog.authority_roots, {
    legacy_claude: { base: "home", path: ".agent-teams" },
    legacy_agent_flow: { base: "state", path: "agent-flow" },
    replacement: { base: "state", path: "flow" },
  });
  assert.deepEqual(catalog.legacy_import.adapters, []);
  assert.deepEqual(catalog.legacy_import.required_validations, [
    "digest",
    "schema",
    "provenance",
    "redaction",
    "classification",
    "retention",
    "allowed_use",
  ]);
  assert.deepEqual(catalog.legacy_import.allowed_subjects, ["artifact_bytes"]);

  assert.throws(
    () => authorizeLegacyImport(catalog, { adapter: "implicit" }),
    /no legacy import adapter is registered/,
  );
});

test("the public catalog rejects a weakened Drovr feature baseline", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-catalog-drovr-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const weakenedCatalogPath = join(scratch, "catalog.json");
  const weakenedFeatureContractPath = join(
    scratch,
    "drovr-required-features.v1.json",
  );
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const weakenedFeatureContract = JSON.parse(
    await readFile(featureContractPath, "utf8"),
  );
  weakenedFeatureContract.features[0].guarantees.pop();
  const weakenedBytes = Buffer.from(
    `${JSON.stringify(weakenedFeatureContract, null, 2)}\n`,
  );
  catalog.delegated_agent_port.required_features.content_sha256 =
    `sha256:${createHash("sha256").update(weakenedBytes).digest("hex")}`;
  await writeFile(weakenedCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(weakenedFeatureContractPath, weakenedBytes);

  await assert.rejects(
    loadContractCatalog({ catalogPath: weakenedCatalogPath }),
    /contract catalog Drovr feature baseline is incomplete or weakened/,
  );
});

test("the public catalog rejects nested authority roots", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-catalog-roots-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const nestedCatalogPath = join(scratch, "catalog.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  catalog.authority_roots.replacement = {
    base: "state",
    path: "agent-flow/flow",
  };
  await writeFile(nestedCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  await assert.rejects(
    loadContractCatalog({
      catalogPath: nestedCatalogPath,
      featureContractPath,
    }),
    /contract catalog authority roots must be disjoint/,
  );
});

test("the public catalog requires the complete rejection contract", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-catalog-rejection-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const incompleteCatalogPath = join(scratch, "catalog.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  catalog.flow_runtime.rejection_contract = {
    contract: "flow.rejection/v1",
    fields: ["schema"],
    watermark_domains: {
      host: "host_run_index_admission_and_authority_schema",
      run: "run_lifecycle_stream_authority_epoch_and_authority_schema",
    },
  };
  await writeFile(incompleteCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  await assert.rejects(
    loadContractCatalog({
      catalogPath: incompleteCatalogPath,
      featureContractPath,
    }),
    /contract catalog rejection contract is incomplete/,
  );
});

test("the public catalog requires the durable authority contract", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-catalog-authority-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const incompleteCatalogPath = join(scratch, "catalog.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  delete catalog.authority_persistence.authority_epoch.effect_recheck;
  await writeFile(incompleteCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  await assert.rejects(
    loadContractCatalog({ catalogPath: incompleteCatalogPath }),
    /contract catalog authority persistence is incomplete/,
  );
});

test("the public catalog requires complete registered operation contracts", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-catalog-operation-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const incompleteCatalogPath = join(scratch, "catalog.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  delete catalog.flow_runtime.operation_execution.receipt_validator;
  await writeFile(incompleteCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  await assert.rejects(
    loadContractCatalog({
      catalogPath: incompleteCatalogPath,
      featureContractPath,
    }),
    /registered operation contracts are incomplete/,
  );
});

test("the public catalog requires the delegate quarantine block contract", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-catalog-delegate-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const incompleteCatalogPath = join(scratch, "catalog.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  catalog.contracts = catalog.contracts.filter(
    (contract) => contract !== "flow.delegate-card-block/v1",
  );
  await writeFile(incompleteCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  await assert.rejects(
    loadContractCatalog({
      catalogPath: incompleteCatalogPath,
      featureContractPath,
    }),
    /delegate execution contracts are incomplete/,
  );
});

test("the public catalog binds registered queries to published contracts", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-catalog-query-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const invalidCatalogPath = join(scratch, "catalog.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  catalog.contracts = catalog.contracts.filter((contract) => contract !== "flow.query/v1");
  await writeFile(invalidCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  await assert.rejects(
    loadContractCatalog({
      catalogPath: invalidCatalogPath,
      featureContractPath,
    }),
    /registered query contracts must be published/,
  );
});

test("the public catalog requires the complete legacy import policy", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-catalog-import-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const incompleteCatalogPath = join(scratch, "catalog.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  catalog.legacy_import.required_validations = ["digest"];
  await writeFile(incompleteCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  await assert.rejects(
    loadContractCatalog({
      catalogPath: incompleteCatalogPath,
      featureContractPath,
    }),
    /contract catalog legacy import policy is incomplete/,
  );

  catalog.legacy_import.required_validations = [
    "digest",
    "schema",
    "provenance",
    "redaction",
    "classification",
    "retention",
    "allowed_use",
  ];
  catalog.legacy_import.forbidden_authority.pop();
  await writeFile(incompleteCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await assert.rejects(
    loadContractCatalog({
      catalogPath: incompleteCatalogPath,
      featureContractPath,
    }),
    /contract catalog legacy import policy is incomplete/,
  );

  catalog.legacy_import.forbidden_authority.push("completion");
  catalog.legacy_import.allowed_subjects = ["legacy_completion"];
  await writeFile(incompleteCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await assert.rejects(
    loadContractCatalog({
      catalogPath: incompleteCatalogPath,
      featureContractPath,
    }),
    /contract catalog legacy import policy is incomplete/,
  );

  catalog.legacy_import.allowed_subjects = ["artifact_bytes"];
  delete catalog.contracts;
  await writeFile(incompleteCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await assert.rejects(
    loadContractCatalog({
      catalogPath: incompleteCatalogPath,
      featureContractPath,
    }),
    /contract catalog contracts must be an explicit array/,
  );
});

test("legacy import requires every catalog validation", async () => {
  const catalogWithAdapter = await catalogWithLegacyImportAdapter();

  assert.throws(
    () => authorizeLegacyImport(catalogWithAdapter, {
      adapter: "legacy-bytes/v1",
      validationReceipt: {
        contract: "legacy-bytes.validation/v1",
        adapter_contract: "legacy-bytes/v1",
        subject_digest: subjectDigest,
        issued_at: "2026-07-31T01:00:00Z",
        outcomes: { digest: "passed" },
      },
      subjects: [],
      subjectBytes,
    }),
    /legacy import validation is not passing: schema/,
  );
});

test("legacy import rejects an adapter that is not bound to a catalog contract", async () => {
  const catalog = await loadContractCatalog({ catalogPath });
  const catalogWithAdapter = structuredClone(catalog);
  catalogWithAdapter.legacy_import.adapters.push("legacy-bytes/v1");
  const validations = Object.fromEntries(
    catalogWithAdapter.legacy_import.required_validations.map((name) => [name, true]),
  );

  assert.throws(
    () => authorizeLegacyImport(catalogWithAdapter, {
      adapter: "legacy-bytes/v1",
      validations,
      subjects: ["artifact_bytes"],
    }),
    /legacy import adapter must name a catalog contract/,
  );
});

test("legacy import rejects untyped caller validation flags", async () => {
  const catalogWithAdapter = await catalogWithLegacyImportAdapter();
  const validations = Object.fromEntries(
    catalogWithAdapter.legacy_import.required_validations.map((name) => [name, true]),
  );

  assert.throws(
    () => authorizeLegacyImport(catalogWithAdapter, {
      adapter: "legacy-bytes/v1",
      validations,
      subjects: ["artifact_bytes"],
    }),
    /legacy import validation receipt is invalid/,
  );
});

test("legacy import rejects a validation receipt unrelated to the subject bytes", async () => {
  const catalogWithAdapter = await catalogWithLegacyImportAdapter();
  const validationReceipt = {
    ...passingValidationReceipt(catalogWithAdapter),
    subject_digest: `sha256:${"0".repeat(64)}`,
    issued_at: "2026-07-31T01:00:00Z",
  };

  assert.throws(
    () => authorizeLegacyImport(catalogWithAdapter, {
      adapter: "legacy-bytes/v1",
      validationReceipt,
      subjects: ["artifact_bytes"],
      subjectBytes,
    }),
    /legacy import validation receipt does not match the subject bytes/,
  );
});

test("legacy import does not claim unauthenticated receipt provenance", async () => {
  const catalogWithAdapter = await catalogWithLegacyImportAdapter();
  const validationReceipt = passingValidationReceipt(catalogWithAdapter);

  assert.equal(
    authorizeLegacyImport(catalogWithAdapter, {
      adapter: "legacy-bytes/v1",
      validationReceipt,
      subjects: ["artifact_bytes"],
      subjectBytes,
    }).authorized,
    true,
  );
});

test("legacy import permits validated bytes but never legacy authority", async () => {
  const catalogWithAdapter = await catalogWithLegacyImportAdapter();
  const validationReceipt = passingValidationReceipt(catalogWithAdapter);

  assert.throws(
    () => authorizeLegacyImport(catalogWithAdapter, {
      adapter: "legacy-bytes/v1",
      validationReceipt,
      subjectBytes,
    }),
    /legacy import subjects must be explicit/,
  );
  assert.throws(
    () => authorizeLegacyImport(catalogWithAdapter, {
      adapter: "legacy-bytes/v1",
      validationReceipt,
      subjects: [],
      subjectBytes,
    }),
    /legacy import subjects must be non-empty/,
  );

  assert.throws(
    () => authorizeLegacyImport(catalogWithAdapter, {
      adapter: "legacy-bytes/v1",
      validationReceipt,
      subjects: ["completion"],
      subjectBytes,
    }),
    /legacy import subject is not allowed: completion/,
  );
  assert.deepEqual(
    authorizeLegacyImport(catalogWithAdapter, {
      adapter: "legacy-bytes/v1",
      validationReceipt,
      subjects: ["artifact_bytes"],
      subjectBytes,
    }),
    {
      adapter: "legacy-bytes/v1",
      validation_contract: "legacy-bytes.validation/v1",
      subject_digest: subjectDigest,
      authorized: true,
      subjects: ["artifact_bytes"],
    },
  );
});

async function catalogWithLegacyImportAdapter() {
  const catalog = structuredClone(await loadContractCatalog({ catalogPath }));
  catalog.contracts.push("legacy-bytes/v1", "legacy-bytes.validation/v1");
  catalog.legacy_import.adapters.push({
    contract: "legacy-bytes/v1",
    validation_contract: "legacy-bytes.validation/v1",
    allowed_subjects: ["artifact_bytes"],
  });
  return catalog;
}

function passingValidationReceipt(catalog) {
  return {
    contract: "legacy-bytes.validation/v1",
    adapter_contract: "legacy-bytes/v1",
    subject_digest: subjectDigest,
    issued_at: "2026-07-31T01:00:00Z",
    outcomes: Object.fromEntries(
      catalog.legacy_import.required_validations.map((name) => [name, "passed"]),
    ),
  };
}
