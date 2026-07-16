import { isAbsolute } from "node:path";

import { executeCommandGate } from "./command-gate.mjs";
import { doctorProfiles } from "./doctor.mjs";
import { executeHandoffValidationGate } from "./handoff-gate.mjs";
import { HermesAdapter } from "./hermes-adapter.mjs";
import { loadSealedGate } from "./run-bundle-validator.mjs";
import {
  inspectReviewRepository,
  launchReview,
} from "./review-launch.mjs";
import { executeReviewFinalizeGate } from "./review-finalize-gate.mjs";
import { launchFeature } from "./feature-launch.mjs";
import { finalizeFeature } from "./feature-finalize.mjs";
import { advanceFeature } from "./feature-advance.mjs";
import { launchSpike } from "./spike-launch.mjs";
import { advanceSpike } from "./spike-advance.mjs";
import { finalizeSpike } from "./spike-finalize.mjs";
import {
  checkpointEpicTarget,
  initializeEpic,
  materializeEpicWave,
  recordEpicFeatureStatus,
} from "./epic-runtime.mjs";
import { integrateEpicFeature } from "./epic-integration.mjs";
import {
  analyzeStackDiff,
  approveRestack,
  approveStackPlan,
  buildStack,
  publishStack,
  registerLayerReview,
  restackSuffix,
} from "./stack-operations.mjs";
import { GitHubStackRemote } from "./stack-remote.mjs";
import {
  assembleNextDeliveryLayer,
  approveCompletionCheckpoint,
  initializeDelivery,
  observeCompletionMerge,
  openCompletionPullRequest,
  reconcileOpenCompletion,
  verifyDelivery,
} from "./delivery-operations.mjs";
import { GitHubCompletionAdapter } from "./completion-adapter.mjs";
import {
  recordReviewComments,
  transitionReview,
} from "./review-manifest.mjs";
import {
  cancelRun,
  projectRunStatus,
  renderCancellation,
  renderRunStatus,
} from "./run-lifecycle.mjs";

export async function runCli(
  args,
  {
    adapter = null,
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    runDoctor = doctorProfiles,
    inspectRepository = inspectReviewRepository,
    implementationRevision = null,
    now = () => new Date(),
    readReviewComments = undefined,
    launchFeatureRun = launchFeature,
    finalizeFeatureRun = finalizeFeature,
    advanceFeatureRun = advanceFeature,
    launchSpikeRun = launchSpike,
    advanceSpikeRun = advanceSpike,
    finalizeSpikeRun = finalizeSpike,
    initializeEpicRun = initializeEpic,
    materializeEpicWaveRun = materializeEpicWave,
    recordEpicFeatureStatusRun = recordEpicFeatureStatus,
    checkpointEpicTargetRun = checkpointEpicTarget,
    integrateEpicFeatureRun = integrateEpicFeature,
    analyzeStackDiffRun = analyzeStackDiff,
    approveStackPlanRun = approveStackPlan,
    approveRestackRun = approveRestack,
    buildStackRun = buildStack,
    publishStackRun = publishStack,
    registerLayerReviewRun = registerLayerReview,
    restackSuffixRun = restackSuffix,
    initializeDeliveryRun = initializeDelivery,
    assembleNextDeliveryLayerRun = assembleNextDeliveryLayer,
    approveCompletionCheckpointRun = approveCompletionCheckpoint,
    verifyDeliveryRun = verifyDelivery,
    openCompletionPullRequestRun = openCompletionPullRequest,
    reconcileOpenCompletionRun = reconcileOpenCompletion,
    observeCompletionMergeRun = observeCompletionMerge,
  } = {},
) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    usage(stdout);
    return 0;
  }
  if (args[0] === "doctor" && args[1] === "profiles") {
    return runDoctorProfiles(args.slice(2), { runDoctor, stdout, stderr });
  }
  if (args[0] === "gate") {
    return runGate(args.slice(1), { adapter, env, stdout, stderr });
  }
  if (args[0] === "launch" && args[1] === "review") {
    return runLaunchReview(args.slice(2), {
      adapter,
      env,
      implementationRevision,
      inspectRepository,
      now,
      runDoctor,
      stderr,
      stdout,
    });
  }
  if (args[0] === "launch" && args[1] === "feature") {
    return runLaunchFeature(args.slice(2), {
      adapter,
      env,
      implementationRevision,
      launchFeatureRun,
      now,
      runDoctor,
      stderr,
      stdout,
    });
  }
  if (args[0] === "launch" && args[1] === "spike") {
    return runLaunchSpike(args.slice(2), {
      adapter,
      env,
      implementationRevision,
      launchSpikeRun,
      now,
      runDoctor,
      stderr,
      stdout,
    });
  }
  if (args[0] === "launch" && args[1] === "epic") {
    return runLaunchEpic(args.slice(2), {
      adapter, env, implementationRevision, initializeEpicRun, runDoctor, stderr, stdout,
    });
  }
  if (args[0] === "epic" && args[1] === "wave") {
    return runEpicWave(args.slice(2), {
      adapter, env, implementationRevision, materializeEpicWaveRun, runDoctor, stderr, stdout,
    });
  }
  if (args[0] === "epic" && args[1] === "feature-status") {
    return runEpicFeatureStatus(args.slice(2), { env, recordEpicFeatureStatusRun, stderr, stdout });
  }
  if (args[0] === "epic" && args[1] === "checkpoint") {
    return runEpicCheckpoint(args.slice(2), {
      adapter, checkpointEpicTargetRun, env, stderr, stdout,
    });
  }
  if (args[0] === "epic" && args[1] === "integrate") {
    return runEpicIntegrate(args.slice(2), { env, integrateEpicFeatureRun, stderr, stdout });
  }
  if (args[0] === "stacks" && args[1] === "analyze") {
    return runStacksAnalyze(args.slice(2), { analyzeStackDiffRun, stderr, stdout });
  }
  if (args[0] === "stacks" && args[1] === "approve") {
    return runStacksApprove(args.slice(2), { approveStackPlanRun, stderr, stdout });
  }
  if (args[0] === "stacks" && args[1] === "build") {
    return runStacksBuild(args.slice(2), { buildStackRun, stderr, stdout });
  }
  if (args[0] === "stacks" && args[1] === "approve-restack") {
    return runStacksApproveRestack(args.slice(2), { approveRestackRun, stderr, stdout });
  }
  if (args[0] === "stacks" && args[1] === "restack") {
    return runStacksRestack(args.slice(2), { restackSuffixRun, stderr, stdout });
  }
  if (args[0] === "stacks" && args[1] === "publish") {
    return runStacksPublish(args.slice(2), { publishStackRun, stderr, stdout });
  }
  if (args[0] === "stacks" && args[1] === "review") {
    return runStacksReview(args.slice(2), { registerLayerReviewRun, stderr, stdout });
  }
  if (args[0] === "delivery" && args[1] === "init") {
    return runDeliveryInit(args.slice(2), { initializeDeliveryRun, stderr, stdout });
  }
  if (args[0] === "delivery" && args[1] === "apply") {
    return runDeliveryApply(args.slice(2), { assembleNextDeliveryLayerRun, stderr, stdout });
  }
  if (args[0] === "delivery" && args[1] === "verify") {
    return runDeliveryVerify(args.slice(2), { stderr, stdout, verifyDeliveryRun });
  }
  if (args[0] === "delivery" && args[1] === "open") {
    return runDeliveryOpen(args.slice(2), { openCompletionPullRequestRun, stderr, stdout });
  }
  if (args[0] === "delivery" && args[1] === "checkpoint") {
    return runDeliveryCheckpoint(args.slice(2), {
      approveCompletionCheckpointRun, stderr, stdout,
    });
  }
  if (args[0] === "delivery" && args[1] === "reconcile") {
    return runDeliveryReconcile(args.slice(2), { reconcileOpenCompletionRun, stderr, stdout });
  }
  if (args[0] === "delivery" && args[1] === "observe") {
    return runDeliveryObserve(args.slice(2), { observeCompletionMergeRun, stderr, stdout });
  }
  if (args[0] === "feature" && args[1] === "finalize") {
    return runFinalizeFeature(args.slice(2), {
      adapter,
      env,
      finalizeFeatureRun,
      now,
      stderr,
      stdout,
    });
  }
  if (args[0] === "spike" && args[1] === "advance") {
    return runAdvanceSpike(args.slice(2), { adapter, advanceSpikeRun, env, stderr, stdout });
  }
  if (args[0] === "spike" && args[1] === "finalize") {
    return runFinalizeSpike(args.slice(2), { adapter, env, finalizeSpikeRun, stderr, stdout });
  }
  if (args[0] === "feature" && args[1] === "advance") {
    return runAdvanceFeature(args.slice(2), {
      adapter,
      advanceFeatureRun,
      env,
      stderr,
      stdout,
    });
  }
  if (args[0] === "status") {
    return runStatus(args.slice(1), { adapter, env, now, stderr, stdout });
  }
  if (args[0] === "cancel") {
    return runCancel(args.slice(1), { adapter, env, now, stderr, stdout });
  }
  if (args[0] === "review" && args[1] === "transition") {
    return runReviewTransition(args.slice(2), {
      now,
      readReviewComments,
      stderr,
      stdout,
    });
  }
  if (args[0] === "review" && args[1] === "record-comments") {
    return runReviewRecordComments(args.slice(2), {
      now,
      readReviewComments,
      stderr,
      stdout,
    });
  }
  stderr.write(`Unknown command: ${args[0]}\n`);
  usage(stderr);
  return 2;
}

function usage(stream) {
  stream.write(
    "Usage:\n" +
      "  agent-flow doctor profiles [--json]\n" +
      "  agent-flow launch review --manifest <absolute-review.json>\n" +
      "  agent-flow launch feature --manifest <absolute-feature.json>\n" +
      "  agent-flow launch spike --manifest <absolute-spike.json>\n" +
      "  agent-flow launch epic --manifest <absolute-epic.json>\n" +
      "  agent-flow epic wave --run <run-id>\n" +
      "  agent-flow epic feature-status --run <run-id> --feature <id> --status <state>\n" +
      "  agent-flow epic checkpoint --run <run-id>\n" +
      "  agent-flow epic integrate --epic <absolute-epic.json> --review <absolute-review.json> --receipts <absolute-directory>\n" +
      "  agent-flow stacks analyze --repo <absolute-repo> --source <sha> --target <sha>\n" +
      "  agent-flow stacks approve --plan <absolute-plan.json> --actor <actor>\n" +
      "  agent-flow stacks build --plan <absolute-plan.json>\n" +
      "  agent-flow stacks approve-restack --plan <absolute-plan.json> --index <zero-based> --head <sha> --generation <n> --actor <actor>\n" +
      "  agent-flow stacks restack --plan <absolute-plan.json> --index <zero-based> --head <sha> --generation <n>\n" +
      "  agent-flow stacks publish --plan <absolute-plan.json>\n" +
      "  agent-flow stacks review --plan <absolute-plan.json> --layer <id> --manifest <absolute-review.json>\n" +
      "  agent-flow delivery init --delivery <absolute-json> --plan <absolute-plan> --stack-state <absolute-state> --external <ref> --required-checks <comma-list> [--allow-merge-checkpoint]\n" +
      "  agent-flow delivery apply --delivery <absolute-json> [--review <canonical-absolute-review>]\n" +
      "  agent-flow delivery verify --delivery <absolute-json>\n" +
      "  agent-flow delivery open --delivery <absolute-json>\n" +
      "  agent-flow delivery checkpoint --delivery <absolute-json> --actor <identity> --reason <text>\n" +
      "  agent-flow delivery reconcile --delivery <absolute-json>\n" +
      "  agent-flow delivery observe --delivery <absolute-json>\n" +
      "  agent-flow feature finalize --run <run-id>\n" +
      "  agent-flow feature advance --run <run-id> --controller <stage>\n" +
      "  agent-flow spike advance --run <run-id> --controller <stage>\n" +
      "  agent-flow spike finalize --run <run-id>\n" +
      "  agent-flow status --run <run-id> [--json]\n" +
      "  agent-flow cancel --run <run-id> --reason <text>\n" +
      "  agent-flow review transition --manifest <review.json> --to <state> --expected-generation <n> --actor <actor> --reason <text> --evidence <path> [--session-slug <slug>] [--head-sha <sha>] [--integration-receipt <path>]\n" +
      "  agent-flow review record-comments --manifest <review.json> --comments <comments.json> --expected-generation <n> --actor <actor> --reason <text> --evidence <path>\n" +
      "  agent-flow gate --spec <absolute-gate.json>\n",
  );
}

async function runDeliveryInit(options, { initializeDeliveryRun, stderr, stdout }) {
  const allowCheckpoint = options.includes("--allow-merge-checkpoint");
  const named = options.filter((value) => value !== "--allow-merge-checkpoint");
  let parsed;
  try { parsed = parseNamedOptions(named, new Set(["--delivery", "--plan", "--stack-state", "--external", "--required-checks"])); } catch { parsed = null; }
  const requiredChecks = parsed?.get("--required-checks")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (parsed?.size !== 5 || requiredChecks.length === 0 || !["--delivery", "--plan", "--stack-state"].every((name) => isAbsolute(parsed.get(name) ?? ""))) {
    stderr.write("Usage: agent-flow delivery init --delivery <absolute-json> --plan <absolute-plan> --stack-state <absolute-state> --external <ref> --required-checks <comma-list> [--allow-merge-checkpoint]\n"); return 2;
  }
  try {
    const result = await initializeDeliveryRun({
      deliveryPath: parsed.get("--delivery"), externalRef: parsed.get("--external"),
      repositoryPolicy: {
        require_current_base: true,
        required_checks: [...new Set(requiredChecks)],
        allow_explicit_checkpoint: allowCheckpoint,
      },
      stackPlanPath: parsed.get("--plan"), stackStatePath: parsed.get("--stack-state"),
    });
    stdout.write(`ok - delivery initialized ${result.deliveryPath}; state ${result.statePath}\n`); return 0;
  } catch (error) { stderr.write(`agent-flow delivery init: ${error.message}\n`); return 1; }
}

async function runDeliveryApply(options, { assembleNextDeliveryLayerRun, stderr, stdout }) {
  let parsed;
  try { parsed = parseNamedOptions(options, new Set(["--delivery", "--review"])); } catch { parsed = null; }
  if (
    !parsed?.has("--delivery") || !isAbsolute(parsed.get("--delivery") ?? "") ||
    (parsed.has("--review") && !isAbsolute(parsed.get("--review") ?? ""))
  ) {
    stderr.write("Usage: agent-flow delivery apply --delivery <absolute-json> [--review <canonical-absolute-review>]\n"); return 2;
  }
  try {
    const result = await assembleNextDeliveryLayerRun({
      deliveryPath: parsed.get("--delivery"), remote: new GitHubStackRemote(),
      reviewManifestPath: parsed.get("--review"),
    });
    stdout.write(`ok - delivery ${result.action}${result.layer ? ` ${result.layer}` : ""}\n`); return 0;
  } catch (error) { stderr.write(`agent-flow delivery apply: ${error.message}\n`); return 1; }
}

async function runDeliveryVerify(options, { stderr, stdout, verifyDeliveryRun }) {
  if (options.length !== 2 || options[0] !== "--delivery" || !isAbsolute(options[1])) {
    stderr.write("Usage: agent-flow delivery verify --delivery <absolute-json>\n"); return 2;
  }
  try { const result = await verifyDeliveryRun({ deliveryPath: options[1] }); stdout.write(`ok - delivery verified tree ${result.delivery_tree}\n`); return 0; }
  catch (error) { stderr.write(`agent-flow delivery verify: ${error.message}\n`); return 1; }
}

async function runDeliveryOpen(options, { openCompletionPullRequestRun, stderr, stdout }) {
  if (options.length !== 2 || options[0] !== "--delivery" || !isAbsolute(options[1])) {
    stderr.write("Usage: agent-flow delivery open --delivery <absolute-json>\n"); return 2;
  }
  try { const result = await openCompletionPullRequestRun({ deliveryPath: options[1], remote: new GitHubStackRemote() }); stdout.write(`ok - completion PR ${result.url} ${result.status}\n`); return 0; }
  catch (error) { stderr.write(`agent-flow delivery open: ${error.message}\n`); return 1; }
}

async function runDeliveryCheckpoint(
  options,
  { approveCompletionCheckpointRun, stderr, stdout },
) {
  let parsed;
  try { parsed = parseNamedOptions(options, new Set(["--delivery", "--actor", "--reason"])); }
  catch { parsed = null; }
  if (
    parsed?.size !== 3 || !isAbsolute(parsed.get("--delivery") ?? "") ||
    !parsed.get("--actor") || !parsed.get("--reason")
  ) {
    stderr.write("Usage: agent-flow delivery checkpoint --delivery <absolute-json> --actor <identity> --reason <text>\n");
    return 2;
  }
  try {
    const result = await approveCompletionCheckpointRun({
      actor: parsed.get("--actor"), deliveryPath: parsed.get("--delivery"),
      reason: parsed.get("--reason"), remote: new GitHubStackRemote(),
    });
    stdout.write(`ok - completion ${result.id} checkpoint approved\n`);
    return 0;
  } catch (error) {
    stderr.write(`agent-flow delivery checkpoint: ${error.message}\n`);
    return 1;
  }
}

async function runDeliveryReconcile(options, { reconcileOpenCompletionRun, stderr, stdout }) {
  if (options.length !== 2 || options[0] !== "--delivery" || !isAbsolute(options[1])) {
    stderr.write("Usage: agent-flow delivery reconcile --delivery <absolute-json>\n"); return 2;
  }
  try { const result = await reconcileOpenCompletionRun({ deliveryPath: options[1], remote: new GitHubStackRemote() }); stdout.write(`ok - delivery ${result.action}\n`); return result.action === "current" ? 0 : 3; }
  catch (error) { stderr.write(`agent-flow delivery reconcile: ${error.message}\n`); return 1; }
}

async function runDeliveryObserve(options, { observeCompletionMergeRun, stderr, stdout }) {
  if (options.length !== 2 || options[0] !== "--delivery" || !isAbsolute(options[1])) {
    stderr.write("Usage: agent-flow delivery observe --delivery <absolute-json>\n"); return 2;
  }
  try {
    const result = await observeCompletionMergeRun({ completionAdapter: new GitHubCompletionAdapter(), deliveryPath: options[1], remote: new GitHubStackRemote() });
    stdout.write(`ok - delivery ${result.action}\n`); return result.action === "waiting" ? 3 : 0;
  } catch (error) { stderr.write(`agent-flow delivery observe: ${error.message}\n`); return 1; }
}

async function runStacksAnalyze(options, { analyzeStackDiffRun, stderr, stdout }) {
  let parsed;
  try { parsed = parseNamedOptions(options, new Set(["--repo", "--source", "--target"])); } catch { parsed = null; }
  if (parsed?.size !== 3 || !isAbsolute(parsed.get("--repo") ?? "")) {
    stderr.write("Usage: agent-flow stacks analyze --repo <absolute-repo> --source <sha> --target <sha>\n"); return 2;
  }
  try {
    const result = await analyzeStackDiffRun({ repo: parsed.get("--repo"), sourceSha: parsed.get("--source"), targetSha: parsed.get("--target") });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch (error) { stderr.write(`agent-flow stacks analyze: ${error.message}\n`); return 1; }
}

async function runStacksApprove(options, { approveStackPlanRun, stderr, stdout }) {
  let parsed;
  try { parsed = parseNamedOptions(options, new Set(["--plan", "--actor"])); } catch { parsed = null; }
  if (parsed?.size !== 2 || !isAbsolute(parsed.get("--plan") ?? "")) {
    stderr.write("Usage: agent-flow stacks approve --plan <absolute-plan.json> --actor <actor>\n"); return 2;
  }
  try {
    const result = await approveStackPlanRun({ actor: parsed.get("--actor"), planPath: parsed.get("--plan") });
    stdout.write(`ok - stack generation ${result.generation} approved ${result.planFingerprint}\n`); return 0;
  } catch (error) { stderr.write(`agent-flow stacks approve: ${error.message}\n`); return 1; }
}

async function runStacksBuild(options, { buildStackRun, stderr, stdout }) {
  if (options.length !== 2 || options[0] !== "--plan" || !isAbsolute(options[1])) {
    stderr.write("Usage: agent-flow stacks build --plan <absolute-plan.json>\n"); return 2;
  }
  try {
    const result = await buildStackRun({ planPath: options[1] });
    stdout.write(`ok - stack built ${result.finalHeadSha} tree ${result.finalTreeSha}; state ${result.statePath}\n`); return 0;
  } catch (error) { stderr.write(`agent-flow stacks build: ${error.message}\n`); return 1; }
}

async function runStacksApproveRestack(options, { approveRestackRun, stderr, stdout }) {
  let parsed;
  try { parsed = parseNamedOptions(options, new Set(["--plan", "--index", "--head", "--generation", "--actor"])); }
  catch { parsed = null; }
  const index = Number(parsed?.get("--index"));
  const generation = Number(parsed?.get("--generation"));
  if (
    parsed?.size !== 5 || !isAbsolute(parsed.get("--plan") ?? "") ||
    !Number.isInteger(index) || index < 0 || !Number.isInteger(generation) || generation < 2
  ) {
    stderr.write("Usage: agent-flow stacks approve-restack --plan <absolute-plan.json> --index <zero-based> --head <sha> --generation <n> --actor <actor>\n"); return 2;
  }
  try {
    const result = await approveRestackRun({
      actor: parsed.get("--actor"), changedHeadSha: parsed.get("--head"),
      changedLayerIndex: index, newGeneration: generation, planPath: parsed.get("--plan"),
    });
    stdout.write(`ok - restack generation ${result.newGeneration} approved ${result.fingerprint}\n`); return 0;
  } catch (error) { stderr.write(`agent-flow stacks approve-restack: ${error.message}\n`); return 1; }
}

async function runStacksRestack(options, { restackSuffixRun, stderr, stdout }) {
  let parsed;
  try { parsed = parseNamedOptions(options, new Set(["--plan", "--index", "--head", "--generation"])); }
  catch { parsed = null; }
  const index = Number(parsed?.get("--index"));
  const generation = Number(parsed?.get("--generation"));
  if (
    parsed?.size !== 4 || !isAbsolute(parsed.get("--plan") ?? "") ||
    !Number.isInteger(index) || index < 0 || !Number.isInteger(generation) || generation < 2
  ) {
    stderr.write("Usage: agent-flow stacks restack --plan <absolute-plan.json> --index <zero-based> --head <sha> --generation <n>\n"); return 2;
  }
  try {
    const result = await restackSuffixRun({
      changedHeadSha: parsed.get("--head"), changedLayerIndex: index,
      newGeneration: generation, planPath: parsed.get("--plan"),
    });
    stdout.write(`ok - restack generation ${result.generation} head ${result.final_head_sha}\n`); return 0;
  } catch (error) { stderr.write(`agent-flow stacks restack: ${error.message}\n`); return 1; }
}

async function runStacksPublish(options, { publishStackRun, stderr, stdout }) {
  if (options.length !== 2 || options[0] !== "--plan" || !isAbsolute(options[1])) {
    stderr.write("Usage: agent-flow stacks publish --plan <absolute-plan.json>\n"); return 2;
  }
  try {
    const result = await publishStackRun({ planPath: options[1], remote: new GitHubStackRemote() });
    stdout.write(`ok - stack published ${result.prs.length} PRs; state ${result.statePath}\n`); return 0;
  } catch (error) { stderr.write(`agent-flow stacks publish: ${error.message}\n`); return 1; }
}

async function runStacksReview(options, { registerLayerReviewRun, stderr, stdout }) {
  let parsed;
  try {
    parsed = parseNamedOptions(options, new Set(["--plan", "--layer", "--manifest"]));
  } catch { parsed = null; }
  if (
    parsed?.size !== 3 || !isAbsolute(parsed.get("--plan") ?? "") ||
    !isAbsolute(parsed.get("--manifest") ?? "") || !parsed.get("--layer")
  ) {
    stderr.write("Usage: agent-flow stacks review --plan <absolute-plan.json> --layer <id> --manifest <absolute-review.json>\n");
    return 2;
  }
  try {
    const result = await registerLayerReviewRun({
      layerId: parsed.get("--layer"), planPath: parsed.get("--plan"),
      reviewManifestPath: parsed.get("--manifest"),
    });
    stdout.write(`ok - stack layer ${result.layerId} review registered ${result.sha256}\n`);
    return 0;
  } catch (error) {
    stderr.write(`agent-flow stacks review: ${error.message}\n`);
    return 1;
  }
}

async function runLaunchEpic(
  options,
  { adapter, env, implementationRevision, initializeEpicRun, runDoctor, stderr, stdout },
) {
  if (options.length !== 2 || options[0] !== "--manifest" || !isAbsolute(options[1])) {
    stderr.write("Usage: agent-flow launch epic --manifest <absolute-epic.json>\n"); return 2;
  }
  try {
    const result = await initializeEpicRun({
      adapter, env, implementationRevision, manifestPath: options[1], runDoctor,
    });
    stdout.write(`ok - epic ${result.resumed ? "resumed" : "initialized"}; source ${result.sourceWorktree}; state ${result.statePath}\n`);
    return 0;
  } catch (error) { stderr.write(`agent-flow launch epic: ${error.message}\n`); return 1; }
}

async function runEpicWave(
  options,
  { adapter, env, implementationRevision, materializeEpicWaveRun, runDoctor, stderr, stdout },
) {
  if (options.length !== 2 || options[0] !== "--run" || !options[1]) {
    stderr.write("Usage: agent-flow epic wave --run <run-id>\n"); return 2;
  }
  try {
    const result = await materializeEpicWaveRun({
      adapter, env, implementationRevision, runDoctor, runId: options[1],
    });
    stdout.write(`ok - epic ${result.runId} ready ${result.ready.join(",") || "none"}\n`); return 0;
  } catch (error) { stderr.write(`agent-flow epic wave: ${error.message}\n`); return 1; }
}

async function runEpicFeatureStatus(options, { env, recordEpicFeatureStatusRun, stderr, stdout }) {
  let parsed;
  try { parsed = parseNamedOptions(options, new Set(["--run", "--feature", "--status"])); }
  catch { parsed = null; }
  if (parsed?.size !== 3) {
    stderr.write("Usage: agent-flow epic feature-status --run <run-id> --feature <id> --status <state>\n"); return 2;
  }
  try {
    const result = await recordEpicFeatureStatusRun({
      env, featureId: parsed.get("--feature"), runId: parsed.get("--run"), status: parsed.get("--status"),
    });
    stdout.write(`ok - epic ${result.runId} ${result.featureId} ${result.status}\n`); return 0;
  } catch (error) { stderr.write(`agent-flow epic feature-status: ${error.message}\n`); return 1; }
}

async function runEpicCheckpoint(options, { adapter, checkpointEpicTargetRun, env, stderr, stdout }) {
  if (options.length !== 2 || options[0] !== "--run" || !options[1]) {
    stderr.write("Usage: agent-flow epic checkpoint --run <run-id>\n"); return 2;
  }
  try {
    const result = await checkpointEpicTargetRun({ adapter, env, runId: options[1] });
    stdout.write(`ok - epic ${result.runId} target ${result.action} generation ${result.generation}\n`);
    return result.action === "source_refresh" ? 3 : 0;
  } catch (error) { stderr.write(`agent-flow epic checkpoint: ${error.message}\n`); return 1; }
}

async function runEpicIntegrate(options, { env, integrateEpicFeatureRun, stderr, stdout }) {
  let parsed;
  try { parsed = parseNamedOptions(options, new Set(["--epic", "--review", "--receipts"])); }
  catch { parsed = null; }
  if (
    parsed?.size !== 3 ||
    !["--epic", "--review", "--receipts"].every((name) => isAbsolute(parsed.get(name) ?? ""))
  ) {
    stderr.write("Usage: agent-flow epic integrate --epic <absolute-epic.json> --review <absolute-review.json> --receipts <absolute-directory>\n"); return 2;
  }
  try {
    const result = await integrateEpicFeatureRun({
      env,
      epicManifestPath: parsed.get("--epic"), receiptDirectory: parsed.get("--receipts"),
      reviewManifestPath: parsed.get("--review"),
    });
    stdout.write(`ok - epic feature ${result.runId} ${result.action}\n`);
    return ["rereview_required", "conflict_revision_required", "human_review_pending", "review_pending"].includes(result.action) ? 3 : 0;
  } catch (error) { stderr.write(`agent-flow epic integrate: ${error.message}\n`); return 1; }
}

async function runFinalizeSpike(options, { adapter, env, finalizeSpikeRun, stderr, stdout }) {
  if (options.length !== 2 || options[0] !== "--run" || !options[1]) {
    stderr.write("Usage: agent-flow spike finalize --run <run-id>\n");
    return 2;
  }
  try {
    const result = await finalizeSpikeRun({ adapter, env, runId: options[1] });
    stdout.write(`ok - spike ${result.runId} report ${result.resultPath}\n`);
    return 0;
  } catch (error) {
    stderr.write(`agent-flow spike finalize: ${error.message}\n`);
    return 1;
  }
}

async function runAdvanceSpike(options, { adapter, advanceSpikeRun, env, stderr, stdout }) {
  let parsed;
  try { parsed = parseNamedOptions(options, new Set(["--run", "--controller"])); }
  catch { parsed = null; }
  if (
    parsed?.size !== 2 || !parsed.get("--run") || !parsed.get("--controller")
  ) {
    stderr.write("Usage: agent-flow spike advance --run <run-id> --controller <stage>\n");
    return 2;
  }
  try {
    const result = await advanceSpikeRun({
      adapter, controllerStage: parsed.get("--controller"), env,
      runId: parsed.get("--run"),
    });
    stdout.write(`ok - spike ${result.runId} ${result.action}\n`);
    return new Set(["revise", "retry"]).has(result.action) ? 3 : 0;
  } catch (error) {
    stderr.write(`agent-flow spike advance: ${error.message}\n`);
    return 1;
  }
}

async function runLaunchSpike(
  options,
  { adapter, env, implementationRevision, launchSpikeRun, now, runDoctor, stderr, stdout },
) {
  if (options.length !== 2 || options[0] !== "--manifest" || !isAbsolute(options[1])) {
    stderr.write("Usage: agent-flow launch spike --manifest <absolute-spike.json>\n");
    return 2;
  }
  try {
    const result = await launchSpikeRun({
      adapter,
      env,
      implementationRevision,
      manifestPath: options[1],
      now,
      runDoctor,
    });
    stdout.write(
      `ok - spike ${result.runId} materialized ${result.cardCount} cards; ` +
      `root ${result.rootTaskId}; manifest ${result.runManifestPath}` +
      `${result.worktree ? `; prototype ${result.worktree}` : ""}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`agent-flow launch spike: ${error.message}\n`);
    return 1;
  }
}

async function runAdvanceFeature(
  options,
  { adapter, advanceFeatureRun, env, stderr, stdout },
) {
  let parsed;
  try {
    parsed = parseNamedOptions(options, new Set(["--run", "--controller"]));
  } catch {
    stderr.write("Usage: agent-flow feature advance --run <run-id> --controller <stage>\n");
    return 2;
  }
  if (
    parsed.size !== 2 ||
    !parsed.get("--run") ||
    !parsed.get("--controller")
  ) {
    stderr.write("Usage: agent-flow feature advance --run <run-id> --controller <stage>\n");
    return 2;
  }
  try {
    const result = await advanceFeatureRun({
      adapter,
      controllerStage: parsed.get("--controller"),
      env,
      runId: parsed.get("--run"),
    });
    stdout.write(`ok - feature ${result.runId} ${result.controllerStage} ${result.action}\n`);
    return ["retry", "fix"].includes(result.action) ? 3 : 0;
  } catch (error) {
    stderr.write(`agent-flow feature advance: ${error.message}\n`);
    return 1;
  }
}

async function runFinalizeFeature(
  options,
  { adapter, env, finalizeFeatureRun, now, stderr, stdout },
) {
  if (options.length !== 2 || options[0] !== "--run" || !options[1]) {
    stderr.write("Usage: agent-flow feature finalize --run <run-id>\n");
    return 2;
  }
  try {
    const result = await finalizeFeatureRun({ adapter, env, now, runId: options[1] });
    stdout.write(
      `ok - feature ${result.runId} review ${result.reviewManifestPath} at ${result.headSha}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`agent-flow feature finalize: ${error.message}\n`);
    return 1;
  }
}

async function runLaunchFeature(
  options,
  {
    adapter,
    env,
    implementationRevision,
    launchFeatureRun,
    now,
    runDoctor,
    stderr,
    stdout,
  },
) {
  if (options.length !== 2 || options[0] !== "--manifest" || !isAbsolute(options[1])) {
    stderr.write("Usage: agent-flow launch feature --manifest <absolute-feature.json>\n");
    return 2;
  }
  try {
    const result = await launchFeatureRun({
      adapter,
      env,
      implementationRevision,
      manifestPath: options[1],
      now,
      runDoctor,
    });
    stdout.write(
      `ok - feature ${result.runId} materialized ${result.cardCount} cards ` +
      `in ${result.worktree}; root ${result.rootTaskId}; manifest ${result.runManifestPath}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`agent-flow launch feature: ${error.message}\n`);
    return 1;
  }
}

async function runReviewTransition(
  options,
  { now, readReviewComments, stderr, stdout },
) {
  const usage = "Usage: agent-flow review transition --manifest <review.json> --to <state> --expected-generation <n> --actor <actor> --reason <text> --evidence <path> [--session-slug <slug>] [--head-sha <sha>] [--integration-receipt <path>]\n";
  let parsed;
  try {
    parsed = parseNamedOptions(options, new Set([
      "--manifest",
      "--to",
      "--expected-generation",
      "--actor",
      "--reason",
      "--evidence",
      "--session-slug",
      "--head-sha",
      "--integration-receipt",
    ]));
  } catch {
    stderr.write(usage);
    return 2;
  }
  const required = ["--manifest", "--to", "--expected-generation", "--actor", "--reason", "--evidence"];
  if (required.some((name) => !parsed.has(name))) {
    stderr.write(usage);
    return 2;
  }
  try {
    const result = await transitionReview({
      actor: parsed.get("--actor"),
      evidencePath: parsed.get("--evidence"),
      expectedGeneration: parseGeneration(parsed.get("--expected-generation")),
      headSha: parsed.get("--head-sha") ?? null,
      integrationReceiptPath: parsed.get("--integration-receipt") ?? null,
      manifestPath: parsed.get("--manifest"),
      now,
      readComments: readReviewComments,
      reason: parsed.get("--reason"),
      sessionSlug: parsed.get("--session-slug") ?? null,
      to: parsed.get("--to"),
    });
    stdout.write(
      `${result.changed ? "ok" : "ok - unchanged"} - review ${result.manifest.run_id} ${result.manifest.review.status} generation ${result.manifest.review.generation}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`agent-flow review transition: ${error.message}\n`);
    return 1;
  }
}

async function runReviewRecordComments(
  options,
  { now, readReviewComments, stderr, stdout },
) {
  const usage = "Usage: agent-flow review record-comments --manifest <review.json> --comments <comments.json> --expected-generation <n> --actor <actor> --reason <text> --evidence <path>\n";
  let parsed;
  try {
    parsed = parseNamedOptions(options, new Set([
      "--manifest",
      "--comments",
      "--expected-generation",
      "--actor",
      "--reason",
      "--evidence",
    ]));
  } catch {
    stderr.write(usage);
    return 2;
  }
  const required = ["--manifest", "--comments", "--expected-generation", "--actor", "--reason", "--evidence"];
  if (required.some((name) => !parsed.has(name))) {
    stderr.write(usage);
    return 2;
  }
  try {
    const result = await recordReviewComments({
      actor: parsed.get("--actor"),
      commentsPath: parsed.get("--comments"),
      evidencePath: parsed.get("--evidence"),
      expectedGeneration: parseGeneration(parsed.get("--expected-generation")),
      manifestPath: parsed.get("--manifest"),
      now,
      readComments: readReviewComments,
      reason: parsed.get("--reason"),
    });
    stdout.write(
      `${result.changed ? "ok" : "ok - unchanged"} - review ${result.manifest.run_id} comments generation ${result.manifest.review.generation}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`agent-flow review record-comments: ${error.message}\n`);
    return 1;
  }
}

function parseNamedOptions(options, allowed) {
  if (options.length === 0 || options.length % 2 !== 0) throw new Error("invalid options");
  const parsed = new Map();
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!allowed.has(name) || parsed.has(name) || value === undefined || value.length === 0) {
      throw new Error("invalid options");
    }
    parsed.set(name, value);
  }
  return parsed;
}

function parseGeneration(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("expected generation must be a non-negative integer");
  const generation = Number(value);
  if (!Number.isSafeInteger(generation)) {
    throw new Error("expected generation exceeds the safe integer range");
  }
  return generation;
}

async function runCancel(options, { adapter, env, now, stderr, stdout }) {
  if (
    options.length !== 4 ||
    options[0] !== "--run" ||
    options[2] !== "--reason" ||
    options[3].trim().length === 0
  ) {
    stderr.write("Usage: agent-flow cancel --run <run-id> --reason <text>\n");
    return 2;
  }
  try {
    const result = await cancelRun({
      adapter,
      env,
      now,
      reason: options[3].trim(),
      runId: options[1],
    });
    const output = renderCancellation(result);
    (result.converged ? stdout : stderr).write(output);
    return result.converged ? 0 : 1;
  } catch (error) {
    stderr.write(`agent-flow cancel: ${error.message}\n`);
    return 1;
  }
}

async function runStatus(options, { adapter, env, now, stderr, stdout }) {
  const json = options.includes("--json");
  const positional = options.filter((option) => option !== "--json");
  if (
    positional.length !== 2 ||
    positional[0] !== "--run" ||
    options.length !== (json ? 3 : 2)
  ) {
    stderr.write("Usage: agent-flow status --run <run-id> [--json]\n");
    return 2;
  }
  try {
    const report = await projectRunStatus({
      adapter,
      env,
      now,
      runId: positional[1],
    });
    stdout.write(json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderRunStatus(report));
    return report.state === "broken" || report.state === "cancelling" ? 1 : 0;
  } catch (error) {
    stderr.write(`agent-flow status: ${error.message}\n`);
    return 1;
  }
}

async function runLaunchReview(
  options,
  {
    adapter,
    env,
    implementationRevision,
    inspectRepository,
    now,
    runDoctor,
    stderr,
    stdout,
  },
) {
  if (options.length !== 2 || options[0] !== "--manifest") {
    stderr.write(
      "Usage: agent-flow launch review --manifest <absolute-review.json>\n",
    );
    return 2;
  }
  if (!isAbsolute(options[1])) {
    stderr.write("launch review --manifest path must be absolute\n");
    return 2;
  }
  try {
    const result = await launchReview({
      adapter,
      env,
      implementationRevision,
      inspectRepository,
      manifestPath: options[1],
      now,
      runDoctor,
    });
    stdout.write(
      `ok - review launch ${result.runId} materialized ${result.cardCount} cards\n` +
        `run: ${result.runManifestPath}\n` +
        `root: ${result.rootTaskId}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`agent-flow launch review: ${error.message}\n`);
    return 1;
  }
}

async function runDoctorProfiles(options, { runDoctor, stdout, stderr }) {
  if (options.some((option) => option !== "--json")) {
    stderr.write(
      `Unknown option: ${options.find((option) => option !== "--json")}\n`,
    );
    usage(stderr);
    return 2;
  }
  const report = await runDoctor();
  if (options.includes("--json")) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const check of report.checks) {
      stdout.write(`${check.ok ? "ok" : "not ok"} - ${check.summary}\n`);
      for (const detail of check.details) stdout.write(`  - ${detail}\n`);
    }
  }
  return report.ok ? 0 : 1;
}

async function runGate(options, { adapter, env, stdout, stderr }) {
  if (options.length !== 2 || options[0] !== "--spec") {
    stderr.write("Usage: agent-flow gate --spec <absolute-gate.json>\n");
    return 2;
  }
  if (!isAbsolute(options[1])) {
    stderr.write("gate --spec path must be absolute\n");
    return 2;
  }
  const taskId = env.HERMES_KANBAN_TASK?.trim();
  if (!taskId) {
    stderr.write("agent-flow gate requires HERMES_KANBAN_TASK\n");
    return 2;
  }
  try {
    const resolvedAdapter = adapter ?? new HermesAdapter({
      board: env.HERMES_KANBAN_BOARD?.trim() || null,
    });
    const sealedGate = await loadSealedGate({
      adapter: resolvedAdapter,
      taskId,
      requestedGateSpecPath: options[1],
    });
    if (!sealedGate.valid) {
      throw new Error(
        sealedGate.errors[0]?.message ?? "gate authority is invalid",
      );
    }
    const result = await executeSealedGate({
      adapter: resolvedAdapter,
      inheritedEnv: env,
      sealedGate,
    });
    const label = sealedGate.gate.kind;
    if (result.passed) {
      stdout.write(`ok - ${label} gate passed\n`);
      return 0;
    }
    stderr.write(`not ok - ${label} gate failed\n`);
    return 1;
  } catch (error) {
    stderr.write(`agent-flow gate: ${error.message}\n`);
    return 1;
  }
}

async function executeSealedGate({ adapter, inheritedEnv, sealedGate }) {
  switch (sealedGate.gate.kind) {
    case "command":
      return executeCommandGate({ sealedGate, inheritedEnv });
    case "handoff-validation":
      return executeHandoffValidationGate({ adapter, sealedGate });
    case "review-finalize":
      return executeReviewFinalizeGate({ adapter, sealedGate });
    default:
      throw new Error(`unsupported gate kind: ${sealedGate.gate.kind}`);
  }
}
