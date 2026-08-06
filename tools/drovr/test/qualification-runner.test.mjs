import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { digestCanonical } from "../src/canonical-json.mjs";
import { redactValue } from "../src/trace.mjs";
import {
  interruptQualification,
  compareUnrelatedGroups,
  nativeSessionValues,
  proveUnknownInputWasNotSubmitted,
  prohibitedMutationObservations,
  resourceDisposition,
  runQualification,
  selectScenarios,
  validateDrovrEnvelope,
  workspaceFingerprint,
} from "../src/qualification-runner.mjs";
import { loadQualificationCatalog } from "../src/qualification-catalog.mjs";

const execFileAsync = promisify(execFile);
const runner = fileURLToPath(
  new URL("../scripts/run-qualification.mjs", import.meta.url),
);

async function executable(path, source) {
  await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${source}`);
  await chmod(path, 0o755);
}

function managedRuntimeIdentity({
  harness,
  managedAgent,
  nativeSession,
  model,
  effort,
}) {
  const executablePath = `/managed/bin/${harness}`;
  const version = harness === "claude"
    ? "2.1.199 (Claude Code)"
    : "codex-cli 0.145.0";
  return JSON.stringify({
    schema: "drovr.managed-pane-runtime-identity/v1",
    harness,
    managed_agent: managedAgent,
    pane_id: "pane-qualification-1",
    executable: {
      observed_path: executablePath,
      canonical_path: executablePath,
      version,
      file_identity: {
        device: 1,
        inode: harness === "claude" ? 11 : 12,
        size: 128,
        mtime_ms: 1000,
      },
    },
    managed_path_digest: `sha256:${"a".repeat(64)}`,
    caller_path_digest: `sha256:${"b".repeat(64)}`,
    integration: `herdr-${harness}/v${harness === "claude" ? 7 : 6}`,
    native_session: nativeSession,
    process: {
      pid: 42,
      name: harness,
      argv0: executablePath,
      argv: [executablePath, "--managed"],
      cmdline: `${executablePath} --managed`,
      cwd: "/tmp/work",
    },
    model,
    effort,
  });
}

test("a missing live prerequisite produces retained typed block evidence", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const evidenceDirectory = join(scratch, "evidence");
  const invocationLog = join(scratch, "invocations.jsonl");
  await mkdir(fakeBin);
  await mkdir(join(scratch, "caller"));
  await executable(
    join(fakeBin, "drovr"),
    `printf '{"argv":%s,"state_home":%s,"runtime_dir":%s}\n' "$(printf '%s\\n' "$@" | jq -Rsc 'split("\\n")[:-1]')" "$(jq -Rn --arg value "$XDG_STATE_HOME" '$value')" "$(jq -Rn --arg value "$XDG_RUNTIME_DIR" '$value')" >> ${JSON.stringify(invocationLog)}
if [[ \${1:-} == doctor ]]; then
  printf '%s\n' '{"schema":"drovr.command/v1","command":"doctor","ok":true,"result":{"status":"ready","defaults":{"harness":"codex","model":"gpt-5.6-sol","effort":"high","capability":"on-approve"},"checks":[{"id":"drovr","status":"pass","detail":"drovr source sha256:missing-qualification"},{"id":"herdr","status":"pass","detail":"herdr 0.7.5"},{"id":"codex","status":"pass","detail":"codex-cli 0.142.5"},{"id":"claude","status":"pass","detail":"2.1.199 (Claude Code)"},{"id":"claude-integration","status":"pass","detail":"current (v7)"}]}}'
  exit 0
fi
printf '%s\n' '{"schema":"drovr.command/v1","command":"unexpected","ok":false,"error":{"outcome":"unexpected_call","message":"unexpected"}}'
exit 5
`,
  );

  let failure;
  try {
    await execFileAsync(
      process.execPath,
      [
        runner,
        "--scenario",
        "claude_multiline_paste_conversion",
        "--evidence-dir",
        evidenceDirectory,
      ],
      {
        encoding: "utf8",
        cwd: scratch,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      },
    );
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, 3);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.schema, "drovr.qualification-run/v1");
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.scenarios, [
    {
      id: "claude_multiline_paste_conversion",
      result: "blocked",
      evidence: report.scenarios[0].evidence,
    },
  ]);

  const evidenceFiles = await readdir(evidenceDirectory);
  assert.equal(evidenceFiles.length, 1);
  const evidence = JSON.parse(
    await readFile(join(evidenceDirectory, evidenceFiles[0]), "utf8"),
  );
  assert.equal(evidence.schema, "drovr.qualification-evidence/v1");
  assert.equal(evidence.catalog_version, 1);
  assert.match(evidence.catalog_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(evidence.scenario_id, "claude_multiline_paste_conversion");
  assert.equal(evidence.execution_kind, "real_herdr_harness");
  assert.equal(evidence.versions.herdr, "herdr 0.7.5");
  assert.equal(evidence.versions.codex, "codex-cli 0.142.5");
  assert.equal(evidence.versions.claude, "2.1.199 (Claude Code)");
  assert.equal(evidence.result.disposition, "blocked");
  assert.equal(evidence.result.reason.code, "prerequisite_unavailable");
  assert.deepEqual(evidence.execution_policy, {
    interface: "public_drovr_cli",
    manual_repair: false,
    registry_surgery: false,
    transcript_surgery: false,
    agent_replacement: false,
    raw_manual_keys: false,
    hidden_retry: false,
    caller_workspace_mutation: false,
  });
  assert.equal(evidence.cleanup_receipt.unresolved_obligations.length, 0);
  assert.equal(evidence.cleanup_receipt.owned_resources.length, 2);

  const [invocation] = (await readFile(invocationLog, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(invocation.argv, ["doctor"]);
  assert.match(invocation.state_home, /\/state$/u);
  assert.match(invocation.runtime_dir, /\/runtime$/u);
  assert.notEqual(invocation.state_home, process.env.XDG_STATE_HOME);
});

test("an initial live launch failure is not misreported as a reuse failure", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-launch-failure-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const evidenceDirectory = join(scratch, "evidence");
  const caller = join(scratch, "caller");
  await mkdir(fakeBin);
  await mkdir(caller);
  await executable(
    join(fakeBin, "drovr"),
    `if [[ \${1:-} == doctor ]]; then
  printf '%s\\n' '{"schema":"drovr.command/v1","command":"doctor","ok":true,"result":{"status":"ready","qualification":{"claude":{"model":"haiku","effort":"low"}},"checks":[{"id":"drovr","status":"pass","detail":"drovr source sha256:launch-failure"},{"id":"herdr","status":"pass","detail":"herdr 0.7.5"},{"id":"claude","status":"pass","detail":"2.1.199 (Claude Code)"},{"id":"claude-transcripts","status":"pass","detail":"available"},{"id":"claude-integration","status":"pass","detail":"current (v7)"}]}}'
  exit 0
fi
if [[ \${1:-} == group && \${2:-} == list ]]; then
  printf '%s\\n' '{"schema":"drovr.command/v1","command":"group list","ok":true,"result":{"status":"completed","groups":[]}}'
  exit 0
fi
if [[ \${1:-} == delegate ]]; then
  printf '%s\\n' '{"schema":"drovr.command/v1","command":"delegate","ok":false,"error":{"outcome":"adapter_failure","message":"Claude workspace trust prompt blocked startup"}}'
  exit 4
fi
exit 5
`,
  );

  const report = await runQualification({
    scenarioIds: ["claude_soak_multiline_reuse"],
    evidenceDirectory,
    drovrCommand: join(fakeBin, "drovr"),
    cwd: caller,
    env: { ...process.env },
  });
  const evidence = JSON.parse(await readFile(report.scenarios[0].evidence, "utf8"));

  assert.equal(report.status, "fail");
  assert.equal(evidence.result.reason.code, "adapter_failure");
  assert.equal(
    evidence.result.reason.message,
    "Claude workspace trust prompt blocked startup",
  );
  assert.notEqual(evidence.result.reason.code, "scenario_assertion_failed");
});

test("deterministic scenarios replay their traces into qualification evidence", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-replay-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeDrovr = join(scratch, "drovr");
  const evidenceDirectory = join(scratch, "evidence");
  const caller = join(scratch, "caller");
  await mkdir(caller);
  await executable(
    fakeDrovr,
    `if [[ \${1:-} == doctor ]]; then
  printf '%s\\n' '{"schema":"drovr.command/v1","command":"doctor","ok":true,"result":{"status":"ready","checks":[{"id":"drovr","status":"pass","detail":"drovr source sha256:runner-test"},{"id":"herdr","status":"pass","detail":"herdr 0.7.5"},{"id":"codex","status":"pass","detail":"codex-cli 0.145.0"},{"id":"claude","status":"pass","detail":"2.1.199 (Claude Code)"},{"id":"codex-integration","status":"pass","detail":"current (v6)"},{"id":"claude-integration","status":"pass","detail":"current (v7)"}]}}'
  exit 0
fi
printf '%s\\n' '{"schema":"drovr.command/v1","command":"unexpected","ok":false,"error":{"outcome":"unexpected_call","message":"unexpected replay command"}}'
exit 5
`,
  );

  const report = await runQualification({
    scenarioIds: [
      "codex_startup_context_before_prompt",
      "claude_staged_input_delayed_reappearance_after_clear",
    ],
    evidenceDirectory,
    drovrCommand: fakeDrovr,
    cwd: caller,
    env: { ...process.env, DROVR_TRACE_JOURNAL: undefined },
  });

  assert.equal(report.status, "pass");
  assert.equal(report.scenarios[0].result, "pass");
  assert.equal(report.scenarios[1].result, "pass");
  const evidence = JSON.parse(
    await readFile(report.scenarios[0].evidence, "utf8"),
  );
  assert.equal(evidence.execution_kind, "deterministic_trace_replay");
  assert.equal(evidence.result.disposition, "pass");
  assert.equal(evidence.trace.schema, "drovr.harness-trace/v1");
  assert.equal(evidence.trace.scenario_id, "codex_startup_context_before_prompt");
  assert.equal(evidence.trace.provenance.herdr, "herdr 0.7.5");
  assert.equal(evidence.trace.events.length > 0, true);
  assert.equal(evidence.cleanup_receipt.unresolved_obligations.length, 0);

  const delayedEvidence = JSON.parse(
    await readFile(report.scenarios[1].evidence, "utf8"),
  );
  const delayedReplay = delayedEvidence.observations.find(
    ({ type }) => type === "deterministic_replay",
  ).result;
  assert.equal(delayedReplay.result, "cleared");
  assert.deepEqual(
    delayedReplay.mutation_proofs.map(({ operation }) => operation),
    ["agent.prompt", "agent.send-keys", "agent.start", "agent.resume"],
  );
  assert.deepEqual(
    delayedEvidence.cleanup_receipt.prohibited_mutations_observed.map(
      ({ description, unchanged }) => ({ description, unchanged }),
    ),
    [
      { description: "Do not submit reappeared unknown staged input.", unchanged: "not_observed" },
      { description: "Do not send keys for reappeared unknown staged input.", unchanged: true },
      { description: "Do not replace the managed agent after reappearance.", unchanged: "not_observed" },
      { description: "Do not repair the native process implicitly.", unchanged: "not_observed" },
      { description: "Do not edit registry, transcript, or caller files.", unchanged: "not_observed" },
    ],
  );
  assert.equal(delayedEvidence.cleanup_receipt.unresolved_obligations.length, 0);
});

test("a reusable live prompt-file scenario accepts identity from the private runtime trace", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-live-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const evidenceDirectory = join(scratch, "evidence");
  const invocationLog = join(scratch, "invocations.jsonl");
  const managedIdentity = managedRuntimeIdentity({
    harness: "claude",
    managedAgent: "qualification-agent",
    nativeSession: "claude-session-1",
    model: "haiku",
    effort: "low",
  });
  const managedIdentityDigest = digestCanonical(JSON.parse(managedIdentity));
  const traceManagedIdentity = JSON.stringify(
    redactValue(JSON.parse(managedIdentity)),
  );
  await mkdir(fakeBin);
  await mkdir(join(scratch, "caller"));
  await executable(
    join(fakeBin, "drovr"),
    `argv_json=$(printf '%s\\n' "$@" | jq -Rsc 'split("\\n")[:-1]')
printf '{"argv":%s,"state_home":%s,"runtime_dir":%s}\n' "$argv_json" "$(jq -Rn --arg value "$XDG_STATE_HOME" '$value')" "$(jq -Rn --arg value "$XDG_RUNTIME_DIR" '$value')" >> ${JSON.stringify(invocationLog)}
case "\${1:-} \${2:-}" in
  "doctor ")
    printf '%s\n' '{"schema":"drovr.command/v1","command":"doctor","ok":true,"result":{"status":"ready","defaults":{"harness":"codex","model":"gpt-5.6-sol","effort":"high","capability":"on-approve"},"qualification":{"codex":{"model":"gpt-5.6-luna","effort":"low"},"claude":{"model":"haiku","effort":"low"}},"checks":[{"id":"drovr","status":"pass","detail":"drovr source sha256:1111"},{"id":"herdr","status":"pass","detail":"herdr 0.7.5"},{"id":"codex","status":"pass","detail":"codex-cli 0.145.0"},{"id":"claude","status":"pass","detail":"2.1.199 (Claude Code)"},{"id":"claude-transcripts","status":"pass","detail":"available"},{"id":"codex-integration","status":"pass","detail":"current (v6)"},{"id":"claude-integration","status":"pass","detail":"current (v7)"}]}}'
    ;;
  "group list")
    printf '%s\n' '{"schema":"drovr.command/v1","command":"group list","ok":true,"result":{"status":"completed","groups":[]}}'
    ;;
  "delegate --group")
    prompt_file=""
    previous=""
    for argument in "$@"; do
      if [[ "$previous" == --prompt-file ]]; then prompt_file="$argument"; fi
      previous="$argument"
    done
    [[ -f "$prompt_file" ]]
    grep -Fq 'QUALIFY-CLAUDE-SOAK-MULTILINE-OK' "$prompt_file"
    printf '%s\\n' '{"sequence":1,"at_ms":0,"kind":"command_result","operation":"agent.prompt","payload":{"request":{"resource":"agent","action":"prompt","target":"qualification-agent","input":{"sentinel":"QUALIFY-CLAUDE-SOAK-MULTILINE-OK"}},"envelope":{"schema":"herdr.command/v1","result":{"status":"accepted"}}}}' >> "$DROVR_TRACE_JOURNAL"
    printf '%s\\n' '{"sequence":2,"at_ms":0,"kind":"agent_observation","operation":"agent.runtime-identity","payload":{"request":{"resource":"agent","action":"runtime-identity","target":"qualification-agent"},"managed_runtime_identity":${traceManagedIdentity}}}' >> "$DROVR_TRACE_JOURNAL"
    printf '%s\n' '{"schema":"drovr.command/v1","command":"delegate","ok":true,"result":{"status":"completed","group":{"id":"group-live-1","key":"qualification-group"},"task":{"id":"task-live-1","key":"qualification-task","cwd":"/tmp/work"},"agent":{"id":"agent-live-1","key":"qualification-agent","harness":"claude","model":"haiku","effort":"low","capability":"read-only","managed_runtime_evidence_digest":"${managedIdentityDigest}"},"turn":{"id":"turn-live-1","status":"completed","input_count":1,"inputs":[{"sequence":1}],"result":{"text":"QUALIFY-CLAUDE-SOAK-MULTILINE-OK","messages":[]}},"authority_watermark":{"schema":"drovr.turn-authority-watermark/v1"},"legal_next_actions":["ask"]}}'
    ;;
  "ask agent-live-1")
    printf '%s\n' '{"schema":"drovr.command/v1","command":"ask","ok":true,"result":{"status":"completed","group":{"id":"group-live-1","key":"qualification-group"},"task":{"id":"task-live-1","key":"qualification-task","cwd":"/tmp/work"},"agent":{"id":"agent-live-1","key":"qualification-agent","harness":"claude","model":"haiku","effort":"low"},"turn":{"id":"turn-live-2","status":"completed","input_count":1,"inputs":[{"sequence":1}],"result":{"text":"QUALIFY-CLAUDE-SOAK-REVIEW-OK","messages":[]}},"authority_watermark":{"schema":"drovr.turn-authority-watermark/v1"},"legal_next_actions":["ask"]}}'
    ;;
  "agent get")
    printf '%s\n' '{"schema":"drovr.command/v1","command":"agent get","ok":true,"result":{"status":"completed","agent":{"id":"agent-live-1","key":"qualification-agent","harness":"claude","native_session":"claude-session-1","managed_runtime_evidence_digest":"${managedIdentityDigest}"}}}'
    ;;
  "group close")
    [[ "\${3:-}" == group-live-1 && "\${4:-}" == --force ]]
    printf '%s\n' '{"schema":"drovr.command/v1","command":"group close","ok":true,"result":{"status":"closed","group":{"id":"group-live-1","key":"qualification-group","label":"qualification"}}}'
    ;;
  *)
    printf '%s\n' '{"schema":"drovr.command/v1","command":"unexpected","ok":false,"error":{"outcome":"unexpected_call","message":"unexpected"}}'
    exit 5
    ;;
esac
`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      runner,
      "--scenario",
      "claude_soak_multiline_reuse",
      "--evidence-dir",
      evidenceDirectory,
    ],
    {
      encoding: "utf8",
      cwd: join(scratch, "caller"),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    },
  );

  const report = JSON.parse(stdout);
  assert.equal(report.status, "pass");
  assert.equal(report.scenarios[0].result, "pass");
  const evidence = JSON.parse(
    await readFile(report.scenarios[0].evidence, "utf8"),
  );
  assert.equal(evidence.result.disposition, "pass");
  assert.equal(evidence.trace.schema, "drovr.harness-trace/v1");
  assert.equal(evidence.trace.events[0].operation, "agent.prompt");
  assert.equal(
    evidence.trace.provenance.compatibility.managed_pane_identity.native_session,
    "claude-session-1",
  );
  assert.match(
    evidence.trace.provenance.compatibility.managed_pane_identity.executable.canonical_path,
    /^<path:sha256:[0-9a-f]{64}>$/u,
  );
  assert.equal(evidence.versions.drovr, "drovr source sha256:1111");
  assert.equal(evidence.versions.model, "haiku");
  assert.equal(evidence.versions.reasoning_effort, "low");
  assert.equal(evidence.environment.managed_session_identity, "claude-session-1");
  assert.equal(evidence.limits.measured.turns, 2);
  assert.equal(evidence.limits.measured.retries, 0);
  assert.equal(evidence.invocations.length, 8);
  assert.equal(evidence.cleanup_receipt.unresolved_obligations.length, 0);
  const catalog = await loadQualificationCatalog();
  const scenario = catalog.scenarios.find(({ id }) => id === "claude_soak_multiline_reuse");
  const emittedAssertions = new Set(evidence.assertions.map(({ id }) => id));
  assert.ok(
    scenario.safety_invariants.every((id) => emittedAssertions.has(id)),
  );
  assert.ok(
    evidence.cleanup_receipt.resource_dispositions.some(
      ({ kind, disposition }) => kind === "group" && disposition === "closed",
    ),
  );
  assert.deepEqual(
    evidence.cleanup_receipt.caller_owned_workspace.before,
    evidence.cleanup_receipt.caller_owned_workspace.after,
  );

  const invocations = (await readFile(invocationLog, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    invocations.map(({ argv }) => argv.slice(0, 2)),
    [
      ["doctor"],
      ["group", "list"],
      ["delegate", "--group"],
      ["agent", "get"],
      ["ask", "agent-live-1"],
      ["agent", "get"],
      ["group", "close"],
      ["group", "list"],
    ],
  );
  assert.equal(new Set(invocations.map(({ state_home }) => state_home)).size, 1);
  assert.equal(new Set(invocations.map(({ runtime_dir }) => runtime_dir)).size, 1);
  const delegateArguments = invocations[2].argv;
  assert.match(delegateArguments[2], /^qualification-claude_soak_multiline_reuse-/u);
  assert.equal(delegateArguments[delegateArguments.indexOf("--harness") + 1], "claude");
  assert.equal(delegateArguments[delegateArguments.indexOf("--model") + 1], "haiku");
  assert.equal(delegateArguments[delegateArguments.indexOf("--effort") + 1], "low");
});

test("the Codex primary prompt scenario reuses one agent across file and stdin turns", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-codex-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const evidenceDirectory = join(scratch, "evidence");
  const invocationLog = join(scratch, "invocations.jsonl");
  await mkdir(fakeBin);
  await mkdir(join(scratch, "caller"));
  await executable(
    join(fakeBin, "drovr"),
    `stdin_value=""
trace_sequence=$(wc -l < "$DROVR_TRACE_JOURNAL" 2>/dev/null || echo 0)
trace_sequence=$((trace_sequence + 1))
printf '{"sequence":%s,"at_ms":0,"kind":"agent_observation","operation":"agent.list","payload":{"request":{"resource":"agent","action":"list","target":null},"envelope":{"schema":"herdr.command/v1","result":{"agents":[]}}}}\\n' "$trace_sequence" >> "$DROVR_TRACE_JOURNAL"
if [[ \${1:-} == ask && "$*" != *--prompt-file* ]]; then stdin_value=$(cat); fi
argv_json=$(printf '%s\\n' "$@" | jq -Rsc 'split("\\n")[:-1]')
printf '{"argv":%s,"stdin":%s,"state_home":%s}\n' "$argv_json" "$(jq -Rn --arg value "$stdin_value" '$value')" "$(jq -Rn --arg value "$XDG_STATE_HOME" '$value')" >> ${JSON.stringify(invocationLog)}
case "\${1:-} \${2:-}" in
  "doctor ")
    printf '%s\n' '{"schema":"drovr.command/v1","command":"doctor","ok":true,"result":{"status":"ready","qualification":{"codex":{"model":"gpt-5.6-luna","effort":"low"}},"checks":[{"id":"drovr","status":"pass","detail":"drovr source sha256:2222"},{"id":"herdr","status":"pass","detail":"herdr 0.7.5"},{"id":"codex","status":"pass","detail":"codex-cli 0.145.0"},{"id":"claude","status":"pass","detail":"2.1.199 (Claude Code)"},{"id":"codex-launch-capabilities","status":"pass","detail":"supported"},{"id":"codex-transcripts","status":"pass","detail":"available"},{"id":"codex-transcript-structure","status":"pass","detail":"supported"},{"id":"codex-integration","status":"pass","detail":"current (v6)"},{"id":"codex-native-session","status":"pass","detail":"supported"},{"id":"claude-integration","status":"pass","detail":"current (v7)"}]}}'
    ;;
  "group list")
    printf '%s\n' '{"schema":"drovr.command/v1","command":"group list","ok":true,"result":{"status":"completed","groups":[]}}'
    ;;
  "delegate --group")
    printf '%s\n' '{"schema":"drovr.command/v1","command":"delegate","ok":true,"result":{"status":"completed","group":{"id":"group-codex-1","key":"qualification-group"},"task":{"id":"task-codex-1","key":"qualification-task","cwd":"/tmp/work"},"agent":{"id":"agent-codex-1","key":"qualification-agent","harness":"codex","model":"gpt-5.6-luna","effort":"low","capability":"read-only","managed_runtime_identity":${managedRuntimeIdentity({ harness: "codex", managedAgent: "qualification-agent", nativeSession: "codex-session-1", model: "gpt-5.6-luna", effort: "low" })}},"turn":{"id":"turn-codex-1","status":"completed","input_count":1,"inputs":[{"sequence":1}],"result":{"text":"QUALIFY-CODEX-POSITIONAL-1-OK","messages":[]}},"authority_watermark":{"schema":"drovr.turn-authority-watermark/v1"},"legal_next_actions":["ask"]}}'
    ;;
  "agent get")
    printf '%s\n' '{"schema":"drovr.command/v1","command":"agent get","ok":true,"result":{"status":"completed","agent":{"id":"agent-codex-1","key":"qualification-agent","harness":"codex","native_session":"codex-session-1","managed_runtime_identity":${managedRuntimeIdentity({ harness: "codex", managedAgent: "qualification-agent", nativeSession: "codex-session-1", model: "gpt-5.6-luna", effort: "low" })}}}}'
    ;;
  "ask agent-codex-1")
    if [[ "$*" == *--prompt-file* ]]; then
      turn=2
      text=QUALIFY-CODEX-FILE-2-OK
    else
      [[ "$stdin_value" == 'Reply exactly: QUALIFY-CODEX-STDIN-3-OK' ]]
      turn=3
      text=QUALIFY-CODEX-STDIN-3-OK
    fi
    printf '{"schema":"drovr.command/v1","command":"ask","ok":true,"result":{"status":"completed","group":{"id":"group-codex-1","key":"qualification-group"},"task":{"id":"task-codex-1","key":"qualification-task","cwd":"/tmp/work"},"agent":{"id":"agent-codex-1","key":"qualification-agent","harness":"codex","model":"gpt-5.6-luna","effort":"low","capability":"read-only"},"turn":{"id":"turn-codex-%s","status":"completed","input_count":1,"inputs":[{"sequence":1}],"result":{"text":"%s","messages":[]}},"authority_watermark":{"schema":"drovr.turn-authority-watermark/v1"},"legal_next_actions":["ask"]}}\n' "$turn" "$text"
    ;;
  "group close")
    printf '%s\n' '{"schema":"drovr.command/v1","command":"group close","ok":true,"result":{"status":"closed","group":{"id":"group-codex-1","key":"qualification-group","label":"qualification"}}}'
    ;;
  *) exit 5 ;;
esac
`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      runner,
      "--scenario",
      "codex_live_prompt_sources_and_reuse",
      "--evidence-dir",
      evidenceDirectory,
    ],
    {
      encoding: "utf8",
      cwd: join(scratch, "caller"),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    },
  );

  const report = JSON.parse(stdout);
  assert.equal(report.status, "pass");
  const evidence = JSON.parse(await readFile(report.scenarios[0].evidence, "utf8"));
  assert.equal(evidence.execution_kind, "real_herdr_harness");
  assert.equal(evidence.versions.model, "gpt-5.6-luna");
  assert.equal(evidence.versions.reasoning_effort, "low");
  assert.equal(evidence.limits.measured.turns, 3);
  assert.equal(evidence.result.disposition, "pass");
  assert.equal(evidence.environment.managed_session_identity, "codex-session-1");
  assert.equal(
    evidence.assertions.find(({ id }) => id === "same_managed_agent_across_turns").disposition,
    "pass",
  );

  const invocations = (await readFile(invocationLog, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    invocations.map(({ argv }) => argv[0]),
    ["doctor", "group", "delegate", "agent", "ask", "ask", "agent", "group", "group"],
  );
  assert.equal(invocations[5].stdin, "Reply exactly: QUALIFY-CODEX-STDIN-3-OK");
  const agentIds = evidence.observations
    .map((observation) => observation.result?.agent?.id)
    .filter(Boolean);
  assert.deepEqual(agentIds, Array(5).fill("agent-codex-1"));
});

test("a failed Codex launch discovers and closes its generated group", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-codex-cleanup-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const evidenceDirectory = join(scratch, "evidence");
  const groupKeyPath = join(scratch, "group-key");
  const closedPath = join(scratch, "closed");
  await mkdir(fakeBin);
  await mkdir(join(scratch, "caller"));
  await executable(
    join(fakeBin, "drovr"),
    `groupKeyPath=${JSON.stringify(groupKeyPath)}
closedPath=${JSON.stringify(closedPath)}
trace_sequence=$(wc -l < "$DROVR_TRACE_JOURNAL" 2>/dev/null || echo 0)
trace_sequence=$((trace_sequence + 1))
printf '{"sequence":%s,"at_ms":0,"kind":"agent_observation","operation":"agent.list","payload":{"request":{"resource":"agent","action":"list","target":null},"envelope":{"schema":"herdr.command/v1","result":{"agents":[]}}}}\\n' "$trace_sequence" >> "$DROVR_TRACE_JOURNAL"
case "\${1:-} \${2:-}" in
  "doctor ") printf '%s\\n' '{"schema":"drovr.command/v1","command":"doctor","ok":true,"result":{"status":"ready","qualification":{"codex":{"model":"gpt-5.6-luna","effort":"low"}},"checks":[{"id":"drovr","status":"pass","detail":"drovr source sha256:cleanup"},{"id":"herdr","status":"pass","detail":"herdr 0.7.5"},{"id":"codex","status":"pass","detail":"codex-cli 0.145.0"},{"id":"claude","status":"pass","detail":"2.1.199 (Claude Code)"},{"id":"codex-launch-capabilities","status":"pass","detail":"supported"},{"id":"codex-transcripts","status":"pass","detail":"available"},{"id":"codex-transcript-structure","status":"pass","detail":"supported"},{"id":"codex-integration","status":"pass","detail":"current (v6)"},{"id":"codex-native-session","status":"pass","detail":"supported"}]}}' ;;
  "group list")
    if [[ -f "$groupKeyPath" && ! -f "$closedPath" ]]; then
      key=$(cat "$groupKeyPath")
      printf '{"schema":"drovr.command/v1","command":"group list","ok":true,"result":{"status":"completed","groups":[{"id":"group-failed-1","key":"%s"}]}}\\n' "$key"
    else
      printf '%s\\n' '{"schema":"drovr.command/v1","command":"group list","ok":true,"result":{"status":"completed","groups":[]}}'
    fi ;;
  "delegate --group")
    printf '%s' "$3" > "$groupKeyPath"
    printf '%s\\n' '{"schema":"drovr.command/v1","command":"delegate","ok":false,"error":{"outcome":"adapter_failure","message":"Codex native session was not exposed"}}'
    exit 4 ;;
  "group close")
    touch "$closedPath"
    printf '%s\\n' '{"schema":"drovr.command/v1","command":"group close","ok":true,"result":{"status":"closed","group":{"id":"group-failed-1"}}}' ;;
  *) exit 5 ;;
esac
`,
  );

  const report = await runQualification({
    scenarioIds: ["codex_live_prompt_sources_and_reuse"],
    evidenceDirectory,
    drovrCommand: join(fakeBin, "drovr"),
    cwd: join(scratch, "caller"),
    env: { ...process.env },
  });
  const evidence = JSON.parse(await readFile(report.scenarios[0].evidence, "utf8"));

  assert.equal(report.status, "fail");
  assert.equal(evidence.result.disposition, "fail");
  assert.equal(evidence.cleanup_receipt.unresolved_obligations.length, 0);
  assert.deepEqual(
    evidence.cleanup_receipt.resource_dispositions.find(({ kind }) => kind === "group"),
    { kind: "group", identity: "group-failed-1", disposition: "closed" },
  );
});

test("live lifecycle settles exact native work before same-agent reuse", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-cancel-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const evidenceDirectory = join(scratch, "evidence");
  const invocationLog = join(scratch, "invocations");
  await mkdir(fakeBin);
  await mkdir(join(scratch, "caller"));
  await executable(
    join(fakeBin, "drovr"),
    `printf '%s\n' "$*" >> ${JSON.stringify(invocationLog)}
trace_sequence=$(wc -l < "$DROVR_TRACE_JOURNAL" 2>/dev/null || echo 0)
trace_sequence=$((trace_sequence + 1))
printf '{"sequence":%s,"at_ms":0,"kind":"agent_observation","operation":"agent.list","payload":{"request":{"resource":"agent","action":"list","target":null},"envelope":{"schema":"herdr.command/v1","result":{"agents":[]}}}}\\n' "$trace_sequence" >> "$DROVR_TRACE_JOURNAL"
case "\${1:-} \${2:-}" in
  "doctor ") printf '%s\n' '{"schema":"drovr.command/v1","command":"doctor","ok":true,"result":{"status":"ready","qualification":{"codex":{"model":"gpt-5.6-luna","effort":"low"}},"checks":[{"id":"drovr","status":"pass","detail":"drovr source sha256:3333"},{"id":"herdr","status":"pass","detail":"herdr 0.7.5"},{"id":"codex","status":"pass","detail":"codex-cli 0.145.0"},{"id":"claude","status":"pass","detail":"2.1.199 (Claude Code)"},{"id":"codex-launch-capabilities","status":"pass","detail":"supported"},{"id":"codex-transcripts","status":"pass","detail":"available"},{"id":"codex-transcript-structure","status":"pass","detail":"supported"},{"id":"codex-integration","status":"pass","detail":"current (v6)"},{"id":"codex-native-session","status":"pass","detail":"supported"}]}}' ;;
  "group list") printf '%s\n' '{"schema":"drovr.command/v1","command":"group list","ok":true,"result":{"status":"completed","groups":[]}}' ;;
  "task open") printf '%s\n' '{"schema":"drovr.command/v1","command":"task open","ok":true,"result":{"status":"completed","group":{"id":"group-cancel-1","key":"qualification"},"task":{"id":"task-cancel-1","key":"task","cwd":"/tmp/work"}}}' ;;
  "agent start") printf '%s\n' '{"schema":"drovr.command/v1","command":"agent start","ok":true,"result":{"status":"completed","task":{"id":"task-cancel-1"},"agent":{"id":"agent-cancel-1","key":"agent","harness":"codex","model":"gpt-5.6-luna","effort":"low","capability":"read-only","native_session":"codex-session-cancel","managed_runtime_identity":${managedRuntimeIdentity({ harness: "codex", managedAgent: "agent", nativeSession: "codex-session-cancel", model: "gpt-5.6-luna", effort: "low" })}}}}' ;;
  "agent get") printf '%s\n' '{"schema":"drovr.command/v1","command":"agent get","ok":true,"result":{"status":"completed","agent":{"id":"agent-cancel-1","native_session":"codex-session-cancel"}}}' ;;
  "turn start")
    if [[ "$*" == *"QUALIFY-CODEX-LIFECYCLE-HOLD-OK"* ]]; then turn_id=turn-steer-1
    elif [[ "$*" == *"QUALIFY-CODEX-TIMEOUT"* ]]; then turn_id=turn-timeout-2
    else turn_id=turn-cancel-3; fi
    printf '{"schema":"drovr.command/v1","command":"turn start","ok":true,"result":{"status":"working","group":{"id":"group-cancel-1"},"task":{"id":"task-cancel-1"},"agent":{"id":"agent-cancel-1","harness":"codex","model":"gpt-5.6-luna","effort":"low"},"turn":{"id":"%s","status":"working","input_count":1},"authority_watermark":{"schema":"drovr.turn-authority-watermark/v1"},"legal_next_actions":["cancel"]}}\n' "$turn_id"
    ;;
  "turn send") printf '%s\n' '{"schema":"drovr.command/v1","command":"turn send","ok":true,"result":{"status":"sent","group":{"id":"group-cancel-1"},"task":{"id":"task-cancel-1"},"agent":{"id":"agent-cancel-1"},"turn":{"id":"turn-steer-1","status":"working","input_count":2}}}' ;;
  "turn wait")
    if [[ "\${3:-}" == turn-steer-1 ]]; then status=completed; text=QUALIFY-CODEX-STEERING-OK; count=2
    elif [[ "$*" == *"--timeout 1ms"* ]]; then status=still_running; text=""; count=1
    else status=completed; text=QUALIFY-CODEX-TIMEOUT-OK; count=1; fi
    printf '{"schema":"drovr.command/v1","command":"turn wait","ok":true,"result":{"status":"%s","group":{"id":"group-cancel-1"},"task":{"id":"task-cancel-1"},"agent":{"id":"agent-cancel-1"},"turn":{"id":"%s","status":"%s","input_count":%s,"result":{"text":"%s"}}}}\n' "$status" "\${3:-}" "$status" "$count" "$text"
    ;;
  "turn cancel") printf '%s\n' '{"schema":"drovr.command/v1","command":"turn cancel","ok":true,"result":{"status":"cancelled","group":{"id":"group-cancel-1"},"task":{"id":"task-cancel-1"},"agent":{"id":"agent-cancel-1","harness":"codex","model":"gpt-5.6-luna","effort":"low"},"turn":{"id":"turn-cancel-1","status":"cancelled","input_count":1,"terminal_proof":{"schema":"drovr.terminal-proof/v1","classification":"cancelled"}},"authority_watermark":{"schema":"drovr.turn-authority-watermark/v1"},"legal_next_actions":["ask"]}}' ;;
  "ask agent-cancel-1") printf '%s\n' '{"schema":"drovr.command/v1","command":"ask","ok":true,"result":{"status":"completed","group":{"id":"group-cancel-1"},"task":{"id":"task-cancel-1"},"agent":{"id":"agent-cancel-1","harness":"codex","model":"gpt-5.6-luna","effort":"low"},"turn":{"id":"turn-reuse-2","status":"completed","input_count":1,"result":{"text":"QUALIFY-CODEX-REUSE-OK"}},"authority_watermark":{"schema":"drovr.turn-authority-watermark/v1"},"legal_next_actions":["ask"]}}' ;;
  "group close") printf '%s\n' '{"schema":"drovr.command/v1","command":"group close","ok":true,"result":{"status":"closed","group":{"id":"group-cancel-1"}}}' ;;
  *) exit 5 ;;
esac
`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [runner, "--scenario", "codex_live_lifecycle_recovery", "--evidence-dir", evidenceDirectory],
    { encoding: "utf8", cwd: join(scratch, "caller"), env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.status, "pass");
  const evidence = JSON.parse(await readFile(report.scenarios[0].evidence, "utf8"));
  assert.equal(evidence.limits.measured.turns, 4);
  assert.equal(
    evidence.assertions.find(({ id }) => id === "exact_cancellation_settlement").disposition,
    "pass",
  );
  assert.equal(
    evidence.assertions.find(({ id }) => id === "same_agent_reuse_after_recovery").disposition,
    "pass",
  );
  const invocationLogText = await readFile(invocationLog, "utf8");
  assert.match(invocationLogText, /sleeps for 8 seconds/u);
  assert.deepEqual(invocationLogText.trim().split("\n").map((line) => line.split(" ").slice(0, 2).join(" ")), [
    "doctor",
    "group list",
    "task open",
    "agent start",
    "turn start",
    "turn send",
    "turn wait",
    "turn start",
    "turn wait",
    "turn wait",
    "turn start",
    "turn cancel",
    "ask agent-cancel-1",
    "agent get",
    "group close",
    "group list",
  ]);
});

test("complete Drovr envelope validation rejects contradictory and partial shapes", () => {
  assert.match(
    validateDrovrEnvelope("group list", {
      schema: "drovr.command/v1",
      command: "group list",
      ok: true,
      result: { status: "completed", groups: [] },
      error: { outcome: "contradiction", message: "must not coexist" },
    }),
    /must not contain error/u,
  );
  assert.match(
    validateDrovrEnvelope("group list", {
      schema: "drovr.command/v1",
      command: "group list",
      ok: true,
      result: { status: "completed" },
    }),
    /groups must be an array/u,
  );
  assert.equal(
    validateDrovrEnvelope("group list", {
      schema: "drovr.command/v1",
      command: "group list",
      ok: true,
      result: { status: "completed", groups: [] },
    }),
    null,
  );
});

test("unknown-input evidence helpers fail closed on missing observations", () => {
  assert.deepEqual(nativeSessionValues([{ execution: { envelope: { result: { agent: { native_session: "session-1" } } } } }, null]), ["session-1"]);
  assert.deepEqual(compareUnrelatedGroups(undefined, undefined, "owned"), {
    proven: false,
    unchanged: false,
  });
  assert.equal(
    proveUnknownInputWasNotSubmitted({
      beforeTurns: [],
      afterTurns: undefined,
      reuseTurnId: "reuse-1",
    }),
    false,
  );
});

test("unknown-input proof permits only the one expected reuse turn", () => {
  const unknownPayloadSha256 = `sha256:${"a".repeat(64)}`;
  assert.equal(
    proveUnknownInputWasNotSubmitted({
      beforeTurns: [],
      afterTurns: [{
        id: "reuse-1",
        input_count: 1,
        inputs: [{ payload_sha256: `sha256:${"b".repeat(64)}` }],
      }],
      reuseTurnId: "reuse-1",
      unknownPayloadSha256,
    }),
    true,
  );
  assert.equal(
    proveUnknownInputWasNotSubmitted({
      beforeTurns: [],
      afterTurns: [
        { id: "unknown-submit", input_count: 1 },
        { id: "reuse-1", input_count: 1 },
      ],
      reuseTurnId: "reuse-1",
      unknownPayloadSha256,
    }),
    false,
  );
  assert.equal(
    proveUnknownInputWasNotSubmitted({
      beforeTurns: [],
      afterTurns: [{
        id: "reuse-1",
        input_count: 1,
        inputs: [{ payload_sha256: unknownPayloadSha256 }],
      }],
      reuseTurnId: "reuse-1",
      unknownPayloadSha256,
    }),
    false,
  );
  assert.equal(
    proveUnknownInputWasNotSubmitted({
      beforeTurns: [{ id: "existing-1", input_count: 1 }],
      afterTurns: [
        { id: "existing-1", input_count: 2, inputs: [{ sequence: 1 }, { sequence: 2 }] },
        { id: "reuse-1", input_count: 1 },
      ],
      reuseTurnId: "reuse-1",
      unknownPayloadSha256,
    }),
    false,
  );
});

test("owned staged-input recovery may pass after the expected delegate failure", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-owned-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const evidenceDirectory = join(scratch, "evidence");
  await mkdir(fakeBin);
  await mkdir(join(scratch, "caller"));
  await executable(
    join(fakeBin, "drovr"),
    `fixture="$XDG_STATE_HOME/owned-fixture"
mkdir -p "$fixture"
trace_sequence=$(wc -l < "$DROVR_TRACE_JOURNAL" 2>/dev/null || echo 0)
trace_sequence=$((trace_sequence + 1))
printf '{"sequence":%s,"at_ms":0,"kind":"agent_observation","operation":"agent.list","payload":{"request":{"resource":"agent","action":"list","target":null},"envelope":{"schema":"herdr.command/v1","result":{"agents":[]}}}}\\n' "$trace_sequence" >> "$DROVR_TRACE_JOURNAL"
case "\${1:-} \${2:-}" in
  "doctor ") printf '%s\n' '{"schema":"drovr.command/v1","command":"doctor","ok":true,"result":{"status":"ready","qualification":{"claude":{"model":"haiku","effort":"low"}},"checks":[{"id":"drovr","status":"pass","detail":"drovr source sha256:owned"},{"id":"herdr","status":"pass","detail":"herdr 0.7.5"},{"id":"codex","status":"pass","detail":"codex-cli 0.145.0"},{"id":"claude","status":"pass","detail":"2.1.199 (Claude Code)"},{"id":"claude-transcripts","status":"pass","detail":"available"},{"id":"claude-integration","status":"pass","detail":"current (v7)"}]}}' ;;
  "group list")
    if [[ -f "$fixture/group" && ! -f "$fixture/closed" ]]; then
      key=$(cat "$fixture/group")
      printf '{"schema":"drovr.command/v1","command":"group list","ok":true,"result":{"status":"completed","groups":[{"id":"group-owned-1","key":"%s"}]}}\n' "$key"
    else
      printf '%s\n' '{"schema":"drovr.command/v1","command":"group list","ok":true,"result":{"status":"completed","groups":[]}}'
    fi ;;
  "delegate --group")
    printf '%s' "$3" > "$fixture/group"
    printf '%s\n' '{"schema":"drovr.command/v1","command":"delegate","ok":false,"error":{"outcome":"adapter_failure","message":"Claude already has staged prompt text"}}'
    exit 4 ;;
  "task list") printf '%s\n' '{"schema":"drovr.command/v1","command":"task list","ok":true,"result":{"status":"completed","tasks":[{"id":"task-owned-1","key":"task-owned","cwd":"/tmp/work"}]}}' ;;
  "agent list") printf '%s\n' '{"schema":"drovr.command/v1","command":"agent list","ok":true,"result":{"status":"completed","agents":[{"id":"agent-owned-1","key":"agent-owned","harness":"claude","model":"haiku","effort":"low"}]}}' ;;
  "agent get") printf '%s\n' '{"schema":"drovr.command/v1","command":"agent get","ok":true,"result":{"status":"completed","agent":{"id":"agent-owned-1","key":"agent-owned","harness":"claude","model":"haiku","effort":"low","native_session":"claude-owned-session","managed_runtime_identity":${managedRuntimeIdentity({ harness: "claude", managedAgent: "agent-owned", nativeSession: "claude-owned-session", model: "haiku", effort: "low" })}}}}' ;;
  "turn list") printf '%s\n' '{"schema":"drovr.command/v1","command":"turn list","ok":true,"result":{"status":"completed","turns":[{"id":"turn-owned-1","status":"uncertain","input_count":1}]}}' ;;
  "agent staged-input")
    if [[ "$*" == *--submit* ]]; then
      printf '%s\n' '{"schema":"drovr.command/v1","command":"agent staged-input","ok":true,"result":{"status":"submitted","agent":{"id":"agent-owned-1"}}}'
    else
      printf '%s\n' '{"schema":"drovr.command/v1","command":"agent staged-input","ok":true,"result":{"status":"staged_input","agent":{"id":"agent-owned-1"},"staged_input":{"ownership":"drovr","turn_id":"turn-owned-1","token":"owned-token"}}}'
    fi ;;
  "turn get") printf '%s\n' '{"schema":"drovr.command/v1","command":"turn get","ok":true,"result":{"status":"late_result","group":{"id":"group-owned-1"},"task":{"id":"task-owned-1"},"agent":{"id":"agent-owned-1"},"turn":{"id":"turn-owned-1","status":"uncertain","input_count":1,"late_result":{"text":"QUALIFY-CLAUDE-OWNED-STAGED-OK"}}}}' ;;
  "group close")
    touch "$fixture/closed"
    printf '%s\n' '{"schema":"drovr.command/v1","command":"group close","ok":true,"result":{"status":"closed","group":{"id":"group-owned-1"}}}' ;;
  *) printf '%s\n' '{"schema":"drovr.command/v1","command":"unexpected","ok":false,"error":{"outcome":"unexpected_call","message":"unexpected"}}'; exit 5 ;;
esac
`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      runner,
      "--scenario",
      "claude_owned_staged_input_submit",
      "--evidence-dir",
      evidenceDirectory,
    ],
    {
      encoding: "utf8",
      cwd: join(scratch, "caller"),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.status, "pass");
  const evidence = JSON.parse(await readFile(report.scenarios[0].evidence, "utf8"));
  assert.equal(evidence.result.disposition, "pass");
  assert.equal(
    evidence.assertions.find(
      ({ id }) => id === "exact_owned_snapshot_submitted_to_original_turn",
    ).disposition,
    "pass",
  );
});

test("blocked unknown-input setup does not claim a prohibited mutation", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-unknown-block-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const evidenceDirectory = join(scratch, "evidence");
  await mkdir(fakeBin);
  await mkdir(join(scratch, "caller"));
  await executable(
    join(fakeBin, "drovr"),
    `case "\${1:-} \${2:-}" in
  "doctor ") printf '%s\n' '{"schema":"drovr.command/v1","command":"doctor","ok":true,"result":{"status":"ready","qualification":{"claude":{"model":"haiku","effort":"low"}},"checks":[{"id":"drovr","status":"pass","detail":"drovr source sha256:unknown"},{"id":"herdr","status":"pass","detail":"herdr 0.7.5"},{"id":"claude","status":"pass","detail":"2.1.199 (Claude Code)"},{"id":"claude-transcripts","status":"pass","detail":"available"},{"id":"claude-integration","status":"pass","detail":"current (v7)"}]}}' ;;
  "group list") printf '%s\n' '{"schema":"drovr.command/v1","command":"group list","ok":true,"result":{"status":"completed","groups":[]}}' ;;
  "task open") printf '%s\n' '{"schema":"drovr.command/v1","command":"task open","ok":true,"result":{"status":"completed","group":{"id":"group-unknown-1"},"task":{"id":"task-unknown-1"}}}' ;;
  "agent start") printf '%s\n' '{"schema":"drovr.command/v1","command":"agent start","ok":true,"result":{"status":"completed","task":{"id":"task-unknown-1"},"agent":{"id":"agent-unknown-1","harness":"claude","model":"haiku","effort":"low","native_session":"claude-unknown-session"}}}' ;;
  "turn list") printf '%s\n' '{"schema":"drovr.command/v1","command":"turn list","ok":true,"result":{"status":"completed","turns":[]}}' ;;
  "agent get") printf '%s\n' '{"schema":"drovr.command/v1","command":"agent get","ok":true,"result":{"status":"working","agent":{"id":"agent-unknown-1","native_session":"claude-unknown-session"}}}' ;;
  "group close") printf '%s\n' '{"schema":"drovr.command/v1","command":"group close","ok":true,"result":{"status":"closed","group":{"id":"group-unknown-1"}}}' ;;
  *) printf '%s\n' '{"schema":"drovr.command/v1","command":"unexpected","ok":false,"error":{"outcome":"unexpected_call","message":"unexpected"}}'; exit 5 ;;
esac
`,
  );

  let failure;
  try {
    await execFileAsync(
      process.execPath,
      [
        runner,
        "--scenario",
        "claude_unknown_staged_input_clear_and_reuse",
        "--evidence-dir",
        evidenceDirectory,
      ],
      {
        encoding: "utf8",
        cwd: join(scratch, "caller"),
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 3);
  const report = JSON.parse(failure.stdout);
  const evidence = JSON.parse(await readFile(report.scenarios[0].evidence, "utf8"));
  assert.equal(evidence.result.disposition, "blocked");
  assert.ok(
    evidence.cleanup_receipt.prohibited_mutations_observed.every(
      ({ unchanged }) => unchanged === "not_observed",
    ),
  );
});

test("failed cleanup retains isolated filesystem resources in receipts", () => {
  assert.equal(resourceDisposition("state_root", false), "retained");
  assert.equal(resourceDisposition("runtime_root", false), "retained");
  assert.equal(resourceDisposition("temporary_workspace", false), "retained");
  assert.equal(resourceDisposition("group", false), "cleanup-blocked");
  assert.equal(resourceDisposition("turn", false), "retained");
});

test("prohibited-mutation receipts distinguish proof from unobserved state", () => {
  assert.deepEqual(
    prohibitedMutationObservations(["private state is unchanged"], {
      basis: ["public envelopes only"],
    }),
    [{
      description: "private state is unchanged",
      unchanged: "not_observed",
      basis: ["public envelopes only"],
    }],
  );
  assert.equal(
    prohibitedMutationObservations(["known check"], {
      fullyObserved: true,
      unchanged: false,
    })[0].unchanged,
    false,
  );
  assert.deepEqual(
    prohibitedMutationObservations(["known guarded operation", "unproven operation"], {
      basis: ["semantic replay"],
      proofs: [{
        description: "known guarded operation",
        operation: "agent.prompt",
        unchanged: true,
        basis: "guard rejected before mutation",
      }],
    }),
    [
      {
        description: "known guarded operation",
        unchanged: true,
        basis: [
          "semantic replay",
          "agent.prompt: guard rejected before mutation",
        ],
      },
      {
        description: "unproven operation",
        unchanged: "not_observed",
        basis: ["semantic replay"],
      },
    ],
  );
  assert.equal(
    prohibitedMutationObservations(["unexercised operation"], {
      proofs: [{
        description: "unexercised operation",
        operation: "agent.resume",
        unchanged: "not_observed",
        basis: "no semantic attempt was recorded",
      }],
    })[0].unchanged,
    "not_observed",
  );
});

test("full live selection is catalog-derived and excludes operator-staged scenarios", async () => {
  const catalog = await loadQualificationCatalog();
  const selected = selectScenarios(catalog, [], { fullLive: true });
  assert.ok(selected.length > 0);
  assert.ok(
    selected.every(
      ({ execution }) =>
        execution.kind === "real_herdr_harness" &&
        execution.unattended === true,
    ),
  );
  assert.ok(
    !selected.some(({ id }) => id === "claude_owned_staged_input_submit"),
  );
  assert.ok(
    !selected.some(
      ({ id }) => id === "claude_staged_input_transient_clear_reappears",
    ),
  );
  const invalidCatalog = structuredClone(catalog);
  invalidCatalog.scenarios.push({
    ...structuredClone(selected[0]),
    id: "live_scenario_without_executor",
  });
  assert.throws(
    () => selectScenarios(invalidCatalog, [], { fullLive: true }),
    /unattended scenario has no executor/u,
  );
});

test("workspace fingerprints detect content changes hidden by unchanged Git status", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-workspace-fingerprint-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const tracked = join(scratch, "tracked.txt");
  await execFileAsync("git", ["init", "--quiet", scratch]);
  await execFileAsync("git", ["-C", scratch, "config", "user.name", "Qualification"]);
  await execFileAsync("git", ["-C", scratch, "config", "user.email", "qualification@example.invalid"]);
  await writeFile(tracked, "committed\n");
  await execFileAsync("git", ["-C", scratch, "add", "tracked.txt"]);
  await execFileAsync("git", ["-C", scratch, "commit", "--quiet", "-m", "fixture"]);
  await writeFile(tracked, "first modification\n");
  const before = await workspaceFingerprint(scratch);
  await writeFile(tracked, "second modification\n");
  const after = await workspaceFingerprint(scratch);

  assert.equal(before.head, after.head);
  assert.equal(before.status, after.status);
  assert.notEqual(before.content_sha256, after.content_sha256);
});

test("operator interruption force-terminates an uncooperative child and retains evidence", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-interrupt-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeDrovr = join(scratch, "drovr");
  const evidenceDirectory = join(scratch, "evidence");
  await executable(
    fakeDrovr,
    `trap '' TERM
sleep 30
`,
  );

  const startedAt = Date.now();
  const run = runQualification({
    scenarioIds: ["claude_multiline_paste_conversion"],
    evidenceDirectory,
    drovrCommand: fakeDrovr,
    cwd: scratch,
  });
  setTimeout(interruptQualification, 50);
  const report = await run;

  assert.equal(report.status, "fail");
  assert.ok(Date.now() - startedAt < 5_000);
  const evidence = JSON.parse(
    await readFile(report.scenarios[0].evidence, "utf8"),
  );
  assert.equal(evidence.result.reason.code, "operator_interrupted");
  assert.equal(evidence.cleanup_receipt.unresolved_obligations.length, 0);
});

test("executor rejection still writes failure evidence through the cleanup path", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-rejection-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const caller = join(scratch, "caller");
  const evidenceDirectory = join(scratch, "evidence");
  await mkdir(fakeBin);
  await mkdir(caller);
  await executable(
    join(fakeBin, "drovr"),
    `stdin_value=""
if [[ \${1:-} == ask && "$*" != *--prompt-file* ]]; then stdin_value=$(cat); fi
case "\${1:-} \${2:-}" in
  "doctor ") printf '%s\n' '{"schema":"drovr.command/v1","command":"doctor","ok":true,"result":{"status":"ready","qualification":{"codex":{"model":"gpt-5.6-luna","effort":"low"}},"checks":[{"id":"drovr","status":"pass","detail":"drovr source sha256:rejection"},{"id":"herdr","status":"pass","detail":"herdr 0.7.5"},{"id":"codex","status":"pass","detail":"codex-cli 0.145.0"},{"id":"codex-launch-capabilities","status":"pass","detail":"supported"},{"id":"codex-transcripts","status":"pass","detail":"available"},{"id":"codex-transcript-structure","status":"pass","detail":"supported"},{"id":"codex-integration","status":"pass","detail":"current (v6)"},{"id":"codex-native-session","status":"pass","detail":"supported"}]}}' ;;
  "group list") printf '%s\n' '{"schema":"drovr.command/v1","command":"group list","ok":true,"result":{"status":"completed","groups":[]}}' ;;
  "delegate --group")
    previous=""; workspace=""
    for argument in "$@"; do [[ "$previous" == --cwd ]] && workspace="$argument"; previous="$argument"; done
    rmdir "$workspace"
    printf '%s\n' '{"schema":"drovr.command/v1","command":"delegate","ok":true,"result":{"status":"completed","group":{"id":"group-rejection"},"task":{"id":"task-rejection"},"agent":{"id":"agent-rejection","harness":"codex","model":"gpt-5.6-luna","effort":"low"},"turn":{"id":"turn-rejection-1","status":"completed","input_count":1,"result":{"text":"QUALIFY-CODEX-POSITIONAL-1-OK"}}}}' ;;
  "agent get") printf '%s\n' '{"schema":"drovr.command/v1","command":"agent get","ok":true,"result":{"status":"completed","agent":{"id":"agent-rejection","native_session":"session-rejection"}}}' ;;
  "ask agent-rejection")
    if [[ "$*" == *--prompt-file* ]]; then turn=2; text=QUALIFY-CODEX-FILE-2-OK; else turn=3; text=QUALIFY-CODEX-STDIN-3-OK; fi
    printf '{"schema":"drovr.command/v1","command":"ask","ok":true,"result":{"status":"completed","group":{"id":"group-rejection"},"task":{"id":"task-rejection"},"agent":{"id":"agent-rejection","harness":"codex","model":"gpt-5.6-luna","effort":"low"},"turn":{"id":"turn-rejection-%s","status":"completed","input_count":1,"result":{"text":"%s"}}}}\n' "$turn" "$text" ;;
  "group close") printf '%s\n' '{"schema":"drovr.command/v1","command":"group close","ok":true,"result":{"status":"closed","group":{"id":"group-rejection"}}}' ;;
  *) exit 5 ;;
esac
`,
  );

  let failure;
  try {
    await execFileAsync(
      process.execPath,
      [
        runner,
        "--scenario",
        "codex_live_prompt_sources_and_reuse",
        "--evidence-dir",
        evidenceDirectory,
      ],
      {
        cwd: caller,
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      },
    );
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, 4);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.status, "fail");
  const evidence = JSON.parse(
    await readFile(report.scenarios[0].evidence, "utf8"),
  );
  assert.equal(evidence.result.reason.code, "internal_error");
  assert.equal(evidence.cleanup_receipt.unresolved_obligations.length, 0);
});
