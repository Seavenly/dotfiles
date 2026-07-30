import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  authorizeLegacyImport,
  loadContractCatalog,
} from "../src/contract-catalog.mjs";

const catalogPath = fileURLToPath(
  new URL("../../../config/flow/contracts/catalog.v1.json", import.meta.url),
);

test("the public catalog exposes the settled interface and forbids legacy import", async () => {
  const catalog = await loadContractCatalog({ catalogPath });

  assert.deepEqual(catalog.flow_runtime.operations, [
    "prepare",
    "launch",
    "command",
    "query",
    "watch",
  ]);
  assert.equal(
    new Set(Object.values(catalog.authority_roots)).size,
    Object.values(catalog.authority_roots).length,
  );
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

  assert.throws(
    () => authorizeLegacyImport(catalog, { adapter: "implicit" }),
    /no legacy import adapter is registered/,
  );
});
