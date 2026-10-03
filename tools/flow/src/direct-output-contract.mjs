import { readFileSync } from "node:fs";
import { digest, freezeCanonical } from "./canonical.mjs";

export function directOutputContract(intent) {
  const task = intent.delegate_input?.task_inputs;
  let schema;
  if (task?.phase === "apply") {
    const evidence = JSON.parse(readFileSync(new URL("../../../config/flow/schemas/flow.feature-criterion-evidence.v1.schema.json", import.meta.url), "utf8"));
    const { $id, $schema, ...shape } = evidence;
    schema = { type: "object", additionalProperties: false, required: ["schema", "observation", "feature_evidence"],
      properties: { schema: { const: "flow.delegate-evidence/v1" }, observation: { type: "string", maxLength: 2048 }, feature_evidence: shape } };
  } else if (task?.phase === "critique") {
    const source = JSON.parse(readFileSync(new URL("../../../config/flow/schemas/flow.feature-critique-output.v1.schema.json", import.meta.url), "utf8"));
    const { $id, $schema, ...shape } = source; schema = shape;
  } else {
    const error = new Error("unsupported_direct_output_contract"); error.code = error.message; throw error;
  }
  const identity = { schemas: intent.delegate_output_schemas, schema };
  return freezeCanonical({ ...identity, contract_digest: digest(identity) });
}
