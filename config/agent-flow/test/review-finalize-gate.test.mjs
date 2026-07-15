import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli-command.mjs";
import { validateContract } from "../src/schema-validator.mjs";

const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GIT_SHA = "0123456789abcdef0123456789abcdef01234567";

test("agent-flow gate deterministically finalizes validated review comments", async (t) => {
  const fixture = await reviewFinalizeFixture(t);
  const stdout = captureStream();
  const stderr = captureStream();

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: stdout.stream,
    stderr: stderr.stream,
  }), 0, stderr.value());

  assert.equal(stdout.value(), "ok - review-finalize gate passed\n");
  assert.equal(stderr.value(), "");
  const resultBytes = await readFile(fixture.outputs.result, "utf8");
  const result = JSON.parse(resultBytes);
  assert.deepEqual(await validateContract(result), { valid: true, errors: [] });
  assert.equal(result.counts.input, 6);
  assert.equal(result.counts.included, 3);
  assert.deepEqual(result.counts.by_tier, {
    critical: 2,
    important: 1,
    recommended: 0,
    nit: 0,
  });
  assert.equal(result.counts.dropped_by_tier_cap.important, 1);
  assert.equal(result.counts.dropped_by_total_cap.recommended, 1);
  assert.equal(result.counts.dropped_by_total_cap.nit, 1);
  assert.match(result.findings[0].id, /^finding-[0-9a-f]{16}$/);
  assert.deepEqual(
    result.supplements.map(({ kind }) => kind),
    ["orientation", "diagram", "lens:style", "lens:observability"],
  );
  assert.equal(result.supplements.every(({ passed }) => passed), true);

  const draft = JSON.parse(await readFile(fixture.outputs.draft, "utf8"));
  assert.equal("event" in draft, false);
  assert.equal(draft.comments.length, 3);
  assert.match(draft.body, /Start with the run authority/);
  assert.match(draft.body, /diagram\.mmd/);
  assert.match(draft.body, /lens:style/);
  assert.match(draft.body, /Dropped 1 important by per-tier cap/);
  assert.match(draft.comments[0].body, new RegExp(result.findings[0].id));
  const html = await readFile(fixture.outputs.html, "utf8");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /The boundary needs one source of truth/);
  assert.match(html, /diagram\.mmd/);
  assert.match(html, /lens:style/);
  const markdown = await readFile(fixture.outputs.markdown, "utf8");
  assert.match(markdown, /## Orientation/);
  assert.match(markdown, /## Supplemental lens evidence/);

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: captureStream().stream,
  }), 0);
  assert.equal(await readFile(fixture.outputs.result, "utf8"), resultBytes);
});

test("review-finalize accepts validator-owned inline critic snapshots", async (t) => {
  const fixture = await reviewFinalizeFixture(t, { inlineCritic: true });
  const stderr = captureStream();

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: stderr.stream,
  }), 0, stderr.value());

  const result = JSON.parse(await readFile(fixture.outputs.result, "utf8"));
  assert.equal(result.source.attempt, 1);
  assert.equal(result.counts.input, 6);
});

test("review-finalize rejects changed inline content after validation", async (t) => {
  const fixture = await reviewFinalizeFixture(t, { inlineCritic: true });
  fixture.criticHandoff.artifacts[0].inline.cluster = "Fabricated after validation.";
  const evidence = JSON.parse(await readFile(fixture.commentsEvidence, "utf8"));
  evidence.source_metadata_sha256 = sha256(JSON.stringify({
    handoff: fixture.criticHandoff,
  }));
  await writeFile(fixture.commentsEvidence, JSON.stringify(evidence));
  const stderr = captureStream();

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: stderr.stream,
  }), 1);

  assert.match(stderr.value(), /does not match producer artifacts/);
  await assert.rejects(readFile(fixture.outputs.result), { code: "ENOENT" });
});

test("review-finalize rejects changed validated artifact bytes", async (t) => {
  const fixture = await reviewFinalizeFixture(t);
  await writeFile(fixture.commentsSnapshot, JSON.stringify({ fabricated: true }));
  const stderr = captureStream();

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: stderr.stream,
  }), 1);

  assert.match(stderr.value(), /digest changed after validation/);
  await assert.rejects(readFile(fixture.outputs.result), { code: "ENOENT" });
});

test("review-finalize rejects evidence with caller-selected authority roots", async (t) => {
  const fixture = await reviewFinalizeFixture(t);
  const evidence = JSON.parse(await readFile(fixture.commentsEvidence, "utf8"));
  evidence.approved_artifact_roots = [
    dirname(dirname(evidence.artifacts[0].source_path)),
  ];
  await writeFile(fixture.commentsEvidence, JSON.stringify(evidence));
  const stderr = captureStream();

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: stderr.stream,
  }), 1);
  assert.match(stderr.value(), /different approved artifact roots/);
});

test("review-finalize rejects a self-attested producer attempt", async (t) => {
  const fixture = await reviewFinalizeFixture(t);
  const evidence = JSON.parse(await readFile(fixture.commentsEvidence, "utf8"));
  evidence.task_id = "t_fabricated";
  await writeFile(fixture.commentsEvidence, JSON.stringify(evidence));
  const stderr = captureStream();

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: stderr.stream,
  }), 1);
  assert.match(stderr.value(), /does not match the producer completed attempt/);
  await assert.rejects(readFile(fixture.outputs.result), { code: "ENOENT" });
});

test("review-finalize applies the sealed urgency floor", async (t) => {
  const fixture = await reviewFinalizeFixture(t, { urgency: "hotfix" });

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: captureStream().stream,
  }), 0);

  const result = JSON.parse(await readFile(fixture.outputs.result, "utf8"));
  assert.equal(result.counts.included, 2);
  assert.deepEqual(result.findings.map(({ tier }) => tier), ["critical", "critical"]);
  assert.equal(result.counts.dropped_by_urgency.important, 2);
  assert.equal(result.counts.dropped_by_urgency.recommended, 1);
  assert.equal(result.counts.dropped_by_urgency.nit, 1);
});

test("review-finalize renders an authoritative negative critic measurement", async (t) => {
  const fixture = await reviewFinalizeFixture(t, { criticPassed: false });

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: captureStream().stream,
  }), 0);
  const result = JSON.parse(await readFile(fixture.outputs.result, "utf8"));
  assert.equal(result.posture, "do_not_merge");
});

test("review-finalize surfaces a blocking optional lens", async (t) => {
  const fixture = await reviewFinalizeFixture(t, {
    posture: "merge_ready_with_followups",
    optionalLensPassed: false,
  });

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: captureStream().stream,
  }), 0);
  const result = JSON.parse(await readFile(fixture.outputs.result, "utf8"));
  assert.equal(result.posture, "merge_after_fixes");
  assert.match(result.posture_rationale, /Blocking supplemental lens: lens:style/);
  assert.equal(
    result.supplements.find(({ kind }) => kind === "lens:style").passed,
    false,
  );
  assert.match(await readFile(fixture.outputs.markdown, "utf8"), /lens:style \(blocking\)/);
});

test("review-finalize rejects a supplement with the wrong artifact kind", async (t) => {
  const fixture = await reviewFinalizeFixture(t);
  fixture.styleHandoff.artifacts[0].kind = "review-diagram";
  const evidence = JSON.parse(await readFile(fixture.styleEvidence, "utf8"));
  evidence.source_metadata_sha256 = sha256(JSON.stringify({
    handoff: fixture.styleHandoff,
  }));
  await writeFile(fixture.styleEvidence, JSON.stringify(evidence));
  const stderr = captureStream();

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: stderr.stream,
  }), 1);
  assert.match(stderr.value(), /exactly one review-findings artifact/);
});

test("review-finalize rejects malformed optional lens content", async (t) => {
  const fixture = await reviewFinalizeFixture(t);
  const inline = {
    lens: "style",
    summary: "Malformed producer output.",
    findings: "not-an-array",
  };
  fixture.styleHandoff.artifacts[0].inline = inline;
  const bytes = stableJsonBytes(inline);
  await writeFile(fixture.styleSnapshot, bytes);
  const evidence = JSON.parse(await readFile(fixture.styleEvidence, "utf8"));
  evidence.source_metadata_sha256 = sha256(JSON.stringify({
    handoff: fixture.styleHandoff,
  }));
  evidence.artifacts[0].expected_sha256 = sha256(bytes);
  evidence.artifacts[0].actual_sha256 = sha256(bytes);
  await writeFile(fixture.styleEvidence, JSON.stringify(evidence));
  const stderr = captureStream();

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: stderr.stream,
  }), 1);
  assert.match(stderr.value(), /does not satisfy its findings shape/);
});

test("review-finalize rejects posture that contradicts hotfix findings", async (t) => {
  const fixture = await reviewFinalizeFixture(t, {
    urgency: "hotfix",
    posture: "merge_after_fixes",
  });
  const stderr = captureStream();

  assert.equal(await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.taskId },
    stdout: captureStream().stream,
    stderr: stderr.stream,
  }), 1);
  assert.match(stderr.value(), /does not satisfy its contract/);
});

async function reviewFinalizeFixture(
  t,
  {
    urgency = "standard",
    criticPassed = true,
    posture = "do_not_merge",
    inlineCritic = false,
    optionalLensPassed = true,
  } = {},
) {
  const runDirectory = await mkdtemp(join(tmpdir(), "agent-flow-review-finalize-"));
  t.after(() => rm(runDirectory, { recursive: true, force: true }));
  const inputsDirectory = join(runDirectory, "inputs");
  const artifactsDirectory = join(runDirectory, "artifacts");
  const validationDirectory = join(runDirectory, "validated");
  await Promise.all([
    mkdir(inputsDirectory),
    mkdir(artifactsDirectory),
    mkdir(validationDirectory),
  ]);

  const comments = {
    schema: "agent-flow.review-comments/v1",
    run_id: "review-finalize-example",
    stage: "critic",
    urgency,
    posture,
    posture_rationale: "Critical issues should be fixed before merge.",
    cluster: "The boundary needs one source of truth.",
    findings: posture === "merge_ready_with_followups"
      ? [
          finding(
            "recommended",
            "maintainability",
            50,
            "Split the adapter seam.",
          ),
          finding("nit", "maintainability", 60, "Rename the local value."),
        ]
      : [
          finding("critical", "security", 10, "Escapes <script> markup."),
          finding("critical", "correctness", 20, "Loses committed state."),
          finding("important", "correctness", 30, "Accepts stale input."),
          finding("important", "testing", 40, "Misses retry coverage."),
          finding(
            "recommended",
            "maintainability",
            50,
            "Split the adapter seam.",
          ),
          finding("nit", "maintainability", 60, "Rename the local value."),
        ],
  };
  const commentsBytes = inlineCritic
    ? stableJsonBytes(comments)
    : JSON.stringify(comments);
  const commentsSnapshot = join(validationDirectory, "comments.json");
  await writeFile(commentsSnapshot, commentsBytes);
  const orientationSnapshot = join(validationDirectory, "orientation.md");
  const orientationBytes =
    "## Orientation\n\nStart with the run authority, then follow the gate.\n";
  await writeFile(orientationSnapshot, orientationBytes);
  const diagramSnapshot = join(validationDirectory, "diagram.mmd");
  const diagramBytes = "flowchart LR\n  critic --> finalize\n";
  await writeFile(diagramSnapshot, diagramBytes);
  const styleSnapshot = join(validationDirectory, "style.json");
  const style = {
    lens: "style",
    summary: "Naming follows the repository conventions.",
    findings: [],
  };
  const styleBytes = stableJsonBytes(style);
  await writeFile(styleSnapshot, styleBytes);
  const observabilitySnapshot = join(validationDirectory, "observability.json");
  const observability = {
    lens: "observability",
    summary: "Operational signals cover the changed boundary.",
    findings: [],
  };
  const observabilityBytes = stableJsonBytes(observability);
  await writeFile(observabilitySnapshot, observabilityBytes);

  const graph = {
    schema: "agent-flow.graph/v1",
    name: "local-review",
    version: 1,
    flow: "review",
    root: "review-root",
    stages: [
      stage("review-root", "flow-controller", "review-flow-controller"),
      stage("critic", "critic", "review-critic", true),
      {
        ...stage("validate-handoff:critic", "gate", "handoff-validator"),
        validates_handoff_for: "critic",
      },
      stage("orientation", "analyst", "review-orientation"),
      {
        ...stage("validate-handoff:orientation", "gate", "handoff-validator"),
        validates_handoff_for: "orientation",
      },
      stage("diagram", "artifact", "review-diagram"),
      {
        ...stage("validate-handoff:diagram", "gate", "handoff-validator"),
        validates_handoff_for: "diagram",
      },
      stage("lens:style", "analyst", "review-lens", true),
      {
        ...stage("validate-handoff:lens:style", "gate", "handoff-validator"),
        validates_handoff_for: "lens:style",
      },
      stage("lens:observability", "analyst", "review-lens", true),
      {
        ...stage(
          "validate-handoff:lens:observability",
          "gate",
          "handoff-validator",
        ),
        validates_handoff_for: "lens:observability",
      },
      stage("finalize", "gate", "review-finalizer"),
    ],
    dependencies: [
      { parent: "critic", child: "validate-handoff:critic" },
      { parent: "validate-handoff:critic", child: "finalize" },
      { parent: "orientation", child: "validate-handoff:orientation" },
      { parent: "validate-handoff:orientation", child: "finalize" },
      { parent: "diagram", child: "validate-handoff:diagram" },
      { parent: "validate-handoff:diagram", child: "finalize" },
      { parent: "lens:style", child: "validate-handoff:lens:style" },
      { parent: "validate-handoff:lens:style", child: "finalize" },
      {
        parent: "lens:observability",
        child: "validate-handoff:lens:observability",
      },
      {
        parent: "validate-handoff:lens:observability",
        child: "finalize",
      },
      { parent: "finalize", child: "review-root" },
    ],
    transitions: [],
  };
  const graphPath = join(inputsDirectory, "graph.json");
  const graphBytes = JSON.stringify(graph);
  await writeFile(graphPath, graphBytes);

  const commentsEvidencePath = join(artifactsDirectory, "comments.validation.json");
  const orientationEvidencePath = join(artifactsDirectory, "orientation.validation.json");
  const diagramEvidencePath = join(artifactsDirectory, "diagram.validation.json");
  const styleEvidencePath = join(artifactsDirectory, "style.validation.json");
  const observabilityEvidencePath = join(
    artifactsDirectory,
    "observability.validation.json",
  );
  const runId = comments.run_id;
  const outputs = {
    result: join(artifactsDirectory, "review.json"),
    markdown: join(artifactsDirectory, "review.md"),
    html: join(artifactsDirectory, "review.html"),
    draft: join(artifactsDirectory, "draft-review.json"),
  };
  const supplements = urgency === "hotfix" ? [] : [
    { kind: "orientation", validation: orientationEvidencePath },
    { kind: "diagram", validation: diagramEvidencePath },
    { kind: "lens:style", validation: styleEvidencePath },
    { kind: "lens:observability", validation: observabilityEvidencePath },
  ];
  const gate = {
    schema: "agent-flow.gate/v1",
    name: "review-finalize",
    version: 1,
    run_id: runId,
    stage: "finalize",
    kind: "review-finalize",
    workspace: runDirectory,
    read_roots: [runDirectory],
    write_root: artifactsDirectory,
    timeout_seconds: 30,
    inputs: [commentsEvidencePath, ...supplements.map(({ validation }) => validation)],
    outputs: Object.values(outputs),
    review_policy: {
      urgency,
      minimum_tier: {
        hotfix: "critical",
        fast: "important",
        standard: "nit",
      }[urgency],
      max_comments: 3,
      per_tier_caps: { critical: 2, important: 1, recommended: 1, nit: 1 },
    },
    review_finalize: {
      comments_validation: commentsEvidencePath,
      supplements,
      result_output: outputs.result,
      markdown_output: outputs.markdown,
      html_output: outputs.html,
      draft_output: outputs.draft,
    },
  };
  const gatePath = join(inputsDirectory, "review-finalize.json");
  const gateBytes = JSON.stringify(gate);
  await writeFile(gatePath, gateBytes);

  const commentsValidatorGate = handoffGate({
    runId,
    runDirectory,
    artifactsDirectory,
    stage: "critic",
    evidencePath: commentsEvidencePath,
  });
  const commentsValidatorGatePath = join(inputsDirectory, "validate-critic.json");
  const commentsValidatorGateBytes = JSON.stringify(commentsValidatorGate);
  await writeFile(commentsValidatorGatePath, commentsValidatorGateBytes);
  const orientationValidatorGate = handoffGate({
    runId,
    runDirectory,
    artifactsDirectory,
    stage: "orientation",
    evidencePath: orientationEvidencePath,
  });
  const orientationValidatorGatePath = join(
    inputsDirectory,
    "validate-orientation.json",
  );
  const orientationValidatorGateBytes = JSON.stringify(orientationValidatorGate);
  await writeFile(orientationValidatorGatePath, orientationValidatorGateBytes);
  const diagramValidatorGate = handoffGate({
    runId,
    runDirectory,
    artifactsDirectory,
    stage: "diagram",
    evidencePath: diagramEvidencePath,
  });
  const diagramValidatorGatePath = join(inputsDirectory, "validate-diagram.json");
  const diagramValidatorGateBytes = JSON.stringify(diagramValidatorGate);
  await writeFile(diagramValidatorGatePath, diagramValidatorGateBytes);
  const styleValidatorGate = handoffGate({
    runId,
    runDirectory,
    artifactsDirectory,
    stage: "lens:style",
    evidencePath: styleEvidencePath,
  });
  const styleValidatorGatePath = join(inputsDirectory, "validate-style.json");
  const styleValidatorGateBytes = JSON.stringify(styleValidatorGate);
  await writeFile(styleValidatorGatePath, styleValidatorGateBytes);
  const observabilityValidatorGate = handoffGate({
    runId,
    runDirectory,
    artifactsDirectory,
    stage: "lens:observability",
    evidencePath: observabilityEvidencePath,
  });
  const observabilityValidatorGatePath = join(
    inputsDirectory,
    "validate-observability.json",
  );
  const observabilityValidatorGateBytes = JSON.stringify(
    observabilityValidatorGate,
  );
  await writeFile(
    observabilityValidatorGatePath,
    observabilityValidatorGateBytes,
  );

  const manifest = {
    schema: "agent-flow.run/v1",
    contract_version: 1,
    implementation: {
      revision: GIT_SHA,
      compatible_contracts: [
        "agent-flow.run/v1",
        "agent-flow.graph/v1",
        "agent-flow.gate/v1",
        "agent-flow.command-result/v1",
        "agent-flow.handoff/v1",
        "agent-flow.validation/v1",
        "agent-flow.task-authority/v1",
        "agent-flow.migration-receipt/v1",
        "agent-flow.local-review/v1",
        "agent-flow.review-comments/v1",
        "agent-flow.review-result/v1",
      ],
      content_set_fingerprint: SHA256,
    },
    identity: {
      run_id: runId,
      run_directory: runDirectory,
      artifact_directory: artifactsDirectory,
      validation_directory: validationDirectory,
      flow: "review",
      repository: { path: runDirectory, forge_coordinate: null },
      board: "review-finalize-test",
      tenant: runId,
      parent_run_id: null,
      external_root: null,
      supersedes: null,
    },
    graph: {
      name: graph.name,
      version: graph.version,
      flow: graph.flow,
      sealed_path: graphPath,
      sha256: sha256(graphBytes),
    },
    approved_read_roots: [runDirectory],
    approved_artifact_roots: [artifactsDirectory],
    inputs: [
      sealedInput("review-manifest", "review.json", join(inputsDirectory, "review.json"), SHA256),
      sealedInput("gate", "review-finalize.json", gatePath, sha256(gateBytes)),
      sealedInput(
        "gate",
        "validate-critic.json",
        commentsValidatorGatePath,
        sha256(commentsValidatorGateBytes),
      ),
      sealedInput(
        "gate",
        "validate-orientation.json",
        orientationValidatorGatePath,
        sha256(orientationValidatorGateBytes),
      ),
      sealedInput(
        "gate",
        "validate-diagram.json",
        diagramValidatorGatePath,
        sha256(diagramValidatorGateBytes),
      ),
      sealedInput(
        "gate",
        "validate-style.json",
        styleValidatorGatePath,
        sha256(styleValidatorGateBytes),
      ),
      sealedInput(
        "gate",
        "validate-observability.json",
        observabilityValidatorGatePath,
        sha256(observabilityValidatorGateBytes),
      ),
      sealedInput("skill", "review-finalizer", join(inputsDirectory, "review-finalizer.md"), SHA256),
      sealedInput("role-contract", "gate", join(inputsDirectory, "gate.md"), SHA256),
    ],
    profiles: {
      profile_set_fingerprint: SHA256,
      required: ["gate"],
      fingerprints: { gate: SHA256 },
    },
    limits: {
      max_created_cards: 10,
      max_worker_attempts: 10,
      max_elapsed_seconds: 300,
      max_feature_streams: 1,
    },
    revisions: { base: GIT_SHA, source: GIT_SHA, target: null },
    sealed_at: "2026-07-15T12:00:00Z",
  };
  const manifestPath = join(runDirectory, "run.json");
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(manifestPath, manifestBytes);
  const manifestDigest = sha256(manifestBytes);
  const criticHandoff = inlineCritic
    ? producerInlineHandoff({
        runId,
        stage: "critic",
        passed: criticPassed,
        inline: comments,
        kind: "review-comments",
      })
    : producerHandoff({
        runId,
        stage: "critic",
        passed: criticPassed,
        path: join(artifactsDirectory, "comments.json"),
        digest: sha256(commentsBytes),
        kind: "review-comments",
      });
  const orientationHandoff = producerInlineHandoff({
    runId,
    stage: "orientation",
    passed: true,
    inline: orientationBytes,
    kind: "review-orientation",
  });
  const diagramHandoff = producerInlineHandoff({
    runId,
    stage: "diagram",
    passed: true,
    inline: diagramBytes,
    kind: "review-diagram",
  });
  const styleHandoff = producerInlineHandoff({
    runId,
    stage: "lens:style",
    passed: optionalLensPassed,
    inline: style,
    kind: "review-findings",
  });
  const observabilityHandoff = producerInlineHandoff({
    runId,
    stage: "lens:observability",
    passed: true,
    inline: observability,
    kind: "review-findings",
  });
  await writeFile(commentsEvidencePath, JSON.stringify(validationEvidence({
    runId,
    stage: "critic",
    taskId: "t_critic",
    manifestPath,
    manifestDigest,
    artifactsDirectory,
    validationDirectory,
    sourceName: "comments.json",
    snapshotPath: commentsSnapshot,
    digest: sha256(commentsBytes),
    handoff: criticHandoff,
    semanticRequired: true,
    inlineSource: inlineCritic,
  })));
  await writeFile(orientationEvidencePath, JSON.stringify(validationEvidence({
    runId,
    stage: "orientation",
    taskId: "t_orientation",
    manifestPath,
    manifestDigest,
    artifactsDirectory,
    validationDirectory,
    sourceName: "orientation.md",
    snapshotPath: orientationSnapshot,
    digest: sha256(orientationBytes),
    handoff: orientationHandoff,
    semanticRequired: false,
    inlineSource: true,
  })));
  await writeFile(diagramEvidencePath, JSON.stringify(validationEvidence({
    runId,
    stage: "diagram",
    taskId: "t_diagram",
    manifestPath,
    manifestDigest,
    artifactsDirectory,
    validationDirectory,
    sourceName: "diagram.mmd",
    snapshotPath: diagramSnapshot,
    digest: sha256(diagramBytes),
    handoff: diagramHandoff,
    semanticRequired: false,
    inlineSource: true,
  })));
  await writeFile(styleEvidencePath, JSON.stringify(validationEvidence({
    runId,
    stage: "lens:style",
    taskId: "t_style",
    manifestPath,
    manifestDigest,
    artifactsDirectory,
    validationDirectory,
    sourceName: "style.json",
    snapshotPath: styleSnapshot,
    digest: sha256(styleBytes),
    handoff: styleHandoff,
    semanticRequired: true,
    inlineSource: true,
  })));
  await writeFile(
    observabilityEvidencePath,
    JSON.stringify(validationEvidence({
      runId,
      stage: "lens:observability",
      taskId: "t_observability",
      manifestPath,
      manifestDigest,
      artifactsDirectory,
      validationDirectory,
      sourceName: "observability.json",
      snapshotPath: observabilitySnapshot,
      digest: sha256(observabilityBytes),
      handoff: observabilityHandoff,
      semanticRequired: true,
      inlineSource: true,
    })),
  );

  const taskId = "t_finalize";
  const validatorTaskByInput = new Map([
    [commentsEvidencePath, "t_validate_critic"],
    [orientationEvidencePath, "t_validate_orientation"],
    [diagramEvidencePath, "t_validate_diagram"],
    [styleEvidencePath, "t_validate_style"],
    [observabilityEvidencePath, "t_validate_observability"],
  ]);
  const authorities = new Map([
    [taskId, {
      taskId,
      runId,
      stage: gate.stage,
      runManifestPath: manifestPath,
      runManifestSha256: manifestDigest,
      gateSpecPath: gatePath,
      gateSpecSha256: sha256(gateBytes),
      inputTaskIds: Object.fromEntries(
        gate.inputs.map((input) => [input, validatorTaskByInput.get(input)]),
      ),
    }],
    ["t_validate_critic", validatorAuthority({
      taskId: "t_validate_critic",
      runId,
      stage: "critic",
      manifestPath,
      manifestDigest,
      gatePath: commentsValidatorGatePath,
      gateDigest: sha256(commentsValidatorGateBytes),
      producerTaskId: "t_critic",
    })],
    ["t_validate_orientation", validatorAuthority({
      taskId: "t_validate_orientation",
      runId,
      stage: "orientation",
      manifestPath,
      manifestDigest,
      gatePath: orientationValidatorGatePath,
      gateDigest: sha256(orientationValidatorGateBytes),
      producerTaskId: "t_orientation",
    })],
    ["t_validate_diagram", validatorAuthority({
      taskId: "t_validate_diagram",
      runId,
      stage: "diagram",
      manifestPath,
      manifestDigest,
      gatePath: diagramValidatorGatePath,
      gateDigest: sha256(diagramValidatorGateBytes),
      producerTaskId: "t_diagram",
    })],
    ["t_validate_style", validatorAuthority({
      taskId: "t_validate_style",
      runId,
      stage: "lens:style",
      manifestPath,
      manifestDigest,
      gatePath: styleValidatorGatePath,
      gateDigest: sha256(styleValidatorGateBytes),
      producerTaskId: "t_style",
    })],
    ["t_validate_observability", validatorAuthority({
      taskId: "t_validate_observability",
      runId,
      stage: "lens:observability",
      manifestPath,
      manifestDigest,
      gatePath: observabilityValidatorGatePath,
      gateDigest: sha256(observabilityValidatorGateBytes),
      producerTaskId: "t_observability",
    })],
    ["t_critic", producerAuthority({
      taskId: "t_critic",
      runId,
      stage: "critic",
      manifestPath,
      manifestDigest,
    })],
    ["t_orientation", producerAuthority({
      taskId: "t_orientation",
      runId,
      stage: "orientation",
      manifestPath,
      manifestDigest,
    })],
    ["t_diagram", producerAuthority({
      taskId: "t_diagram",
      runId,
      stage: "diagram",
      manifestPath,
      manifestDigest,
    })],
    ["t_style", producerAuthority({
      taskId: "t_style",
      runId,
      stage: "lens:style",
      manifestPath,
      manifestDigest,
    })],
    ["t_observability", producerAuthority({
      taskId: "t_observability",
      runId,
      stage: "lens:observability",
      manifestPath,
      manifestDigest,
    })],
  ]);
  const completed = new Map([
    ["t_validate_critic", completedAttempt("t_validate_critic", null)],
    ["t_validate_orientation", completedAttempt("t_validate_orientation", null)],
    ["t_validate_diagram", completedAttempt("t_validate_diagram", null)],
    ["t_validate_style", completedAttempt("t_validate_style", null)],
    [
      "t_validate_observability",
      completedAttempt("t_validate_observability", null),
    ],
    ["t_critic", completedAttempt("t_critic", { handoff: criticHandoff })],
    [
      "t_orientation",
      completedAttempt("t_orientation", { handoff: orientationHandoff }),
    ],
    ["t_diagram", completedAttempt("t_diagram", { handoff: diagramHandoff })],
    ["t_style", completedAttempt("t_style", { handoff: styleHandoff })],
    [
      "t_observability",
      completedAttempt("t_observability", { handoff: observabilityHandoff }),
    ],
  ]);
  return {
    taskId,
    gatePath,
    outputs,
    commentsSnapshot,
    commentsEvidence: commentsEvidencePath,
    styleEvidence: styleEvidencePath,
    styleSnapshot,
    criticHandoff,
    styleHandoff,
    adapter: {
      async getTaskAuthority({ taskId: requested }) {
        assert.equal(authorities.has(requested), true);
        return structuredClone(authorities.get(requested));
      },
      async getTerminalCompletedAttempt({ taskId: requested }) {
        assert.equal(completed.has(requested), true);
        return structuredClone(completed.get(requested));
      },
    },
  };
}

function validationEvidence({
  runId,
  stage,
  taskId,
  manifestPath,
  manifestDigest,
  artifactsDirectory,
  validationDirectory,
  sourceName,
  snapshotPath,
  digest,
  handoff,
  semanticRequired,
  inlineSource = false,
}) {
  const producerMetadata = { handoff };
  return {
    schema: "agent-flow.validation/v1",
    run_id: runId,
    stage,
    task_id: taskId,
    attempt: 1,
    validated_at: "2026-07-15T12:05:00Z",
    source_metadata_sha256: sha256(JSON.stringify(producerMetadata)),
    provenance: {
      run_manifest_path: manifestPath,
      run_manifest_sha256: manifestDigest,
      hermes_attempt_id: `attempt_${taskId}`,
    },
    valid: true,
    identity: {
      handoff_schema: "agent-flow.handoff/v1",
      run_id: runId,
      stage,
      attempt: 1,
    },
    semantic: { required: semanticRequired, passed: handoff.passed },
    approved_artifact_roots: [artifactsDirectory],
    validated_artifact_root: validationDirectory,
    artifacts: [{
      source_path: inlineSource
        ? snapshotPath
        : join(artifactsDirectory, sourceName),
      path: snapshotPath,
      expected_sha256: digest,
      actual_sha256: digest,
      valid: true,
    }],
    errors: [],
  };
}

function handoffGate({
  runId,
  runDirectory,
  artifactsDirectory,
  stage,
  evidencePath,
}) {
  return {
    schema: "agent-flow.gate/v1",
    name: `validate-${stage.replaceAll(":", "-")}-handoff`,
    version: 1,
    run_id: runId,
    stage: `validate-handoff:${stage}`,
    kind: "handoff-validation",
    workspace: runDirectory,
    read_roots: [runDirectory],
    write_root: artifactsDirectory,
    timeout_seconds: 30,
    inputs: [],
    outputs: [evidencePath],
    handoff_validation: {
      producer_stage: stage,
      require_passed: false,
    },
  };
}

function producerHandoff({ runId, stage, passed, path, digest, kind }) {
  return {
    schema: "agent-flow.handoff/v1",
    run_id: runId,
    flow: "review",
    stage,
    attempt: 1,
    passed,
    artifacts: [{ kind, path, sha256: digest }],
    changed_files: [],
    verification: [],
    dependencies: [],
    retry_notes: [],
    residual_risk: [],
  };
}

function producerInlineHandoff({ runId, stage, passed, inline, kind }) {
  return {
    schema: "agent-flow.handoff/v1",
    run_id: runId,
    flow: "review",
    stage,
    passed,
    artifacts: [{ kind, inline }],
    changed_files: [],
    verification: [],
    dependencies: [],
    retry_notes: [],
    residual_risk: [],
  };
}

function validatorAuthority({
  taskId,
  runId,
  stage,
  manifestPath,
  manifestDigest,
  gatePath,
  gateDigest,
  producerTaskId,
}) {
  return {
    taskId,
    runId,
    stage: `validate-handoff:${stage}`,
    runManifestPath: manifestPath,
    runManifestSha256: manifestDigest,
    gateSpecPath: gatePath,
    gateSpecSha256: gateDigest,
    producerTaskId,
  };
}

function producerAuthority({ taskId, runId, stage, manifestPath, manifestDigest }) {
  return {
    taskId,
    runId,
    stage,
    runManifestPath: manifestPath,
    runManifestSha256: manifestDigest,
  };
}

function completedAttempt(taskId, metadata) {
  return {
    attemptId: `attempt_${taskId}`,
    taskId,
    attempt: 1,
    state: "completed",
    metadata,
  };
}

function stage(key, profile, skill, semanticMeasurement = false) {
  return {
    key,
    profile,
    workspace: profile === "gate" || profile === "flow-controller"
      ? "run-dir"
      : "candidate-worktree",
    skill,
    max_attempts: 1,
    semantic_measurement: semanticMeasurement,
    validates_handoff_for: null,
    optional: false,
  };
}

function finding(tier, lens, line, body) {
  return { path: "src/example.mjs", line, side: "RIGHT", tier, lens, body };
}

function sealedInput(kind, name, sealedPath, digest) {
  return {
    kind,
    name,
    source_path: `/tmp/source-${name}`,
    sealed_path: sealedPath,
    sha256: digest,
  };
}

function captureStream() {
  let output = "";
  return {
    stream: { write(chunk) { output += chunk; } },
    value() { return output; },
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJsonBytes(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}
