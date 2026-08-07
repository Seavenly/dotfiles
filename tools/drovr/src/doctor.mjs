import { createHash } from "node:crypto";
import { access, open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfiguration } from "./config.mjs";
import {
  collectProductionCompatibility,
} from "./compatibility.mjs";
import { walkFiles } from "./files.mjs";
import { HerdrClient } from "./herdr.mjs";
import { execute } from "./process.mjs";
import { readRecords, stateDirectory } from "./registry.mjs";
import { redactValue } from "./trace.mjs";
import { inspectAgentRetirement } from "./lifecycle.mjs";

const DROVR_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const REPOSITORY_ROOT = dirname(dirname(DROVR_ROOT));

async function implementationCheck() {
  try {
    const paths = [
      ...(await walkFiles(join(DROVR_ROOT, "src"))),
      ...(await walkFiles(join(DROVR_ROOT, "scripts"))),
      join(DROVR_ROOT, "package.json"),
      join(REPOSITORY_ROOT, "bin", "drovr"),
    ].sort();
    const hash = createHash("sha256");
    for (const path of paths) {
      const source = await readFile(path);
      hash.update(relative(REPOSITORY_ROOT, path));
      hash.update("\0");
      hash.update(source);
      hash.update("\0");
    }
    return {
      id: "drovr",
      status: "pass",
      detail: `drovr source sha256:${hash.digest("hex")}`,
    };
  } catch (error) {
    return {
      id: "drovr",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function commandCheck(id, command, args, run) {
  try {
    const output = (await run(command, args)).trim();
    return { id, status: "pass", detail: output.split(/\r?\n/u)[0] };
  } catch (error) {
    return { id, status: "fail", detail: error.message };
  }
}

async function directoryCheck(id, path) {
  try {
    await access(path);
    return { id, status: "pass", detail: path };
  } catch (error) {
    return { id, status: "fail", detail: `${path}: ${error.message}` };
  }
}

async function codexFlagsCheck(run) {
  try {
    const output = await run("codex", [
      "--strict-config",
      "-c",
      'approvals_reviewer="auto_review"',
      "--help",
    ]);
    const missing = [
      "--model",
      "--sandbox",
      "--ask-for-approval",
      "--search",
    ].filter((flag) => !output.includes(flag));
    return {
      id: "codex-launch-capabilities",
      status: missing.length ? "fail" : "pass",
      detail: missing.length
        ? `missing flags: ${missing.join(", ")}`
        : "supported",
    };
  } catch (error) {
    return {
      id: "codex-launch-capabilities",
      status: "fail",
      detail: error.message,
    };
  }
}

async function jsonlFiles(directory) {
  const files = [];
  for (const path of await walkFiles(directory)) {
    if (path.endsWith(".jsonl")) {
      const metadata = await stat(path);
      files.push({ path, mtimeMs: metadata.mtimeMs, size: metadata.size });
    }
  }
  return files;
}

async function codexTranscriptCheck(directory) {
  try {
    const candidates = (await jsonlFiles(directory))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, 20);
    if (candidates.length === 0) {
      return {
        id: "codex-transcript-structure",
        status: "warn",
        detail: "no native transcripts are available to inspect",
      };
    }
    let recognized = false;
    for (const candidate of candidates) {
      const length = Math.min(candidate.size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      const handle = await open(candidate.path, "r");
      try {
        await handle.read(buffer, 0, length, candidate.size - length);
      } finally {
        await handle.close();
      }
      recognized = buffer
        .toString("utf8")
        .split(/\r?\n/u)
        .some((line) => {
          try {
            const record = JSON.parse(line);
            return (
              record.type === "response_item" &&
              record.payload?.type === "message" &&
              record.payload?.role === "assistant"
            );
          } catch {
            return false;
          }
        });
      if (recognized) break;
    }
    return {
      id: "codex-transcript-structure",
      status: recognized ? "pass" : "fail",
      detail: recognized
        ? "codex-jsonl/v1"
        : "no recognized recent Codex transcript",
    };
  } catch (error) {
    return {
      id: "codex-transcript-structure",
      status: "fail",
      detail: error.message,
    };
  }
}

export async function diagnose({ env = process.env, run = execute } = {}) {
  let configuration;
  let configurationCheck;
  try {
    configuration = await loadConfiguration({ env });
    configurationCheck = {
      id: "configuration",
      status: "pass",
      detail: configuration.directory,
    };
  } catch (error) {
    configurationCheck = {
      id: "configuration",
      status: "fail",
      detail: error.message,
    };
  }

  const home = env.HOME ?? homedir();
  const codexRoot = join(env.CODEX_HOME ?? join(home, ".codex"), "sessions");
  const claudeRoot = join(
    env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
    "projects",
  );
  const checks = [
    { id: "node", status: "pass", detail: process.version },
    await implementationCheck(),
    configurationCheck,
    await commandCheck("herdr", "herdr", ["--version"], run),
    await commandCheck("codex", "codex", ["--version"], run),
    await commandCheck("claude", "claude", ["--version"], run),
    await codexFlagsCheck(run),
    await directoryCheck("codex-transcripts", codexRoot),
    await directoryCheck("claude-transcripts", claudeRoot),
    await codexTranscriptCheck(codexRoot),
  ];
  try {
    const integrations = await run("herdr", ["integration", "status"]);
    for (const harness of ["codex", "claude"]) {
      const match = integrations.match(
        new RegExp(`^${harness}: current \\(v(\\d+)\\)`, "mu"),
      );
      const current = Boolean(match);
      checks.push({
        id: `${harness}-integration`,
        status: current ? "pass" : "fail",
        detail: current
          ? `current (v${match[1]})`
          : "required Herdr integration is not current",
      });
      if (harness === "codex") {
        const nativeSessionCapable = current && Number(match[1]) >= 6;
        checks.push({
          id: "codex-native-session",
          status: nativeSessionCapable ? "pass" : "fail",
          detail: nativeSessionCapable
            ? `reported by Herdr Codex integration v${match[1]}`
            : "Herdr Codex integration v6 or newer is required",
        });
      }
    }
  } catch (error) {
    checks.push({
      id: "codex-integration",
      status: "fail",
      detail: error.message,
    });
    checks.push({
      id: "claude-integration",
      status: "fail",
      detail: error.message,
    });
    checks.push({
      id: "codex-native-session",
      status: "fail",
      detail: error.message,
    });
  }

  for (const harness of ["codex", "claude"]) {
    const compatibility = await collectProductionCompatibility({
      harness,
      env,
      run,
    });
    checks.push({
      id: `${harness}-compatibility`,
      status: compatibility.status === "qualified" ? "warn" : "fail",
      detail: compatibility.status === "qualified"
        ? `${compatibility.evidence_digest}; caller prerequisites pass; exact managed-pane identity is checked at launch and for active agents`
        : compatibility.detail ?? `compatibility ${compatibility.reason}`,
    });
  }
  checks.push(...await managedRuntimeChecks({ env, run }));

  const ok = checks.every(({ status }) => status !== "fail");
  return {
    schema: "drovr.command/v1",
    command: "doctor",
    ok,
    result: {
      status: ok ? "ready" : "unavailable",
      defaults: configuration?.defaults ?? null,
      qualification: configuration?.qualification ?? null,
      checks,
    },
  };
}

async function managedRuntimeChecks({ env, run }) {
  let agents;
  let groups;
  let tasks;
  try {
    [agents, groups, tasks] = await Promise.all([
      readRecords(stateDirectory(env), "agents"),
      readRecords(stateDirectory(env), "groups"),
      readRecords(stateDirectory(env), "tasks"),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [{
        id: "managed-runtime-identity",
        status: "warn",
        detail: "no managed Herdr panes are registered; identity binds at native launch",
      }];
    }
    return [{
      id: "managed-runtime-identity",
      status: "fail",
      detail: error.message,
    }];
  }
  const activeAgents = agents.filter(
    (agent) => agent.status === "active",
  );
  if (activeAgents.length === 0) {
    return [{
      id: "managed-runtime-identity",
      status: "warn",
      detail: "no managed Herdr panes are registered; identity binds at native launch",
    }];
  }
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const warnings = [];
  const failures = [];
  const retirementReports = [];
  for (const agent of activeAgents) {
    const task = taskById.get(agent.task_id);
    const groupForAgent = groupById.get(task?.group_id);
    const expectedIdentity = agent.launch_binding?.managed_runtime_identity;
    if (!expectedIdentity) {
      try {
        const retirement = await inspectAgentRetirement(agent.id, { env, run });
        const report = {
          agent_id: agent.id,
          status: retirement.status,
          ...(retirement.reason ? { reason: retirement.reason } : {}),
          legal_next_actions: retirement.legal_next_actions ?? [],
        };
        retirementReports.push(report);
        if (retirement.status === "retireable_absence") {
          warnings.push(
            `${agent.id}: safely retireable absence; legal next action: ` +
              `drovr agent retire ${agent.id}`,
          );
        } else if (retirement.status === "agent_present") {
          warnings.push(
            `${agent.id}: managed agent and pane are still present; ` +
              `legal next action: drovr agent retire ${agent.id}`,
          );
        } else {
          warnings.push(
            `${agent.id}: unresolved retirement uncertainty ` +
              `(${retirement.reason ?? "unknown"}); legal next action: ` +
              `${retirementActionText(retirement.legal_next_actions)}; ` +
              "shared Herdr sessions remain untouched",
          );
        }
      } catch (error) {
        if (error?.outcome === "corrupt_registry") {
          failures.push(`${agent.id}: ${redactValue(error.message)}`);
          continue;
        }
        retirementReports.push({
          agent_id: agent.id,
          status: "uncertain",
          reason: "retirement_observation_failed",
          legal_next_actions: ["repair_herdr_compatibility_on_disposable_session"],
        });
        warnings.push(
          `${agent.id}: unresolved retirement uncertainty ` +
            `(retirement_observation_failed); legal next action: ` +
            `${retirementActionText(["repair_herdr_compatibility_on_disposable_session"])}; ` +
            `observation failed: ${redactValue(error.message)}`,
        );
      }
      continue;
    }
    if (!groupForAgent?.herdr?.session) {
      failures.push(`${agent.id}: owning Herdr session is missing`);
      continue;
    }
    try {
      const client = new HerdrClient({ session: groupForAgent.herdr.session, env, run });
      const identity = await client.observeManagedRuntime({
        agentName: expectedIdentity.managed_agent,
        expectedIdentity,
        harness: agent.launch.harness,
      });
      const compatibility = await collectProductionCompatibility({
        harness: agent.launch.harness,
        env,
        run,
        managedIdentity: identity,
        expectedManagedIdentity: expectedIdentity,
        requireManagedIdentity: true,
      });
      if (
        compatibility.status !== "qualified" ||
        compatibility.evidence_digest !== agent.launch_binding.compatibility_evidence_digest
      ) {
        failures.push(`${agent.id}: managed runtime compatibility changed`);
      }
    } catch (error) {
      failures.push(`${agent.id}: ${redactValue(error.message)}`);
    }
  }
  return [{
    id: "managed-runtime-identity",
    status: failures.length > 0
      ? "fail"
      : warnings.length > 0
        ? "warn"
        : "pass",
    detail: failures.length === 0 && warnings.length === 0
      ? `verified ${activeAgents.length} managed Herdr pane${activeAgents.length === 1 ? "" : "s"}`
      : [...failures, ...warnings].join("; "),
    ...(retirementReports.length > 0
      ? { retirement: retirementReports }
      : {}),
  }];
}

function retirementActionText(actions) {
  const action = actions?.[0];
  switch (action) {
    case "repair_herdr_compatibility_on_disposable_session":
      return "repair Herdr compatibility on a disposable session";
    case "reconcile_managed_agent_identity":
      return "reconcile the managed agent identity";
    case "inspect_exact_managed_pane":
      return "inspect the exact managed pane";
    case "reconcile_retirement_receipt":
      return "reconcile the missing retirement receipt";
    default:
      return action ?? "reconcile exact agent retirement";
  }
}
