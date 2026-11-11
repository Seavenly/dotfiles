import { readFileSync } from "node:fs";
import { FEATURE_FILE_OBSERVATION_CONTRACT } from "./feature-critique-contract.mjs";
import { digest, freezeCanonical } from "./canonical.mjs";

export function directOutputContract(intent) {
  const task = intent.delegate_input?.task_inputs;
  let schema;
  if (["apply", "critique"].includes(task?.phase) && task.file_observation_contract !== undefined) {
    if (task.file_observation_contract !== FEATURE_FILE_OBSERVATION_CONTRACT) {
      const error = new Error("unsupported_direct_output_contract"); error.code = error.message; throw error;
    }
    const name = task.phase === "apply" ? "flow.direct-feature-apply-output.v2.schema.json" : "flow.direct-feature-critique-output.v2.schema.json";
    const source = JSON.parse(readFileSync(new URL(`../../../config/flow/schemas/${name}`, import.meta.url), "utf8"));
    const { $id, $schema, ...shape } = source;
    schema = shape;
  } else if (task?.phase === "apply") {
    const evidence = JSON.parse(readFileSync(new URL("../../../config/flow/schemas/flow.feature-criterion-evidence.v1.schema.json", import.meta.url), "utf8"));
    const { $id, $schema, ...shape } = evidence;
    schema = { type: "object", additionalProperties: false, required: ["schema", "observation", "feature_evidence"],
      properties: { schema: { const: "flow.delegate-evidence/v1" }, observation: { type: "string", maxLength: 2048 }, feature_evidence: shape } };
  } else if (task?.phase === "critique") {
    const source = JSON.parse(readFileSync(new URL("../../../config/flow/schemas/flow.feature-critique-output.v1.schema.json", import.meta.url), "utf8"));
    const { $id, $schema, ...shape } = source; schema = shape;
  } else if (task?.flow === "spike/v2" && task.schema === "flow.delegate-task-inputs/v1" &&
      ["research", "synthesis"].includes(task.phase) &&
      intent.delegate_output_schemas?.length === 1 && intent.delegate_output_schemas[0] ===
        (task.phase === "research" ? "flow.spike-research-evidence/v2" : "flow.spike-report/v2")) {
    const name = task.phase === "research" ? "research" : "report";
    const source = JSON.parse(readFileSync(new URL(`../../../config/flow/schemas/flow.spike-${name}-output.v2.schema.json`, import.meta.url), "utf8"));
    const { $id, $schema, ...shape } = source;
    schema = shape;
    schema.properties.question_id = { const: task.packet.question.id };
  } else if (isLocalReviewTask(task, intent.delegate_output_schemas)) {
    const source = JSON.parse(readFileSync(new URL("../../../config/flow/schemas/flow.review-result.v1.schema.json", import.meta.url), "utf8"));
    const { $id, $schema, ...shape } = source;
    schema = shape;
    // A lens may omit its name and inherit the selected lens from semantic
    // validation. An explicit name must still match; critics name each finding.
    if (task.role === "lens") {
      schema.$defs.finding.properties.lens = { const: task.lens };
    } else {
      schema.$defs.finding.required = ["lens"];
    }
  } else {
    const error = new Error("unsupported_direct_output_contract"); error.code = error.message; throw error;
  }
  const identity = { schemas: intent.delegate_output_schemas, schema };
  return freezeCanonical({ ...identity, contract_digest: digest(identity) });
}

function isLocalReviewTask(task, schemas) {
  if (task?.schema !== "flow.delegate-task-inputs/v1" ||
      task.flow !== "review/v1" || task.phase !== undefined ||
      task.target?.schema !== "flow.review-local-candidate/v1" ||
      !Array.isArray(schemas) || schemas.length !== 1 ||
      schemas[0] !== "flow.review-result/v1") return false;
  if (task.role === "lens") return isLens(task.lens);
  return task.role === "critic" && Array.isArray(task.lenses) &&
    task.lenses.length > 0 && task.lenses.every(isLens) &&
    new Set(task.lenses).size === task.lenses.length;
}

function isLens(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= 128 && value === value.trim();
}
