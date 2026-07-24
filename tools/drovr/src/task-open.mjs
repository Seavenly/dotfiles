import { randomUUID } from "node:crypto";

import { loadConfiguration } from "./config.mjs";
import { DrovrError } from "./errors.mjs";
import { HerdrClient } from "./herdr.mjs";
import { resolveTaskIdentity } from "./identity.mjs";
import {
  readRecords,
  stateDirectory,
  taskLifecycleLockKey,
  withResourceLock,
  writeRecord,
} from "./registry.mjs";

async function updateGroupLabel(
  group,
  label,
  herdr,
  registryDirectory,
) {
  if (!label || label === group.label) return;
  await herdr.renameWorkspace(group.herdr.workspace_id, label);
  group.label = label;
  await writeRecord(registryDirectory, "groups", group);
}

export async function openTask(options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const configuration = await loadConfiguration({ env });
  const identity = await resolveTaskIdentity({
    cwd: options.cwd,
    groupKey: options.group,
    groupLabel: options.groupLabel,
    run: dependencies.run,
  });
  const registryDirectory = stateDirectory(env);

  return withResourceLock(
    registryDirectory,
    `group-key:${identity.groupKey}`,
    async () => {
      const groups = await readRecords(registryDirectory, "groups");
      const matchingGroups = groups.filter(
        (candidate) => candidate.key === identity.groupKey,
      );
      if (matchingGroups.length > 1) {
        throw new DrovrError(
          `registry has duplicate group key ${identity.groupKey}`,
          { code: 5, outcome: "corrupt_registry" },
        );
      }
      let group = matchingGroups[0];
      if (group && group.status !== "active") {
        throw new DrovrError(`group key ${identity.groupKey} is closed`, {
          code: 0,
          outcome: "configuration_conflict",
        });
      }
      const session = group?.herdr?.session ?? configuration.session;
      const herdr =
        dependencies.herdr ??
        new HerdrClient({ session, env, run: dependencies.run });
      await herdr.ensureSession();
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
      const matchingTasks = tasks.filter(
        (candidate) =>
          candidate.group_id === group.id && candidate.key === options.key,
      );
      if (matchingTasks.length > 1) {
        throw new DrovrError(
          `group ${group.id} has duplicate task key ${options.key}`,
          { code: 5, outcome: "corrupt_registry" },
        );
      }
      const task = matchingTasks[0];
      if (task) {
        return withResourceLock(
          registryDirectory,
          taskLifecycleLockKey(task.id),
          async () => {
            const current = (
              await readRecords(registryDirectory, "tasks")
            ).find(({ id }) => id === task.id);
            if (!current) {
              throw new DrovrError(
                `registry task ${task.id} disappeared while opening`,
                { code: 5, outcome: "corrupt_registry" },
              );
            }
            if (current.status === "closed") {
              throw new DrovrError(`task key ${options.key} is closed`, {
                code: 0,
                outcome: "task_closed",
              });
            }
            if (current.cwd !== identity.cwd) {
              throw new DrovrError(
                `task key ${options.key} is already active with a different cwd`,
                { code: 0, outcome: "configuration_conflict" },
              );
            }
            await updateGroupLabel(
              group,
              options.groupLabel,
              herdr,
              registryDirectory,
            );
            if (options.label && options.label !== current.label) {
              await herdr.renameTab(current.herdr.tab_id, options.label);
              current.label = options.label;
              await writeRecord(registryDirectory, "tasks", current);
            }
            return { group, task: current };
          },
        );
      }

      let paneId = initialPaneId;
      let tabId = initialTabId ?? null;
      if (!paneId) {
        const tab = await herdr.createTab({
          workspaceId: group.herdr.workspace_id,
          cwd: identity.cwd,
          label: options.label ?? options.key,
        });
        paneId = tab.paneId;
        tabId = tab.tabId;
      }
      await herdr.renameTab(tabId, options.label ?? options.key);
      const createdTask = {
        schema: "drovr.task/v1",
        id: randomUUID(),
        group_id: group.id,
        key: options.key,
        label: options.label ?? options.key,
        cwd: identity.cwd,
        status: "active",
        herdr: { tab_id: tabId, root_pane_id: paneId },
        created_at: now(),
      };
      await writeRecord(registryDirectory, "tasks", createdTask);
      await updateGroupLabel(
        group,
        options.groupLabel,
        herdr,
        registryDirectory,
      );
      return { group, task: createdTask };
    },
  );
}

export function taskOpenCommandResult({ group, task }) {
  return {
    schema: "drovr.command/v1",
    command: "task open",
    ok: true,
    result: {
      status: "completed",
      group: {
        id: group.id,
        key: group.key,
        label: group.label,
        inferred: group.inferred,
      },
      task: {
        id: task.id,
        group_id: task.group_id,
        key: task.key,
        label: task.label,
        cwd: task.cwd,
      },
    },
  };
}
