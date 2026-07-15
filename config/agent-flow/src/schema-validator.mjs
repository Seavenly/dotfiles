import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

const CONTRACT_FILES = new Map([
  ["agent-flow.run/v1", "agent-flow.run.v1.schema.json"],
  ["agent-flow.graph/v1", "agent-flow.graph.v1.schema.json"],
  ["agent-flow.gate/v1", "agent-flow.gate.v1.schema.json"],
  [
    "agent-flow.command-result/v1",
    "agent-flow.command-result.v1.schema.json",
  ],
  [
    "agent-flow.migration-receipt/v1",
    "agent-flow.migration-receipt.v1.schema.json",
  ],
  ["agent-flow.validation/v1", "agent-flow.validation.v1.schema.json"],
  [
    "agent-flow.task-authority/v1",
    "agent-flow.task-authority.v1.schema.json",
  ],
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
  ["agent-flow.gate/v1", validateGate],
  ["agent-flow.migration-receipt/v1", validateMigrationReceipt],
  ["agent-flow.validation/v1", validateValidationEnvelope],
]);

function validateRunManifest(document) {
  const errors = [];
  const kinds = new Set(document.inputs.map(({ kind }) => kind));
  const required = ["gate", "skill", "role-contract"];
  if (document.identity.flow === "review") required.push("review-manifest");
  for (const kind of required) {
    if (kinds.has(kind)) continue;
    errors.push({
      instancePath: "/inputs",
      keyword: "requiredInputKind",
      message: `must include at least one ${kind} input`,
    });
  }

  const requiredContracts = [
    "agent-flow.run/v1",
    "agent-flow.graph/v1",
    "agent-flow.gate/v1",
    "agent-flow.command-result/v1",
    "agent-flow.handoff/v1",
    "agent-flow.validation/v1",
    "agent-flow.task-authority/v1",
    "agent-flow.migration-receipt/v1",
  ];
  if (document.identity.flow === "review") {
    requiredContracts.push("agent-flow.local-review/v1");
  }
  for (const contract of requiredContracts) {
    if (document.implementation.compatible_contracts.includes(contract)) continue;
    errors.push({
      instancePath: "/implementation/compatible_contracts",
      keyword: "requiredContract",
      message: `must declare compatibility with ${contract}`,
    });
  }

  const { identity } = document;
  if (identity.artifact_directory !== join(identity.run_directory, "artifacts")) {
    errors.push({
      instancePath: "/identity/artifact_directory",
      keyword: "canonicalRunPath",
      message: "must be the artifacts directory beneath run_directory",
    });
  }
  if (identity.validation_directory !== join(identity.run_directory, "validated")) {
    errors.push({
      instancePath: "/identity/validation_directory",
      keyword: "canonicalRunPath",
      message: "must be the validated directory beneath run_directory",
    });
  }
  const expectedTenant = identity.parent_run_id ?? identity.run_id;
  if (identity.tenant !== expectedTenant) {
    errors.push({
      instancePath: "/identity/tenant",
      keyword: "tenantIdentity",
      message: "must equal parent_run_id for a child run or run_id otherwise",
    });
  }
  if (identity.supersedes === identity.run_id) {
    errors.push({
      instancePath: "/identity/supersedes",
      keyword: "distinctRun",
      message: "must not supersede the current run",
    });
  }
  if (identity.parent_run_id === identity.run_id) {
    errors.push({
      instancePath: "/identity/parent_run_id",
      keyword: "distinctRun",
      message: "must not name the current run as its parent",
    });
  }
  if (document.graph.flow !== identity.flow) {
    errors.push({
      instancePath: "/graph/flow",
      keyword: "flowIdentity",
      message: "must match identity.flow",
    });
  }
  if (!pathIsWithin(identity.run_directory, document.graph.sealed_path)) {
    errors.push({
      instancePath: "/graph/sealed_path",
      keyword: "sealedContainment",
      message: "must be contained by identity.run_directory",
    });
  }
  const inputsDirectory = join(identity.run_directory, "inputs");
  if (!pathIsWithin(inputsDirectory, document.graph.sealed_path)) {
    errors.push({
      instancePath: "/graph/sealed_path",
      keyword: "sealedInputContainment",
      message: "must be contained by the canonical inputs directory",
    });
  }
  for (const [index, root] of document.approved_read_roots.entries()) {
    if (
      pathIsWithin(identity.run_directory, root) ||
      pathIsWithin(identity.repository.path, root)
    ) {
      continue;
    }
    errors.push({
      instancePath: `/approved_read_roots/${index}`,
      keyword: "readRootContainment",
      message: "must be contained by the run directory or repository path",
    });
  }
  for (const [index, root] of document.approved_artifact_roots.entries()) {
    if (pathIsWithin(identity.artifact_directory, root)) continue;
    errors.push({
      instancePath: `/approved_artifact_roots/${index}`,
      keyword: "artifactRootContainment",
      message: "must be contained by identity.artifact_directory",
    });
  }

  const inputIdentities = new Set();
  const sealedPaths = new Set();
  for (const [index, input] of document.inputs.entries()) {
    if (!pathIsWithin(identity.run_directory, input.sealed_path)) {
      errors.push({
        instancePath: `/inputs/${index}/sealed_path`,
        keyword: "sealedContainment",
        message: "must be contained by identity.run_directory",
      });
    }
    if (!pathIsWithin(inputsDirectory, input.sealed_path)) {
      errors.push({
        instancePath: `/inputs/${index}/sealed_path`,
        keyword: "sealedInputContainment",
        message: "must be contained by the canonical inputs directory",
      });
    }
    const inputIdentity = `${input.kind}\0${input.name}`;
    if (inputIdentities.has(inputIdentity)) {
      errors.push({
        instancePath: `/inputs/${index}`,
        keyword: "uniqueInputIdentity",
        message: "must have a unique kind and name",
      });
    }
    if (sealedPaths.has(input.sealed_path)) {
      errors.push({
        instancePath: `/inputs/${index}/sealed_path`,
        keyword: "uniqueSealedPath",
        message: "must be unique within the manifest",
      });
    }
    inputIdentities.add(inputIdentity);
    sealedPaths.add(input.sealed_path);
  }

  const requiredProfiles = new Set(document.profiles.required);
  const fingerprintedProfiles = new Set(Object.keys(document.profiles.fingerprints));
  if (!setsEqual(requiredProfiles, fingerprintedProfiles)) {
    errors.push({
      instancePath: "/profiles/fingerprints",
      keyword: "completeProfileSet",
      message: "must contain exactly the profiles named by profiles.required",
    });
  }
  if (
    identity.flow === "review" &&
    (document.revisions.base === null || document.revisions.source === null)
  ) {
    errors.push({
      instancePath: "/revisions",
      keyword: "flowRevisions",
      message: "review runs require base and source revisions",
    });
  }
  if (Object.values(document.revisions).every((revision) => revision === null)) {
    errors.push({
      instancePath: "/revisions",
      keyword: "flowRevisions",
      message: "must include at least one pinned revision",
    });
  }
  return errors;
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
  if (errors.length === 0) {
    validateExecutableTopology(
      document.stages,
      document.dependencies,
      document.root,
      errors,
    );
  }
  const staticGraphValid = errors.length === 0;

  const transitionKeys = new Set();
  const allStageKeys = new Set(stages);
  for (const [transitionIndex, transition] of document.transitions.entries()) {
    const priorErrorCount = errors.length;
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
    } else if (
      document.stages.find(({ key }) => key === transition.from).profile !==
      "flow-controller"
    ) {
      errors.push({
        instancePath: `/transitions/${transitionIndex}/from`,
        keyword: "transitionController",
        message: "must name a flow-controller stage",
      });
    }
    const transitionStages = new Set(stages);
    const localStageKeys = new Set();
    for (const [stageIndex, stage] of transition.stages.entries()) {
      if (allStageKeys.has(stage.key)) {
        errors.push({
          instancePath: `/transitions/${transitionIndex}/stages/${stageIndex}/key`,
          keyword: "uniqueStageKey",
          message: "must be unique across static and transition stages",
        });
      }
      transitionStages.add(stage.key);
      localStageKeys.add(stage.key);
      allStageKeys.add(stage.key);
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
    const combinedDependencies = [
      ...document.dependencies,
      ...transition.dependencies,
    ];
    if (staticGraphValid && errors.length === priorErrorCount) {
      if (graphHasCycle(transitionStages, combinedDependencies)) {
        errors.push({
          instancePath: `/transitions/${transitionIndex}/dependencies`,
          keyword: "acyclic",
          message: "must not create a dependency cycle",
        });
        continue;
      }
      for (const stageKey of localStageKeys) {
        if (hasPath(stageKey, transition.from, combinedDependencies)) continue;
        errors.push({
          instancePath: `/transitions/${transitionIndex}/dependencies`,
          keyword: "transitionLinkage",
          message: "every transition stage must lead back to its controller",
        });
        break;
      }
      if (errors.length === 0) {
        validateHandoffExpansion(
          [...document.stages, ...transition.stages],
          combinedDependencies,
          errors,
          `/transitions/${transitionIndex}`,
        );
      }
    }
  }
  return errors;
}

function validateExecutableTopology(stages, dependencies, root, errors) {
  const rootStage = stages.find(({ key }) => key === root);
  if (
    rootStage.profile !== "flow-controller" ||
    rootStage.optional ||
    rootStage.semantic_measurement ||
    rootStage.validates_handoff_for !== null
  ) {
    errors.push({
      instancePath: "/root",
      keyword: "rootStage",
      message: "must name a required non-measurement flow-controller stage",
    });
  }
  if (dependencies.some(({ parent }) => parent === root)) {
    errors.push({
      instancePath: "/root",
      keyword: "terminalRoot",
      message: "must not have outgoing dependencies",
    });
  }
  for (const stage of stages) {
    if (stage.key === root || hasPath(stage.key, root, dependencies)) continue;
    errors.push({
      instancePath: `/stages/${stages.indexOf(stage)}/key`,
      keyword: "rootReachability",
      message: "must reach the graph root",
    });
  }
  validateHandoffExpansion(stages, dependencies, errors, "");
}

function validateHandoffExpansion(stages, dependencies, errors, prefix) {
  const byKey = new Map(stages.map((stage) => [stage.key, stage]));
  for (const stage of stages) {
    const children = dependencies
      .filter(({ parent }) => parent === stage.key)
      .map(({ child }) => byKey.get(child));
    if (
      stage.profile !== "gate" &&
      children.length > 0 &&
      children.some((child) => child?.validates_handoff_for !== stage.key)
    ) {
      errors.push({
        instancePath: `${prefix}/dependencies`,
        keyword: "handoffValidationExpansion",
        message:
          `every dependency from ${stage.key} must first enter ` +
          "its handoff validator",
      });
    }
    if (stage.validates_handoff_for === null) continue;
    const producer = byKey.get(stage.validates_handoff_for);
    const incoming = dependencies.filter(({ child }) => child === stage.key);
    if (
      !producer ||
      producer.profile === "gate" ||
      stage.profile !== "gate" ||
      stage.skill !== "handoff-validator" ||
      stage.workspace !== "run-dir" ||
      stage.optional ||
      stage.semantic_measurement ||
      incoming.length !== 1 ||
      incoming[0].parent !== stage.validates_handoff_for
    ) {
      errors.push({
        instancePath: `${prefix}/stages`,
        keyword: "handoffValidator",
        message: `${stage.key} must be the dedicated gate for its worker producer`,
      });
    }
  }
}

function validateGate(document) {
  const errors = [];
  if (!document.read_roots.some((root) => pathIsWithin(root, document.workspace))) {
    errors.push({
      instancePath: "/workspace",
      keyword: "readContainment",
      message: "must be contained by a declared read root",
    });
  }
  for (const [index, input] of document.inputs.entries()) {
    if (document.read_roots.some((root) => pathIsWithin(root, input))) continue;
    errors.push({
      instancePath: `/inputs/${index}`,
      keyword: "readContainment",
      message: "must be contained by a declared read root",
    });
  }
  for (const [index, output] of document.outputs.entries()) {
    if (pathIsWithin(document.write_root, output)) continue;
    errors.push({
      instancePath: `/outputs/${index}`,
      keyword: "writeContainment",
      message: "must be contained by write_root",
    });
  }
  const commandOutputs = new Set();
  for (const [index, command] of (document.commands ?? []).entries()) {
    if (command.cwd !== document.workspace) {
      errors.push({
        instancePath: `/commands/${index}/cwd`,
        keyword: "workspacePin",
        message: "must equal the gate workspace",
      });
    }
    if (!pathIsWithin(document.write_root, command.output_path)) {
      errors.push({
        instancePath: `/commands/${index}/output_path`,
        keyword: "writeContainment",
        message: "must be contained by write_root",
      });
    }
    if (!document.outputs.includes(command.output_path)) {
      errors.push({
        instancePath: `/commands/${index}/output_path`,
        keyword: "declaredOutput",
        message: "must also appear in the gate outputs",
      });
    }
    if (commandOutputs.has(command.output_path)) {
      errors.push({
        instancePath: `/commands/${index}/output_path`,
        keyword: "uniqueCommandOutput",
        message: "must be unique within the gate commands",
      });
    }
    commandOutputs.add(command.output_path);
  }
  return errors;
}

function validateMigrationReceipt(document) {
  const dimensions = [
    ["contract_version", new Set(["contract"])],
    ["implementation_revision", new Set(["implementation"])],
    ["profile_set_fingerprint", new Set(["profile"])],
    [
      "content_set_fingerprint",
      new Set(["graph", "gate", "input", "skill", "role-contract"]),
    ],
  ];
  const changedDimensions = dimensions.filter(
    ([field]) => document.from[field] !== document.to[field],
  );
  if (changedDimensions.length === 0) {
    return [{
        instancePath: "/to",
        keyword: "migrationChange",
        message: "must differ from the prior compatibility identity",
    }];
  }
  const allowedKinds = new Set(
    changedDimensions.flatMap(([, kinds]) => [...kinds]),
  );
  for (const [index, change] of document.changes.entries()) {
    if (change.prior_sha256 === change.next_sha256) {
      return [{
        instancePath: `/changes/${index}/next_sha256`,
        keyword: "migrationChange",
        message: "must differ from the prior digest",
      }];
    }
    if (!allowedKinds.has(change.kind)) {
      return [{
        instancePath: `/changes/${index}/kind`,
        keyword: "migrationDimension",
        message: "must correspond to a changed compatibility dimension",
      }];
    }
  }
  const changeKinds = new Set(document.changes.map(({ kind }) => kind));
  for (const [field, kinds] of changedDimensions) {
    if ([...kinds].some((kind) => changeKinds.has(kind))) continue;
    return [{
      instancePath: "/changes",
      keyword: "migrationDimension",
      message: `must explain the ${field} change`,
    }];
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
    if (
      artifact.expected_sha256 !== artifact.actual_sha256 ||
      !artifact.valid ||
      artifact.path === null
    ) {
      return [
        {
          instancePath: `/artifacts/${index}`,
          keyword: "artifactHash",
          message: "must contain matching verified digests",
        },
      ];
    }
    if (
      !document.approved_artifact_roots.some((root) =>
        pathIsWithin(root, artifact.source_path),
      )
    ) {
      return [
        {
          instancePath: `/artifacts/${index}/source_path`,
          keyword: "artifactContainment",
          message: "must be contained by an approved artifact root",
        },
      ];
    }
    if (!pathIsWithin(document.validated_artifact_root, artifact.path)) {
      return [
        {
          instancePath: `/artifacts/${index}/path`,
          keyword: "validatedArtifactContainment",
          message: "must be contained by validated_artifact_root",
        },
      ];
    }
  }
  return [];
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function hasPath(from, to, dependencies) {
  const children = new Map();
  for (const { parent, child } of dependencies) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const pending = [from];
  const visited = new Set();
  while (pending.length > 0) {
    const stage = pending.pop();
    if (stage === to) return true;
    if (visited.has(stage)) continue;
    visited.add(stage);
    pending.push(...(children.get(stage) ?? []));
  }
  return false;
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
