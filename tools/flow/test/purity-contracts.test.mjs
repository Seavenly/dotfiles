import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import test from "node:test";
import tls from "node:tls";

import { LifecycleKernel } from "../src/lifecycle-kernel.mjs";
import { PlanCompiler } from "../src/plan-compiler.mjs";
import { dynamicCheckpointProposal } from "../test-support/dynamic-checkpoint.mjs";

test("PlanCompiler uses only the dynamic proposal and explicit facts", () => {
  const proposal = dynamicCheckpointProposal();
  const unchanged = structuredClone(proposal);

  const first = withoutAmbientReads(() => PlanCompiler.compile(proposal));
  const second = withoutAmbientReads(() =>
    PlanCompiler.compile(structuredClone(proposal)));

  assert.deepEqual(first, second);
  assert.deepEqual(proposal, unchanged);
});

test("LifecycleKernel uses only the authoritative fold and typed command", () => {
  const fold = {
    schema: "flow.run-fold/v1",
    run_id: `run:${"3".repeat(64)}`,
    watermark: `sha256:${"4".repeat(64)}`,
    cards: [
      {
        id: "confirm-plan",
        executor_kind: "checkpoint",
        status: "waiting_checkpoint",
      },
    ],
    legal_actions: [],
  };
  const command = {
    schema: "flow.command/v1",
    type: "checkpoint_decision",
    run_id: fold.run_id,
    checkpoint_id: "confirm-plan",
    decision: "approve",
    expected_watermark: fold.watermark,
  };
  const unchanged = structuredClone({ fold, command });

  const decision = withoutAmbientReads(() =>
    LifecycleKernel.decide(fold, command));

  assert.deepEqual(decision, {
    schema: "flow.decision/v1",
    command_type: "checkpoint_decision",
    events: [
      {
        type: "checkpoint_decided",
        checkpoint_id: "confirm-plan",
        decision: "approve",
      },
      { type: "run_succeeded" },
    ],
    effect_intents: [],
    obligations: [],
    projection_hints: ["operator", "graph"],
  });
  assert.deepEqual({ fold, command }, unchanged);
});

function withoutAmbientReads(callback) {
  const restores = [];
  const reject = (capability) => () => {
    throw new Error(`ambient ${capability} read`);
  };
  const replace = (object, key, replacement) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, {
      configurable: true,
      writable: true,
      value: replacement,
    });
    restores.push(() => {
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else delete object[key];
    });
  };

  const OriginalDate = globalThis.Date;
  class ForbiddenDate extends OriginalDate {
    constructor(...arguments_) {
      if (arguments_.length === 0) throw new Error("ambient time read");
      super(...arguments_);
    }

    static now() {
      throw new Error("ambient time read");
    }
  }
  replace(globalThis, "Date", ForbiddenDate);
  replace(Math, "random", reject("randomness"));
  replace(globalThis, "fetch", reject("provider"));
  replace(process, "cwd", reject("filesystem context"));
  replace(process, "hrtime", reject("monotonic time"));
  replace(process, "uptime", reject("process time"));
  replace(process, "cpuUsage", reject("process time"));
  replace(globalThis.performance, "now", reject("monotonic time"));
  for (const key of [
    "accessSync",
    "existsSync",
    "lstatSync",
    "openSync",
    "opendirSync",
    "readFileSync",
    "readdirSync",
    "readlinkSync",
    "realpathSync",
    "statSync",
  ]) {
    replace(fs, key, reject("filesystem or persistence"));
  }
  for (const key of [
    "access",
    "lstat",
    "open",
    "opendir",
    "readFile",
    "readdir",
    "readlink",
    "realpath",
    "stat",
  ]) {
    replace(fsPromises, key, reject("filesystem or persistence"));
  }
  for (const key of [
    "exec",
    "execFile",
    "execFileSync",
    "execSync",
    "fork",
    "spawn",
    "spawnSync",
  ]) {
    replace(childProcess, key, reject("Git or provider process"));
  }
  for (const [module, keys] of [
    [http, ["get", "request"]],
    [https, ["get", "request"]],
    [net, ["connect", "createConnection"]],
    [tls, ["connect"]],
    [dns, ["lookup", "resolve", "resolve4", "resolve6"]],
    [dnsPromises, ["lookup", "resolve", "resolve4", "resolve6"]],
  ]) {
    for (const key of keys) replace(module, key, reject("provider"));
  }

  try {
    return callback();
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}
