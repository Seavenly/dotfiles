import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { dirname, resolve } from "node:path";
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
    bundle_digest: `sha256:${"2".repeat(64)}`,
    watermark: `sha256:${"4".repeat(64)}`,
    phase: "active",
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
  fold.legal_actions = [
    command,
    { ...command, decision: "decline" },
  ];
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

  const decline = withoutAmbientReads(() => LifecycleKernel.decide(fold, {
    ...command,
    decision: "decline",
  }));
  assert.deepEqual(decline.events.at(-1), { type: "run_declined" });

  const rejection = withoutAmbientReads(() => LifecycleKernel.decide(fold, {
    ...command,
    schema: "flow.command/v0",
  }));
  assert.deepEqual(rejection, {
    schema: "flow.rejection/v1",
    operation: "command",
    code: "invalid_command",
    reason: null,
    command_type: "checkpoint_decision",
    run_id: fold.run_id,
    bundle_digest: fold.bundle_digest,
    authority_watermark: fold.watermark,
    authority_watermark_domain: "run",
    legal_actions: fold.legal_actions,
  });
});

test("pure module imports cannot acquire ambient capabilities", () => {
  const sourceDirectory = resolve(import.meta.dirname, "../src");
  assert.doesNotThrow(() => assertPureModuleGraph([
    resolve(sourceDirectory, "plan-compiler.mjs"),
    resolve(sourceDirectory, "lifecycle-kernel.mjs"),
  ]));

  assert.throws(
    () => assertPureModuleGraph(["/virtual/impure.mjs"], {
      readSource(path) {
        assert.equal(path, "/virtual/impure.mjs");
        return 'import { readFileSync } from "node:fs";\n';
      },
    }),
    /pure module imports forbidden ambient capability: node:fs/,
  );

  assert.throws(
    () => assertPureModuleGraph(["/virtual/time.mjs"], {
      readSource(path) {
        assert.equal(path, "/virtual/time.mjs");
        return "export const observed = Date.now();\n";
      },
    }),
    /pure module uses forbidden ambient access: \/virtual\/time\.mjs/,
  );
});

function assertPureModuleGraph(entries, {
  readSource = (path) => readFileSync(path, "utf8"),
} = {}) {
  const visited = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const source = readSource(path);
    const usesAmbientAccess = [
      /\bprocess\./,
      /\b(?:globalThis\.)?Date(?:\.now|\s*\()/,
      /\bMath\.random\b/,
      /\b(?:globalThis\.)?performance\.now\b/,
      /\bfetch\s*\(/,
      /\brequire\s*\(/,
      /\bcreateRequire\b/,
    ].some((pattern) => pattern.test(source));
    if (usesAmbientAccess) {
      throw new Error(`pure module uses forbidden ambient access: ${path}`);
    }
    const specifiers = [
      ...source.matchAll(
        /\b(?:import|export)\s+(?:[^"'();]*?\s+from\s+)?["']([^"']+)["']/g,
      ),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (specifier === "node:crypto") continue;
      if (!specifier.startsWith(".")) {
        throw new Error(
          `pure module imports forbidden ambient capability: ${specifier}`,
        );
      }
      pending.push(resolve(dirname(path), specifier));
    }
  }
}

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
