import assert from "node:assert/strict";
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
  assert.equal(catalog.catalog_version, 2);
  for (const contract of [
    "flow.dynamic-plan-proposal/v1",
    "flow.dynamic-plan-confirmation/v1",
    "flow.prepared-run/v1",
    "flow.launch-receipt/v1",
    "flow.command-receipt/v1",
    "flow.run-projection/v1",
    "flow.run-index-projection/v1",
  ]) {
    assert.equal(catalog.contracts.includes(contract), true, contract);
  }
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
    loadContractCatalog({ catalogPath: nestedCatalogPath }),
    /contract catalog authority roots must be disjoint/,
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
    loadContractCatalog({ catalogPath: incompleteCatalogPath }),
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
    loadContractCatalog({ catalogPath: incompleteCatalogPath }),
    /contract catalog legacy import policy is incomplete/,
  );

  catalog.legacy_import.forbidden_authority.push("completion");
  catalog.legacy_import.allowed_subjects = ["legacy_completion"];
  await writeFile(incompleteCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await assert.rejects(
    loadContractCatalog({ catalogPath: incompleteCatalogPath }),
    /contract catalog legacy import policy is incomplete/,
  );

  catalog.legacy_import.allowed_subjects = ["artifact_bytes"];
  delete catalog.contracts;
  await writeFile(incompleteCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await assert.rejects(
    loadContractCatalog({ catalogPath: incompleteCatalogPath }),
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
