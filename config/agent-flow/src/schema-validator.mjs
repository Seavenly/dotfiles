import { readFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

const CONTRACT_FILES = new Map([
  ["agent-flow.run/v1", "agent-flow.run.v1.schema.json"],
  ["agent-flow.graph/v1", "agent-flow.graph.v1.schema.json"],
  ["agent-flow.gate/v1", "agent-flow.gate.v1.schema.json"],
  [
    "agent-flow.migration-receipt/v1",
    "agent-flow.migration-receipt.v1.schema.json",
  ],
  ["agent-flow.validation/v1", "agent-flow.validation.v1.schema.json"],
  ["agent-flow.handoff/v1", "agent-flow.handoff.v1.schema.json"],
  ["agent-flow.local-review/v1", "agent-flow.local-review.v1.schema.json"],
]);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validatorPromises = new Map();

async function contractValidator(schemaName) {
  if (!CONTRACT_FILES.has(schemaName)) return null;
  if (!validatorPromises.has(schemaName)) {
    validatorPromises.set(
      schemaName,
      (async () => {
        const path = new URL(
          `../schemas/${CONTRACT_FILES.get(schemaName)}`,
          import.meta.url,
        );
        const schema = JSON.parse(await readFile(path, "utf8"));
        return ajv.compile(schema);
      })(),
    );
  }
  return validatorPromises.get(schemaName);
}

export async function validateContract(document) {
  const schemaName = document?.schema;
  const validate = await contractValidator(schemaName);
  if (!validate) {
    return {
      valid: false,
      errors: [
        {
          instancePath: "/schema",
          keyword: "enum",
          message: `unsupported contract: ${schemaName ?? "missing"}`,
        },
      ],
    };
  }

  if (!validate(document)) {
    return {
      valid: false,
      errors: validate.errors.map(({ instancePath, keyword, message, params }) => ({
        instancePath,
        keyword,
        message,
        params,
      })),
    };
  }

  const semanticErrors = validateSemanticContract(document);
  return { valid: semanticErrors.length === 0, errors: semanticErrors };
}

function validateSemanticContract(document) {
  return SEMANTIC_VALIDATORS.get(document.schema)?.(document) ?? [];
}

const SEMANTIC_VALIDATORS = new Map([
  ["agent-flow.run/v1", validateRunManifest],
  ["agent-flow.graph/v1", validateGraph],
  ["agent-flow.migration-receipt/v1", validateMigrationReceipt],
  ["agent-flow.validation/v1", validateValidationEnvelope],
]);

function validateRunManifest(document) {
  const kinds = new Set(document.inputs.map(({ kind }) => kind));
  const required = ["gate", "skill", "role-contract"];
  if (document.identity.flow === "review") required.push("review-manifest");
  for (const kind of required) {
    if (kinds.has(kind)) continue;
    return [
      {
        instancePath: "/inputs",
        keyword: "requiredInputKind",
        message: `must include at least one ${kind} input`,
      },
    ];
  }
  return [];
}

function validateGraph(document) {
  const errors = [];
  const stages = new Set();
  for (const [index, stage] of document.stages.entries()) {
    if (stages.has(stage.key)) {
      errors.push({
        instancePath: `/stages/${index}/key`,
        keyword: "uniqueStageKey",
        message: "must be unique within the graph",
      });
    }
    stages.add(stage.key);
  }
  for (const [index, dependency] of document.dependencies.entries()) {
    for (const field of ["parent", "child"]) {
      if (stages.has(dependency[field])) continue;
      errors.push({
        instancePath: `/dependencies/${index}/${field}`,
        keyword: "stageReference",
        message: "must name a declared stage",
      });
    }
  }
  if (!stages.has(document.root)) {
    errors.push({
      instancePath: "/root",
      keyword: "stageReference",
      message: "must name a declared stage",
    });
  }
  if (errors.length === 0 && graphHasCycle(stages, document.dependencies)) {
    errors.push({
      instancePath: "/dependencies",
      keyword: "acyclic",
      message: "must not contain a dependency cycle",
    });
  }
  const transitionKeys = new Set();
  for (const [transitionIndex, transition] of document.transitions.entries()) {
    if (transitionKeys.has(transition.key)) {
      errors.push({
        instancePath: `/transitions/${transitionIndex}/key`,
        keyword: "uniqueTransitionKey",
        message: "must be unique within the graph",
      });
    }
    transitionKeys.add(transition.key);
    if (!stages.has(transition.from)) {
      errors.push({
        instancePath: `/transitions/${transitionIndex}/from`,
        keyword: "stageReference",
        message: "must name a declared static stage",
      });
    }
    const transitionStages = new Set(stages);
    for (const [stageIndex, stage] of transition.stages.entries()) {
      if (transitionStages.has(stage.key)) {
        errors.push({
          instancePath: `/transitions/${transitionIndex}/stages/${stageIndex}/key`,
          keyword: "uniqueStageKey",
          message: "must be unique within the transition",
        });
      }
      transitionStages.add(stage.key);
    }
    for (const [dependencyIndex, dependency] of
      transition.dependencies.entries()) {
      for (const field of ["parent", "child"]) {
        if (transitionStages.has(dependency[field])) continue;
        errors.push({
          instancePath:
            `/transitions/${transitionIndex}/dependencies/` +
            `${dependencyIndex}/${field}`,
          keyword: "stageReference",
          message: "must name a static or transition stage",
        });
      }
    }
    if (
      errors.length === 0 &&
      graphHasCycle(transitionStages, [
        ...document.dependencies,
        ...transition.dependencies,
      ])
    ) {
      errors.push({
        instancePath: `/transitions/${transitionIndex}/dependencies`,
        keyword: "acyclic",
        message: "must not create a dependency cycle",
      });
    }
  }
  return errors;
}

function validateMigrationReceipt(document) {
  const identityChanged =
    document.from.contract_version !== document.to.contract_version ||
    document.from.implementation_revision !== document.to.implementation_revision ||
    document.from.profile_set_fingerprint !== document.to.profile_set_fingerprint;
  if (!identityChanged) {
    return [
      {
        instancePath: "/to",
        keyword: "migrationChange",
        message: "must differ from the prior compatibility identity",
      },
    ];
  }
  for (const [index, change] of document.changes.entries()) {
    if (change.prior_sha256 !== change.next_sha256) continue;
    return [
      {
        instancePath: `/changes/${index}/next_sha256`,
        keyword: "migrationChange",
        message: "must differ from the prior digest",
      },
    ];
  }
  return [];
}

function validateValidationEnvelope(document) {
  if (!document.valid) return [];
  for (const field of ["run_id", "stage", "attempt"]) {
    if (document.identity[field] === document[field]) continue;
    return [
      {
        instancePath: `/identity/${field}`,
        keyword: "identityMatch",
        message: "must match the validation envelope",
      },
    ];
  }
  if (document.semantic.required && typeof document.semantic.passed !== "boolean") {
    return [
      {
        instancePath: "/semantic/passed",
        keyword: "semanticMeasurement",
        message: "must be boolean when a semantic measurement is required",
      },
    ];
  }
  for (const [index, artifact] of document.artifacts.entries()) {
    if (artifact.expected_sha256 !== artifact.actual_sha256 || !artifact.valid) {
      return [
        {
          instancePath: `/artifacts/${index}`,
          keyword: "artifactHash",
          message: "must contain matching verified digests",
        },
      ];
    }
    if (
      !document.artifact_roots.some((root) => pathIsWithin(root, artifact.path))
    ) {
      return [
        {
          instancePath: `/artifacts/${index}/path`,
          keyword: "artifactContainment",
          message: "must be contained by an approved artifact root",
        },
      ];
    }
  }
  return [];
}

function pathIsWithin(root, path) {
  const candidate = relative(root, path);
  return (
    candidate === "" ||
    (candidate !== ".." &&
      !candidate.startsWith(`..${sep}`) &&
      !isAbsolute(candidate))
  );
}

function graphHasCycle(stages, dependencies) {
  const children = new Map([...stages].map((stage) => [stage, []]));
  const indegree = new Map([...stages].map((stage) => [stage, 0]));
  for (const { parent, child } of dependencies) {
    children.get(parent).push(child);
    indegree.set(child, indegree.get(child) + 1);
  }
  const ready = [...stages].filter((stage) => indegree.get(stage) === 0);
  let visited = 0;
  while (ready.length > 0) {
    const stage = ready.pop();
    visited += 1;
    for (const child of children.get(stage)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) ready.push(child);
    }
  }
  return visited !== stages.size;
}
