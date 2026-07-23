import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfiguration, resolveLaunchSpecification } from "./config.mjs";
import {
  captureTranscriptCursor,
  captureTranscriptInventory,
  extractCodexTurn,
  locateCodexTranscript,
  resolveInventoryCursor,
} from "./codex-transcript.mjs";
import { DrovrError } from "./errors.mjs";
import { HerdrClient } from "./herdr.mjs";
import { resolveTaskIdentity } from "./identity.mjs";
import {
  readRecords,
  stateDirectory,
  withResourceLock,
  writeRecord,
} from "./registry.mjs";

function sameLaunchSpecification(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function persistTurn(registryDirectory, turn, changes) {
  Object.assign(turn, changes);
  await writeRecord(registryDirectory, "turns", turn);
}

export async function delegate(options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const configuration = await loadConfiguration({ env });
  const specification = resolveLaunchSpecification(configuration, options);
  const identity = await resolveTaskIdentity({
    cwd: options.cwd,
    groupKey: options.group,
    groupLabel: options.groupLabel,
    run: dependencies.run,
  });
  const registryDirectory = stateDirectory(env);
  const herdr =
    dependencies.herdr ??
    new HerdrClient({
      session: configuration.session,
      env,
      run: dependencies.run,
    });
  await herdr.ensureSession();

  const { group, task } = await withResourceLock(
    registryDirectory,
    `group-key:${identity.groupKey}`,
    async () => {
      const groups = await readRecords(registryDirectory, "groups");
      let group = groups.find(
        (candidate) =>
          candidate.key === identity.groupKey && candidate.status === "active",
      );
      let initialPaneId;
      let initialTabId;
      if (!group) {
        const workspace = await herdr.createWorkspace({
          cwd: identity.cwd,
          label: identity.groupLabel,
        });
        group = {
          schema: "drovr.group/v1",
          id: randomUUID(),
          key: identity.groupKey,
          label: identity.groupLabel,
          inferred: identity.inferred,
          status: "active",
          herdr: {
            session: configuration.session,
            workspace_id: workspace.workspaceId,
          },
          created_at: now(),
        };
        initialPaneId = workspace.paneId;
        initialTabId = workspace.tabId;
        await writeRecord(registryDirectory, "groups", group);
      }

      const tasks = await readRecords(registryDirectory, "tasks");
      let task = tasks.find(
        (candidate) =>
          candidate.group_id === group.id && candidate.key === options.taskKey,
      );
      if (task?.status === "closed") {
        throw new DrovrError(`task key ${options.taskKey} is closed`, {
          code: 0,
          outcome: "task_closed",
        });
      }
      if (task && task.cwd !== identity.cwd) {
        throw new DrovrError(
          `task key ${options.taskKey} is already active with a different cwd`,
          { code: 0, outcome: "configuration_conflict" },
        );
      }
      if (!task) {
        let paneId = initialPaneId;
        let tabId = initialTabId ?? null;
        if (!paneId) {
          const tab = await herdr.createTab({
            workspaceId: group.herdr.workspace_id,
            cwd: identity.cwd,
            label: options.taskLabel ?? options.taskKey,
          });
          paneId = tab.paneId;
          tabId = tab.tabId;
        }
        await herdr.renameTab(tabId, options.taskLabel ?? options.taskKey);
        task = {
          schema: "drovr.task/v1",
          id: randomUUID(),
          group_id: group.id,
          key: options.taskKey,
          label: options.taskLabel ?? options.taskKey,
          cwd: identity.cwd,
          status: "active",
          herdr: { tab_id: tabId, root_pane_id: paneId },
          created_at: now(),
        };
        await writeRecord(registryDirectory, "tasks", task);
      }
      return { group, task };
    },
  );

  const prepared = await withResourceLock(
    registryDirectory,
    `agent-key:${task.id}:${options.agentKey}`,
    async () => {
      const turns = await readRecords(registryDirectory, "turns");
      const agents = await readRecords(registryDirectory, "agents");
      let agent = agents.find(
        (candidate) =>
          candidate.task_id === task.id &&
          candidate.key === options.agentKey &&
          candidate.status === "active",
      );
      if (agent && !sameLaunchSpecification(agent.launch, specification)) {
        throw new DrovrError(
          `agent key ${options.agentKey} already has a different launch specification`,
          { code: 0, outcome: "configuration_conflict" },
        );
      }
      if (
        agent &&
        turns.some(
          (turn) => turn.agent_id === agent.id && turn.status === "working",
        )
      ) {
        throw new DrovrError(
          `agent ${agent.id} already has an open logical turn`,
          {
            code: 0,
            outcome: "task_busy",
          },
        );
      }
      if (agent && !agent.native_session) {
        const observed = await herdr.agentRecord(agent.herdr.name);
        const nativeSession = observed?.agent_session?.value;
        if (nativeSession) {
          agent.native_session = nativeSession;
          await writeRecord(registryDirectory, "agents", agent);
        }
      }

      if (!agent) {
        const id = randomUUID();
        const managedName = `drovr-${id.replaceAll("-", "").slice(0, 26)}`;
        await herdr.startCodexAgent({
          name: managedName,
          paneId: task.herdr.root_pane_id,
          label: options.agentLabel ?? options.agentKey,
          specification,
        });
        const observed = await herdr.agentRecord(managedName);
        const nativeSession = observed?.agent_session?.value ?? null;
        agent = {
          schema: "drovr.agent/v1",
          id,
          task_id: task.id,
          key: options.agentKey,
          label: options.agentLabel ?? options.agentKey,
          status: "active",
          launch: specification,
          herdr: { name: managedName, pane_id: task.herdr.root_pane_id },
          native_session: nativeSession,
          created_at: now(),
        };
        await writeRecord(registryDirectory, "agents", agent);
      }

      const codexRoot = join(
        env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"),
        "sessions",
      );
      let cursor;
      if (agent.native_session) {
        const transcriptPath = await locateCodexTranscript(
          codexRoot,
          agent.native_session,
        );
        cursor = await captureTranscriptCursor(transcriptPath);
      } else {
        cursor = await captureTranscriptInventory(codexRoot, task.cwd, now());
      }
      const turn = {
        schema: "drovr.turn/v1",
        id: randomUUID(),
        agent_id: agent.id,
        task_id: task.id,
        status: "working",
        inputs: [{ sequence: 1, text: options.prompt, submitted_at: now() }],
        transcript_cursor: cursor,
        created_at: now(),
      };
      await writeRecord(registryDirectory, "turns", turn);
      return { agent, turn };
    },
  );

  let observed;
  try {
    observed = await herdr.promptAndWait(
      prepared.agent.herdr.name,
      options.prompt,
      options.timeoutMs,
    );
  } catch (error) {
    await persistTurn(registryDirectory, prepared.turn, {
      status: "uncertain",
      settled_at: now(),
      error: error.message,
    });
    throw error;
  }

  if (observed?.drovr_status === "still_running") {
    return commandResult("still_running", { group, task, ...prepared });
  }

  const observedNativeSession = observed?.agent_session?.value;
  if (
    prepared.agent.native_session &&
    observedNativeSession &&
    prepared.agent.native_session !== observedNativeSession
  ) {
    await persistTurn(registryDirectory, prepared.turn, {
      status: "uncertain",
      error: "Herdr reported a different Codex native session identity",
      settled_at: now(),
    });
    return commandResult("uncertain", { group, task, ...prepared });
  }
  if (!prepared.agent.native_session) {
    if (!observedNativeSession) {
      await persistTurn(registryDirectory, prepared.turn, {
        status: "uncertain",
        error: "Herdr did not report the Codex native session identity",
        settled_at: now(),
      });
      return commandResult("uncertain", { group, task, ...prepared });
    }
    prepared.agent.native_session = observedNativeSession;
    await writeRecord(registryDirectory, "agents", prepared.agent);
    const transcriptPath = await locateCodexTranscript(
      prepared.turn.transcript_cursor.transcript_root,
      observedNativeSession,
    );
    prepared.turn.transcript_cursor = await resolveInventoryCursor(
      prepared.turn.transcript_cursor,
      transcriptPath,
      observedNativeSession,
    );
    await persistTurn(registryDirectory, prepared.turn, {});
  }

  if (observed?.agent_status === "blocked") {
    const block = {
      schema: "drovr.block/v1",
      id: randomUUID(),
      turn_id: prepared.turn.id,
      agent_id: prepared.agent.id,
      task_id: task.id,
      harness: prepared.agent.launch.harness,
      status: "open",
      excerpt: await herdr.agentExcerpt(prepared.agent.herdr.name),
      attach: { command: `drovr attach ${prepared.agent.id}` },
      created_at: now(),
    };
    prepared.turn.block_ids = [...(prepared.turn.block_ids ?? []), block.id];
    await persistTurn(registryDirectory, prepared.turn, {});
    await writeRecord(registryDirectory, "blocks", block);
    return commandResult("needs_input", { group, task, ...prepared, block });
  }
  if (!["idle", "done"].includes(observed?.agent_status)) {
    await persistTurn(registryDirectory, prepared.turn, {
      status: "uncertain",
      settled_at: now(),
    });
    return commandResult("uncertain", { group, task, ...prepared });
  }

  let result;
  try {
    result = await extractCodexTurn(prepared.turn.transcript_cursor, [
      options.prompt,
    ]);
  } catch (error) {
    await persistTurn(registryDirectory, prepared.turn, {
      status: error.outcome ?? "uncertain",
      error: error.message,
      settled_at: now(),
    });
    if (["uncertain", "unsupported_transcript"].includes(error.outcome)) {
      return commandResult(error.outcome, { group, task, ...prepared });
    }
    throw error;
  }
  await persistTurn(registryDirectory, prepared.turn, {
    status: "completed",
    result,
    settled_at: now(),
  });
  return commandResult("completed", { group, task, ...prepared });
}

function commandResult(status, { group, task, agent, turn, block }) {
  return {
    schema: "drovr.command/v1",
    command: "delegate",
    ok: true,
    result: {
      status,
      group: {
        id: group.id,
        key: group.key,
        label: group.label,
      },
      task: {
        id: task.id,
        key: task.key,
        label: task.label,
        cwd: task.cwd,
      },
      agent: {
        id: agent.id,
        key: agent.key,
        label: agent.label,
        harness: agent.launch.harness,
        model: agent.launch.model,
        effort: agent.launch.effort,
        capability: agent.launch.capability,
      },
      turn: {
        id: turn.id,
        status: turn.status,
        input_count: turn.inputs.length,
        ...(turn.result ? { result: turn.result } : {}),
      },
      ...(block
        ? {
            block: {
              id: block.id,
              turn_id: block.turn_id,
              agent_id: block.agent_id,
              task_id: block.task_id,
              harness: block.harness,
              excerpt: block.excerpt,
              attach: block.attach,
            },
          }
        : {}),
    },
  };
}
