import { readFile } from "node:fs/promises";

import { isExactSequence } from "./validation.mjs";

const FLOW_RUNTIME_OPERATIONS = [
  "prepare",
  "launch",
  "command",
  "query",
  "watch",
];

export async function loadContractCatalog({ catalogPath }) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (catalog.schema !== "flow.contract-catalog/v1") {
    throw new Error(`unsupported contract catalog: ${catalog.schema ?? "missing"}`);
  }
  if (!isExactSequence(catalog.flow_runtime?.operations, FLOW_RUNTIME_OPERATIONS)) {
    throw new Error("contract catalog must expose exactly the five FlowRuntime operations");
  }
  const roots = Object.values(catalog.authority_roots ?? {});
  if (roots.length === 0 || new Set(roots).size !== roots.length) {
    throw new Error("contract catalog authority roots must be disjoint");
  }
  return catalog;
}

export function authorizeLegacyImport(catalog, { adapter }) {
  const registered = catalog.legacy_import?.adapters ?? [];
  if (registered.length === 0) {
    throw new Error("no legacy import adapter is registered");
  }
  if (!registered.includes(adapter)) {
    throw new Error(`legacy import adapter is not registered: ${adapter}`);
  }
  return { adapter, authorized: true };
}
