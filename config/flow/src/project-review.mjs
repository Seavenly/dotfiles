import { createInterface } from "node:readline/promises";
import { failRun } from "./project-run-state.mjs";
import { runDecisionActions, terminalText } from "./project-run-view.mjs";
import { discoverReviewClients, findReviewAttachment, findReviewConfirmation, reviewPolicy, reviewExecution, reviewSelection } from "./project-review-state.mjs";
import { materializeReviewRequest, observeReviewCandidate, requireReviewExecutionRuntime, validateReviewExecutionPreview } from "./project-review-preparation.mjs";
import { renderReviewPreview, renderReviewResult, reviewAttachCommand, reviewConfirmCommand, summarizeProjectReview } from "./project-review-view.mjs";
import { callProjectClient, followProjectSession, input, ownerStart, preparePreview, requirePublic, requireRun, submitDecision, submitPrepared } from "./project-session.mjs";

export const REVIEW_USAGE = `Usage:
  flow-supervised review [--repository PATH] [--client DIRECTORY] [--producer RUN_ID] [--json]
  flow-supervised review --lens security --lens correctness --parallel 2 [same selection]
  flow-supervised review [same selection] --confirm sha256:DIGEST [--no-follow] [--json]
  flow-supervised review [--client DIRECTORY] --attach REVIEW_RUN_ID [--action sha256:DIGEST] [--json]
  flow-supervised review [--client DIRECTORY] --cancel REVIEW_RUN_ID [--json]

Select up to two distinct --lens security / --lens correctness values and an
explicit --parallel 1|2 bound. Omitted flags preserve the original security-only
review. --lens correctness alone uses one lens plus the fresh critic at one.
Parallel two requires both lenses. Selection, read-only roles and capacity are
confirmed before launch.
Review selects an exact completed producer and current sealed candidate. It starts
or reuses that original client's owner, which may recover already authorized work.
The exact independent review launches only after explicit confirmation. No runtime
upgrade, project checks, human approval or Git publication is performed.
--timeout-seconds 1..3600 (default 600) and --max-revisions 0..4 (default 0)
select overall prepared-run limits, not independent per-role timers. These policy
flags cannot change an attached run. --follow-seconds 1..3600 (default 1800)
bounds observation only. Ctrl-C detaches; use --attach to resume the SAME review.
--refresh replaces only a proven unlaunched preview and retains old evidence.
--action selects an exact currently offered authority decision with --attach.
`;

export function parseReviewArguments(args) {
  const options = {}, flags = new Set(["--json", "--no-follow", "--refresh", "--help", "-h"]);
  const values = new Set(["--repository", "--client", "--producer", "--confirm", "--attach", "--cancel", "--action", "--follow-seconds", "--timeout-seconds", "--max-revisions", "--lens", "--parallel"]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== "--lens" && Object.hasOwn(options, flag) || !flags.has(flag) && !values.has(flag)) failRun(`Unknown or repeated review option: ${flag}`);
    const value = flags.has(flag) ? true : args[++index];
    if (!value || typeof value === "string" && value.startsWith("--")) failRun(`Missing value for ${flag}`);
    if (flag === "--lens") (options[flag] ??= []).push(value); else options[flag] = value;
  }
  if ([options["--confirm"], options["--attach"], options["--cancel"]].filter(Boolean).length > 1 || options["--refresh"] && (options["--confirm"] || options["--attach"] || options["--cancel"])) failRun("Choose preview/refresh, confirm, attach, or cancel separately.");
  if ((options["--attach"] || options["--cancel"]) && (options["--timeout-seconds"] || options["--max-revisions"])) failRun("Attach/cancel uses the exact saved policy. Omit --timeout-seconds and --max-revisions; they cannot change an existing run.");
  if (options["--action"] && !options["--attach"]) failRun("Use --action with --attach REVIEW_RUN_ID.");
  for (const flag of ["--confirm", "--action"]) if (options[flag] && !/^sha256:[a-f0-9]{64}$/u.test(options[flag])) failRun(`Use the exact ${flag} sha256 digest.`);
  for (const flag of ["--producer", "--attach", "--cancel"]) if (options[flag] && !/^run:[a-f0-9]{64}$/u.test(options[flag])) failRun(`Use the exact ${flag} RUN_ID.`);
  const seconds = Number(options["--follow-seconds"] ?? 1800);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) failRun("Use --follow-seconds 1..3600 for observation only.");
  if ((options["--attach"] || options["--cancel"]) && (options["--lens"] || options["--parallel"])) failRun("Attach/cancel uses the exact saved policy. Omit --lens and --parallel; they cannot change an existing review.");
  reviewExecution(options);
  reviewPolicy(options);
  return options;
}

async function choose(items, { interactive, prompts, stdout, heading, label, prompt, refusal }) {
  if (items.length === 1) return items[0];
  if (!interactive) failRun(refusal, "selection_required", 2, items.map(label));
  stdout.write(heading + "\n" + items.map((item, index) => `  ${index + 1}. ${terminalText(label(item))}`).join("\n") + "\n");
  const index = Number(await prompts.question(prompt)) - 1;
  if (!Number.isInteger(index) || !items[index]) failRun("Choose one displayed number. No new review was launched.");
  return items[index];
}

export async function reviewProject(args, { env = process.env, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, callClient = callProjectClient } = {}) {
  let prompts, interrupted = false, selection, intendedRunId;
  const onInterrupt = () => { interrupted = true; prompts?.close(); };
  process.on("SIGINT", onInterrupt);
  try {
    const options = parseReviewArguments(args), execution = reviewExecution(options);
    if (options["--help"] || options["-h"]) { stdout.write(REVIEW_USAGE); return 0; }
    const interactive = Boolean(stdin.isTTY && stdout.isTTY && !options["--json"]);
    if (interactive) prompts = createInterface({ input: stdin, output: stdout });
    const emit = value => stdout.write(options["--json"] ? JSON.stringify(value) + "\n" : value.schema === "flow.project-run-owner/v1" ? terminalText(value.recovery_disclosure) + "\n" : "");
    const call = (selected, command) => callClient(selected, command, { env });
    const clients = discoverReviewClients({ repository: options["--repository"], client: options["--client"], env, cwd });
    let runId = options["--attach"] ?? options["--cancel"], retained;
    if (runId) {
      ({ selection, retained } = findReviewAttachment(clients, runId, options["--producer"]));
      intendedRunId = runId;
      requireReviewExecutionRuntime(selection);
      validateReviewExecutionPreview(selection, retained);
      // Validate journal ownership before owner startup, including old-client recovery.
      await ownerStart(selection, call, emit);
      const run = requireRun(await call(selection, input("query", { run_id: runId })), runId);
      if (run.bundle_digest !== retained.preview.bundle_digest) failRun("Review run differs from the exact retained bundle.", "review_run_changed", 1);
      if (options["--cancel"]) {
        const action = runDecisionActions(run).find(action => action.type === "cancel");
        if (!action && run.phase !== "cancelled") failRun("Cancellation is not currently offered. Reattach for fresh legal actions.", "cancel_unavailable", 1);
        if (action) await submitDecision(selection, runId, action.digest, call);
      } else if (options["--action"]) await submitDecision(selection, runId, options["--action"], call);
    } else {
      if (options["--confirm"]) ({ selection, retained } = findReviewConfirmation(clients, options["--confirm"], options["--producer"], reviewPolicy(options), execution));
      else {
        const client = await choose(clients, { interactive, prompts, stdout, heading: "Choose the original initialized client:", label: item => `${item.directory} [runtime ${item.runtime_root}]`, prompt: "Client number: ", refusal: "Several initialized clients exist. Select --client DIRECTORY; no owner was started." });
        const selectedClient = execution ? { ...client, execution } : client;
        requireReviewExecutionRuntime(selectedClient);
        await ownerStart(selectedClient, call, emit);
        let observed;
        if (options["--producer"]) observed = await observeReviewCandidate(client, options["--producer"], call);
        else {
          const index = requirePublic(await call(client, input("query", {})), "Producer index");
          if (index.schema !== "flow.run-index-projection/v1" || !Array.isArray(index.runs) || !["compatible", "uninitialized"].includes(index.authority_schema?.status)) failRun("Selected authority has no compatible producer index.", "authority_unavailable", 1);
          const eligible = [];
          for (const id of index.runs) {
            const producer = requireRun(await call(client, input("query", { run_id: id })), id);
            if (producer.phase === "succeeded" && producer.review_candidate_reference?.candidate_id) {
              try { eligible.push(await observeReviewCandidate(client, id, call)); }
              catch (error) { if (error.code !== "candidate_unavailable") throw error; }
            }
          }
          if (!eligible.length) failRun("No completed producer has a current sealed candidate. Inspect the original client and finish or settle existing work first.", "producer_required", 1);
          observed = await choose(eligible, { interactive, prompts, stdout, heading: "Choose the exact completed producer:", label: item => `${item.producer.run_id} - ${item.target.candidate_id} (${item.candidate.candidate.git.commit_sha})`, prompt: "Producer number: ", refusal: "Several current retained candidates exist. Select --producer RUN_ID." });
        }
        selection = reviewSelection(client, observed.producer.run_id, observed.target, reviewPolicy(options), { create: true, execution });
        retained = await preparePreview(selection, { refresh: options["--refresh"], call, emit, materializeRequest: materializeReviewRequest });
      }
      requireReviewExecutionRuntime(selection);
      validateReviewExecutionPreview(selection, retained);
      intendedRunId = retained.preview.run_id;
      if (!options["--confirm"]) {
        if (options["--json"]) emit(retained.preview); else stdout.write(renderReviewPreview(retained.preview));
        if (!interactive) {
          if (!options["--json"]) stdout.write(`Confirm with ${reviewConfirmCommand(selection, retained.preview.confirmation_digest)}\n`);
          return 0;
        }
        if (!["y", "yes"].includes((await prompts.question("Launch this exact supervised review? [y/N] ")).trim().toLowerCase())) { stdout.write("No new review launched. The selected owner may remain available.\n"); return 0; }
      }
      if (interrupted) return 130;
      await ownerStart(selection, call, emit);
      const run = await submitPrepared(selection, retained, options["--confirm"] ?? retained.preview.confirmation_digest, { call, emit });
      runId = run.run_id;
    }
    return await followProjectSession(selection, runId, { options, call, emit, interactive, prompts, stdout, isInterrupted: () => interrupted,
      renderResult: renderReviewResult, finish: (run, context) => summarizeProjectReview(run, { ...context, preview: retained.preview }) });
  } catch (error) {
    if (interrupted || error.code === "ERR_USE_AFTER_CLOSE") stderr.write("Detached. Durable work has not been cancelled.\n");
    else { stderr.write(terminalText(error.message) + "\n"); for (const hint of error.hints ?? []) stderr.write(terminalText(hint) + "\n"); }
    if (selection && intendedRunId) stderr.write(terminalText(`Retain exact review evidence. Reattach with ${reviewAttachCommand(selection, intendedRunId)}`) + "\n");
    return interrupted ? 130 : error.exit ?? 1;
  } finally { prompts?.close(); process.removeListener("SIGINT", onInterrupt); }
}
