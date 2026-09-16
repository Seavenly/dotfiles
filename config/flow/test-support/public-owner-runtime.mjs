import { appendFile, readFile } from "node:fs/promises";

import {
  createFlowRuntime as createCoreFlowRuntime,
  statusAutonomousFlowRuntime,
} from "../../../tools/flow/src/flow-runtime.mjs";
import {
  createDurableRunAuthority,
} from "../../../tools/flow/src/run-authority.mjs";
import {
  createGitRetentionAdapter,
  createGitWorkspaceObservationAdapter,
} from "../../../tools/flow/src/git-retention-adapter.mjs";
import {
  fixedExecutionTimeAdapter,
  fixedHostIdentity,
} from "../../../tools/flow/test-support/fixed-host-identity.mjs";
import {
  operationReceipt,
  TEST_OPERATION_CONTRACT,
  OPERATION_RECEIPT_VALIDATOR,
} from "../../../tools/flow/test-support/registered-operation.mjs";

const BOOT_ID = "boot-public-owner-test";

/**
 * Deterministic registered-operation composition for public-process tests.
 * The authority remains the real durable RunAuthority; only the provider
 * operation is test-controlled.
 */
export async function createFlowRuntime({
  authorityDirectory,
  env = process.env,
} = {}) {
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity(
      BOOT_ID,
      `owner-process:${process.pid}`,
    ),
    timeObservationAdapter: fixedExecutionTimeAdapter({ bootId: BOOT_ID }),
    ...(typeof env.FLOW_PUBLIC_REPOSITORY === "string" ? {
      gitWorkspaceObservationAdapter: createGitWorkspaceObservationAdapter(),
      gitRetentionAdapter: createGitRetentionAdapter({
        resolveRepository() {
          return env.FLOW_PUBLIC_REPOSITORY;
        },
      }),
    } : {}),
  });
  const runtime = createCoreFlowRuntime({
    runAuthority: authority,
    autonomous: true,
    runnerOptions: {
      ...(env.FLOW_RUNNER_DELEGATE_CAPACITY === undefined ? {} : {
        delegateCapacity: Number(env.FLOW_RUNNER_DELEGATE_CAPACITY),
      }),
      ...(env.FLOW_RUNNER_OPERATION_CAPACITY === undefined ? {} : {
        operationCapacity: Number(env.FLOW_RUNNER_OPERATION_CAPACITY),
      }),
    },
    registeredQueries: {
      autonomous_runner_status() {
        return statusAutonomousFlowRuntime(runtime);
      },
    },
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        async invoke(intent) {
          const marker = `${authorityDirectory}/public-operation-invocations.log`;
          const before = await readFile(marker, "utf8").catch(() => "");
          if (before.split("\n").includes(intent.effect_id)) {
            return operationReceipt(intent, { record: intent.effect_id });
          }
          await appendFile(marker, `${intent.effect_id}\n`);
          // Leave the first admitted effect in flight long enough for the
          // owner-kill test to exercise same-boot recovery.
          if (before.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          return operationReceipt(intent, { record: intent.effect_id });
        },
      },
    },
  });
  return {
    ...runtime,
    mutationAuthority: true,
    // The owner process calls this optional hook after stopping transport.
    close() {
      authority.close();
    },
  };
}

export { BOOT_ID, OPERATION_RECEIPT_VALIDATOR, TEST_OPERATION_CONTRACT };
