import { readFile } from "node:fs/promises";

import {
  QUALIFICATION_EVIDENCE_REQUIRED_FIELDS,
} from "./qualification-contracts.mjs";

const CATALOG_URL = new URL("../qualification/catalog.v1.json", import.meta.url);

const OUTCOME_KINDS = ["positive", "negative", "uncertain", "recovery"];
const EXECUTION_KINDS = ["deterministic_trace_replay", "real_herdr_harness"];

function requireCondition(condition, message) {
  if (!condition) throw new Error(`invalid qualification catalog: ${message}`);
}

function requireString(value, path) {
  requireCondition(typeof value === "string" && value.length > 0, `${path} must be a non-empty string`);
}

function requireNonEmptyStrings(value, path) {
  requireCondition(Array.isArray(value) && value.length > 0, `${path} must be a non-empty array`);
  value.forEach((item, index) => requireString(item, `${path}[${index}]`));
}

function validateShape(shape, expectedSchema, path) {
  requireCondition(shape?.schema === expectedSchema, `${path}.schema must be ${expectedSchema}`);
  requireNonEmptyStrings(shape.required_fields, `${path}.required_fields`);
  requireCondition(shape.fields && typeof shape.fields === "object", `${path}.fields must be an object`);
  for (const field of shape.required_fields) {
    requireString(shape.fields[field], `${path}.fields.${field}`);
  }
}

export async function loadQualificationCatalog(url = CATALOG_URL) {
  return JSON.parse(await readFile(url, "utf8"));
}

export function validateQualificationCatalog(catalog) {
  requireCondition(catalog?.schema === "drovr.qualification-catalog/v1", "unsupported schema");
  requireCondition(catalog.version === 1, "version must be 1");

  validateShape(
    catalog.contracts?.qualification_evidence,
    "drovr.qualification-evidence/v1",
    "contracts.qualification_evidence",
  );
  requireCondition(
    JSON.stringify(catalog.contracts.qualification_evidence.required_fields) ===
      JSON.stringify(QUALIFICATION_EVIDENCE_REQUIRED_FIELDS),
    "contracts.qualification_evidence.required_fields must match the runner contract",
  );
  requireNonEmptyStrings(
    catalog.execution_policy?.live_default_configuration,
    "execution_policy.live_default_configuration",
  );
  requireNonEmptyStrings(
    catalog.execution_policy?.prompt_policy,
    "execution_policy.prompt_policy",
  );
  requireString(
    catalog.execution_policy?.deviation_policy,
    "execution_policy.deviation_policy",
  );
  validateShape(
    catalog.contracts?.cleanup_receipt,
    "drovr.qualification-cleanup-receipt/v1",
    "contracts.cleanup_receipt",
  );

  const invariantIds = Object.keys(catalog.safety_invariants ?? {}).sort();
  requireCondition(invariantIds.length > 0, "safety_invariants must be non-empty");
  for (const [id, description] of Object.entries(catalog.safety_invariants)) {
    requireString(description, `safety_invariants.${id}`);
  }

  requireCondition(Array.isArray(catalog.known_incidents), "known_incidents must be an array");
  requireCondition(catalog.known_incidents.length > 0, "known_incidents must be non-empty");
  const incidentIds = new Set();
  for (const incident of catalog.known_incidents) {
    requireString(incident.id, "known_incidents.id");
    requireCondition(!incidentIds.has(incident.id), `duplicate incident ${incident.id}`);
    incidentIds.add(incident.id);
  }

  requireCondition(Array.isArray(catalog.scenarios) && catalog.scenarios.length > 0, "scenarios must be non-empty");
  const scenarioIds = new Set();
  const executionKinds = new Set();
  for (const scenario of catalog.scenarios) {
    requireString(scenario.id, "scenario.id");
    requireCondition(!scenarioIds.has(scenario.id), `duplicate scenario ${scenario.id}`);
    scenarioIds.add(scenario.id);
    requireString(scenario.title, `${scenario.id}.title`);
    requireString(scenario.observed_failure, `${scenario.id}.observed_failure`);
    requireCondition(EXECUTION_KINDS.includes(scenario.execution?.kind), `${scenario.id}.execution.kind is invalid`);
    executionKinds.add(scenario.execution.kind);
    requireString(scenario.execution.rationale, `${scenario.id}.execution.rationale`);
    if (scenario.execution.kind === "real_herdr_harness") {
      requireCondition(
        typeof scenario.execution.unattended === "boolean",
        `${scenario.id}.execution.unattended must be boolean`,
      );
      requireNonEmptyStrings(scenario.execution.harnesses, `${scenario.id}.execution.harnesses`);
      requireCondition(Number.isInteger(scenario.execution.limits?.max_turns), `${scenario.id} needs max_turns`);
      requireCondition(Number.isInteger(scenario.execution.limits?.max_retries), `${scenario.id} needs max_retries`);
      requireString(scenario.execution.limits?.max_elapsed, `${scenario.id}.execution.limits.max_elapsed`);
    }
    requireNonEmptyStrings(scenario.public_commands, `${scenario.id}.public_commands`);
    scenario.public_commands.forEach((command) => requireCondition(command.startsWith("drovr "), `${scenario.id} uses a non-public command`));
    requireNonEmptyStrings(scenario.preconditions, `${scenario.id}.preconditions`);
    requireCondition(scenario.expected_outcomes && typeof scenario.expected_outcomes === "object", `${scenario.id}.expected_outcomes is required`);
    for (const kind of OUTCOME_KINDS) {
      const outcomes = scenario.expected_outcomes[kind];
      requireCondition(Array.isArray(outcomes) && outcomes.length > 0, `${scenario.id}.expected_outcomes.${kind} must be non-empty`);
      for (const [index, outcome] of outcomes.entries()) {
        requireString(outcome.status, `${scenario.id}.${kind}[${index}].status`);
        requireString(outcome.when, `${scenario.id}.${kind}[${index}].when`);
      }
    }
    if (scenario.expected_outcomes.positive.some(({ status }) => status === "cleared")) {
      requireString(
        scenario.execution.limits?.stability_interval,
        `${scenario.id}.execution.limits.stability_interval`,
      );
    }
    requireNonEmptyStrings(scenario.safety_invariants, `${scenario.id}.safety_invariants`);
    scenario.safety_invariants.forEach((id) => requireCondition(invariantIds.includes(id), `${scenario.id} references unknown invariant ${id}`));
    requireNonEmptyStrings(scenario.prohibited_mutations, `${scenario.id}.prohibited_mutations`);
    requireNonEmptyStrings(scenario.cleanup_obligations, `${scenario.id}.cleanup_obligations`);
    requireNonEmptyStrings(scenario.evidence_requirements, `${scenario.id}.evidence_requirements`);
  }

  for (const incident of catalog.known_incidents) {
    requireString(incident.summary, `known_incidents.${incident.id}.summary`);
    requireNonEmptyStrings(incident.scenarios, `known_incidents.${incident.id}.scenarios`);
    requireNonEmptyStrings(incident.source_evidence, `known_incidents.${incident.id}.source_evidence`);
    incident.scenarios.forEach((id) => requireCondition(scenarioIds.has(id), `${incident.id} references unknown scenario ${id}`));
  }
  const coveredScenarioIds = new Set(
    catalog.known_incidents.flatMap(({ scenarios }) => scenarios),
  );
  scenarioIds.forEach((id) =>
    requireCondition(coveredScenarioIds.has(id), `scenario ${id} is not tied to a known incident`),
  );

  requireCondition(
    JSON.stringify([...executionKinds].sort()) === JSON.stringify(EXECUTION_KINDS),
    "catalog must contain replay and real-harness scenarios",
  );

  return { scenario_count: scenarioIds.size, execution_kinds: [...executionKinds].sort() };
}
