import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";

import { digestCanonical } from "../src/canonical-json.mjs";
import { HerdrClient } from "../src/herdr.mjs";
import { HERDR_OBSERVATION_TIMEOUT_MS } from "../src/limits.mjs";
import { stagedInputTextToken } from "../src/staged-input-receipt.mjs";
import { TraceRecorder } from "../src/trace.mjs";

async function executableFileIdentity(path) {
  const metadata = await stat(path);
  return {
    device: Number(metadata.dev),
    inode: Number(metadata.ino),
    size: Number(metadata.size),
    mtime_ms: metadata.mtimeMs,
  };
}

test("Herdr observations use the advertised command bound", async () => {
  const observedTimeouts = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args, options) {
      observedTimeouts.push(options.timeout);
      if (args.includes("session")) {
        return JSON.stringify({ sessions: [] });
      }
      return JSON.stringify({ result: { agents: [] } });
    },
  });

  await client.sessionRunning();
  await client.agentRecords();

  assert.deepEqual(observedTimeouts, [
    HERDR_OBSERVATION_TIMEOUT_MS,
    HERDR_OBSERVATION_TIMEOUT_MS,
  ]);
});

test("managed executable probing reads identity from the Herdr pane shell", async () => {
  const executablePath = process.execPath;
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    env: { PATH: "/managed/bin:/usr/bin" },
    delay: async () => {},
    async run(_file, args) {
      calls.push(args);
      if (args.includes("process-info")) {
        return JSON.stringify({
          result: {
            type: "pane_process_info",
            process_info: {
              pane_id: "pane-1",
              shell_pid: 10,
              foreground_processes: [{ pid: 10, name: "zsh" }],
            },
          },
        });
      }
      if (args.includes("run")) return JSON.stringify({ result: {} });
      if (args.includes("integration")) return "codex: current (v6)\n";
      if (args.includes("read")) {
        const command = calls.find((candidate) => candidate.includes("run"))?.at(-1);
        const marker = command.match(/DROVR_RUNTIME_ID_[0-9a-f]+/u)[0];
        return `${marker}\t${executablePath}\tcodex-cli 0.145.0\t/managed/bin:/usr/bin\n`;
      }
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  });

  const identity = await client.probeManagedExecutable({
    paneId: "pane-1",
    harness: "codex",
  });

  assert.equal(identity.schema, "drovr.managed-pane-runtime-identity/v1");
  assert.equal(identity.pane_id, "pane-1");
  assert.equal(identity.executable.canonical_path, executablePath);
  assert.equal(identity.executable.version, "codex-cli 0.145.0");
  assert.equal(identity.native_session, null);
  assert.equal(calls.some((args) => args.includes("pane") && args.includes("run")), true);
  assert.equal(calls.some((args) => args.includes("pane") && args.includes("read")), true);
});

test("managed runtime capture binds native session and foreground process identity", async () => {
  const executablePath = process.execPath;
  const fileIdentity = await executableFileIdentity(executablePath);
  const trace = new TraceRecorder({
    scenarioId: "managed-runtime-identity",
    provenance: {
      drovr: "drovr 0.1.0",
      herdr: "herdr 0.8.0",
      claude: "2.1.199 (Claude Code)",
      codex: "codex-cli 0.145.0",
    },
  });
  const client = new HerdrClient({
    session: "delegates",
    env: { PATH: "/managed/bin:/usr/bin" },
    trace,
    async run(file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              pane_id: "pane-1",
              agent_status: "idle",
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      if (args.includes("process-info")) {
        return JSON.stringify({
          result: {
            type: "pane_process_info",
            process_info: {
              pane_id: "pane-1",
              foreground_processes: [{
                pid: 2147483647,
                name: "codex",
                argv: ["codex", "--sandbox", "read-only"],
                cmdline: "codex --sandbox read-only",
                cwd: "/workspace",
              }],
            },
          },
        });
      }
      if (file === "ps" && args[0] === "eww") {
        return "codex --sandbox read-only PATH=/managed/bin:/usr/bin HOME=/workspace\n";
      }
      if (file === "lsof") return `p2147483647\nn${executablePath}\n`;
      if (file === executablePath && args[0] === "--version") {
        return "codex-cli 0.145.0\n";
      }
      if (file === "herdr" && args[0] === "integration") {
        return "codex: current (v6)\n";
      }
      throw new Error(`unexpected Herdr call: ${file} ${args.join(" ")}`);
    },
  });
  const executable = {
    schema: "drovr.managed-pane-runtime-identity/v1",
    harness: "codex",
    pane_id: "pane-1",
    executable: {
      observed_path: executablePath,
      canonical_path: executablePath,
      version: "codex-cli 0.145.0",
      file_identity: fileIdentity,
    },
    managed_path_digest: digestCanonical("/managed/bin:/usr/bin"),
  };

  const identity = await client.captureManagedRuntimeIdentity({
    agentName: "managed-agent",
    paneId: "pane-1",
    harness: "codex",
    executable,
    model: "gpt-5.6-sol",
    effort: "high",
  });

  assert.equal(identity.native_session, "native-1");
  assert.equal(identity.process.pid, 2147483647);
  assert.equal(identity.process.argv0, "codex");
  assert.deepEqual(identity.process.argv, ["codex", "--sandbox", "read-only"]);
  assert.equal(identity.integration, "herdr-codex/v6");
  assert.equal(identity.model, "gpt-5.6-sol");
  assert.equal(identity.effort, "high");
  const traceIdentity = trace.trace().events.find(
    ({ operation }) => operation === "agent.runtime-identity",
  ).payload.managed_runtime_identity;
  assert.equal(traceIdentity.native_session, "native-1");
  assert.match(
    traceIdentity.executable.canonical_path,
    /^<path:sha256:[0-9a-f]{64}>$/u,
  );
});

test("managed runtime capture blocks a same-path executable replacement", async () => {
  const executablePath = process.execPath;
  const fileIdentity = await executableFileIdentity(executablePath);
  const client = new HerdrClient({
    session: "delegates",
    env: { PATH: "/managed/bin:/usr/bin" },
    async run(file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              pane_id: "pane-1",
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      if (args.includes("process-info")) {
        return JSON.stringify({
          result: {
            type: "pane_process_info",
            process_info: {
              pane_id: "pane-1",
              foreground_processes: [{
                pid: 2147483647,
                name: "codex",
                argv0: executablePath,
                argv: [executablePath],
                cmdline: executablePath,
                cwd: "/workspace",
              }],
            },
          },
        });
      }
      if (file === "ps" && args[0] === "eww") {
        return `${executablePath} PATH=/managed/bin:/usr/bin HOME=/workspace\n`;
      }
      if (file === "lsof") return `p2147483647\nn${executablePath}\n`;
      if (file === executablePath && args[0] === "--version") {
        return "codex-cli 0.145.0\n";
      }
      if (file === "herdr" && args[0] === "integration") {
        return "codex: current (v6)\n";
      }
      throw new Error(`unexpected Herdr call: ${file} ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    () => client.captureManagedRuntimeIdentity({
      agentName: "managed-agent",
      paneId: "pane-1",
      harness: "codex",
      executable: {
        schema: "drovr.managed-pane-runtime-identity/v1",
        harness: "codex",
        pane_id: "pane-1",
        executable: {
          observed_path: executablePath,
          canonical_path: executablePath,
          version: "codex-cli 0.145.0",
          file_identity: { ...fileIdentity, inode: fileIdentity.inode + 1 },
        },
        managed_path_digest: digestCanonical("/managed/bin:/usr/bin"),
      },
      model: "gpt-5.6-sol",
      effort: "high",
    }),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.reason === "changed",
  );
});

test("managed runtime capture blocks a foreground process with the wrong executable", async () => {
  const executablePath = process.execPath;
  const client = new HerdrClient({
    session: "delegates",
    async run(file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              pane_id: "pane-1",
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      if (args.includes("process-info")) {
        return JSON.stringify({
          result: {
            type: "pane_process_info",
            process_info: {
              pane_id: "pane-1",
              foreground_processes: [{
                pid: 2147483647,
                name: "codex",
                argv0: "/opt/other/codex",
                argv: ["/opt/other/codex", "--sandbox", "read-only"],
                cmdline: "/opt/other/codex --sandbox read-only",
                cwd: "/workspace",
              }],
            },
          },
        });
      }
      if (file === "lsof") return "p2147483647\nn/opt/other/codex\n";
      if (file === executablePath && args[0] === "--version") {
        return "codex-cli 0.145.0\n";
      }
      if (file === "herdr" && args[0] === "integration") {
        return "codex: current (v6)\n";
      }
      throw new Error(`unexpected Herdr call: ${file} ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    () => client.captureManagedRuntimeIdentity({
      agentName: "managed-agent",
      paneId: "pane-1",
      harness: "codex",
      executable: {
        schema: "drovr.managed-pane-runtime-identity/v1",
        harness: "codex",
        pane_id: "pane-1",
        executable: {
          observed_path: executablePath,
          canonical_path: executablePath,
          version: "codex-cli 0.145.0",
          file_identity: { device: 1, inode: 2, size: 3, mtime_ms: 4 },
        },
        managed_path_digest: digestCanonical("/managed/bin:/usr/bin"),
      },
      model: "gpt-5.6-sol",
      effort: "high",
    }),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.reason === "missing",
  );
});

test("managed runtime capture blocks a foreground process without a cwd", async () => {
  const executablePath = process.execPath;
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              pane_id: "pane-1",
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      if (args.includes("process-info")) {
        return JSON.stringify({
          result: {
            type: "pane_process_info",
            process_info: {
              pane_id: "pane-1",
              foreground_processes: [{
                pid: 2147483647,
                name: "codex",
                argv0: executablePath,
                argv: [executablePath],
                cmdline: executablePath,
                cwd: null,
              }],
            },
          },
        });
      }
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    () => client.captureManagedRuntimeIdentity({
      agentName: "managed-agent",
      paneId: "pane-1",
      harness: "codex",
      executable: {
        schema: "drovr.managed-pane-runtime-identity/v1",
        harness: "codex",
        pane_id: "pane-1",
        executable: {
          observed_path: executablePath,
          canonical_path: executablePath,
          version: "codex-cli 0.145.0",
          file_identity: { device: 1, inode: 2, size: 3, mtime_ms: 4 },
        },
        managed_path_digest: digestCanonical("/managed/bin:/usr/bin"),
      },
      model: "gpt-5.6-sol",
      effort: "high",
    }),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.reason === "missing",
  );
});

test("managed runtime observation blocks a changed managed PATH", async () => {
  const executablePath = process.execPath;
  const client = new HerdrClient({
    session: "delegates",
    async run(file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              pane_id: "pane-1",
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      if (args.includes("process-info")) {
        return JSON.stringify({
          result: {
            type: "pane_process_info",
            process_info: {
              pane_id: "pane-1",
              foreground_processes: [{
                pid: 2147483647,
                name: "codex",
                argv0: executablePath,
                argv: [executablePath],
                cmdline: executablePath,
                cwd: "/workspace",
              }],
            },
          },
        });
      }
      if (file === "ps" && args[0] === "eww") {
        return `${executablePath} PATH=/changed/bin:/usr/bin HOME=/workspace\n`;
      }
      if (file === "lsof") return `p2147483647\nn${executablePath}\n`;
      if (file === executablePath && args[0] === "--version") {
        return "codex-cli 0.145.0\n";
      }
      if (file === "herdr" && args[0] === "integration") {
        return "codex: current (v6)\n";
      }
      throw new Error(`unexpected Herdr call: ${file} ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    () => client.observeManagedRuntime({
      agentName: "managed-agent",
      harness: "codex",
      expectedIdentity: {
        schema: "drovr.managed-pane-runtime-identity/v1",
        harness: "codex",
        managed_agent: "managed-agent",
        pane_id: "pane-1",
        executable: {
          observed_path: executablePath,
          canonical_path: executablePath,
          version: "codex-cli 0.145.0",
          file_identity: { device: 1, inode: 2, size: 3, mtime_ms: 4 },
        },
        managed_path_digest: digestCanonical("/managed/bin:/usr/bin"),
        native_session: "native-1",
        process: {
          pid: 2147483647,
          name: "codex",
          argv0: executablePath,
          argv: [executablePath],
          cmdline: executablePath,
          cwd: "/workspace",
        },
        caller_path_digest: digestCanonical(String(process.env.PATH ?? "")),
        model: "gpt-5.6-sol",
        effort: "high",
      },
      model: "gpt-5.6-sol",
      effort: "high",
    }),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.reason === "changed",
  );
});

test("managed runtime observation ignores caller PATH drift", async () => {
  const expectedIdentity = {
    schema: "drovr.managed-pane-runtime-identity/v1",
    harness: "codex",
    managed_agent: "managed-agent",
    pane_id: "pane-1",
    executable: {
      observed_path: "/opt/codex/bin/codex",
      canonical_path: "/opt/codex/bin/codex",
      version: "codex-cli 0.145.0",
      file_identity: { device: 1, inode: 2, size: 3, mtime_ms: 4 },
    },
    managed_path_digest: `sha256:${"1".repeat(64)}`,
    caller_path_digest: `sha256:${"2".repeat(64)}`,
    integration: "herdr-codex/v6",
    native_session: "native-1",
    process: {
      pid: 2147483647,
      name: "codex",
      argv0: "/opt/codex/bin/codex",
      argv: ["/opt/codex/bin/codex"],
      cmdline: "/opt/codex/bin/codex",
      cwd: "/workspace",
    },
    model: "gpt-5.6-sol",
    effort: "high",
  };
  const client = new HerdrClient({
    session: "delegates",
    env: { PATH: "/caller/changed" },
  });
  client.captureManagedRuntimeIdentity = async () => ({
    ...structuredClone(expectedIdentity),
    caller_path_digest: `sha256:${"3".repeat(64)}`,
  });

  const observed = await client.observeManagedRuntime({
    agentName: "managed-agent",
    harness: "codex",
    expectedIdentity,
  });

  assert.equal(
    observed.caller_path_digest,
    `sha256:${"3".repeat(64)}`,
  );
});

test("managed runtime capture uses exact-process ps and lsof fallbacks when Herdr omits PATH", async () => {
  const executablePath = process.execPath;
  const fileIdentity = await executableFileIdentity(executablePath);
  const client = new HerdrClient({
    session: "delegates",
    async run(file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              pane_id: "pane-1",
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      if (args.includes("process-info")) {
        return JSON.stringify({
          result: {
            type: "pane_process_info",
            process_info: {
              pane_id: "pane-1",
              foreground_processes: [{
                pid: 4294967294,
                name: "codex",
                argv0: "codex",
                argv: ["codex"],
                cmdline: "codex",
                cwd: "/workspace",
              }],
            },
          },
        });
      }
      if (file === "ps") {
        return `codex PATH=/managed/bin:/usr/bin PWD=/workspace\n`;
      }
      if (file === "lsof") {
        return `p4294967294\nn${executablePath}\n`;
      }
      if (file === executablePath && args[0] === "--version") {
        return "codex-cli 0.145.0\n";
      }
      if (file === "herdr" && args[0] === "integration") {
        return "codex: current (v6)\n";
      }
      throw new Error(`unexpected Herdr call: ${file} ${args.join(" ")}`);
    },
  });

  const identity = await client.captureManagedRuntimeIdentity({
    agentName: "managed-agent",
    paneId: "pane-1",
    harness: "codex",
    executable: {
      schema: "drovr.managed-pane-runtime-identity/v1",
      harness: "codex",
      pane_id: "pane-1",
      executable: {
        observed_path: executablePath,
        canonical_path: executablePath,
        version: "codex-cli 0.145.0",
        file_identity: fileIdentity,
      },
      managed_path_digest: digestCanonical("/managed/bin:/usr/bin"),
    },
    model: "gpt-5.6-sol",
    effort: "high",
  });

  assert.equal(identity.managed_path_digest, digestCanonical("/managed/bin:/usr/bin"));
});

test("Herdr mutations do not inherit the observation bound", async () => {
  let observedTimeout;
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, _args, options) {
      observedTimeout = options.timeout;
      return "";
    },
  });

  await client.interruptAgent("managed-agent");

  assert.equal(observedTimeout, undefined);
});

test("guarded interruption rejects a remapped native target before sending keys", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              pane_id: "pane-1",
              agent_session: { value: "native-after" },
            }],
          },
        });
      }
      throw new Error("interrupt should not be delivered");
    },
  });

  await assert.rejects(
    () => client.interruptAgent("managed-agent", {
      nativeSession: "native-before",
      paneId: "pane-1",
    }),
    (error) => error.outcome === "recovery_blocked",
  );
  assert.equal(calls.some((args) => args.includes("send-keys")), false);
});

test("guarded prompt rejects a changed native session before delivery", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "working",
              agent_session: { value: "native-after" },
            }],
          },
        });
      }
      throw new Error("prompt should not be delivered");
    },
  });

  await assert.rejects(
    () => client.prompt("managed-agent", "QUALIFY-IDENTITY-GUARD", {
      nativeSession: "native-before",
    }),
    (error) => {
      assert.equal(error.outcome, "recovery_blocked");
      return true;
    },
  );
  assert.equal(calls.some((args) => args.includes("prompt")), false);
});

test("guarded prompt reports uncertainty when native session is unavailable", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "working",
            }],
          },
        });
      }
      throw new Error("prompt should not be delivered");
    },
  });

  await assert.rejects(
    () => client.prompt("managed-agent", "QUALIFY-IDENTITY-UNKNOWN", {
      nativeSession: "native-before",
    }),
    (error) => {
      assert.equal(error.outcome, "uncertain");
      return true;
    },
  );
  assert.equal(calls.some((args) => args.includes("prompt")), false);
});

test("guarded pane excerpts reject a changed native session before reading", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "blocked",
              agent_session: { value: "caller-session" },
            }],
          },
        });
      }
      throw new Error("mismatched pane should not be read");
    },
  });

  await assert.rejects(
    () => client.agentExcerpt("managed-agent", { nativeSession: "managed-session" }),
    (error) => {
      assert.equal(error.outcome, "recovery_blocked");
      return true;
    },
  );
  assert.equal(calls.some((args) => args.includes("read")), false);
});

test("guarded pane excerpts report uncertainty when native session is unavailable", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "blocked",
            }],
          },
        });
      }
      throw new Error("unavailable identity should not permit a pane read");
    },
  });

  await assert.rejects(
    () => client.agentExcerpt("managed-agent", { nativeSession: "native-before" }),
    (error) => {
      assert.equal(error.outcome, "uncertain");
      return true;
    },
  );
  assert.equal(calls.some((args) => args.includes("read")), false);
});

test("literal staged input targets the exact managed pane without a submit key", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      return JSON.stringify({ result: { status: "sent" } });
    },
  });

  await client.sendPaneText("pane-agent-1", "QUALIFY-UNKNOWN-STAGED");

  assert.deepEqual(calls, [[
    "--session",
    "delegates",
    "pane",
    "send-text",
    "pane-agent-1",
    "QUALIFY-UNKNOWN-STAGED",
  ]]);
});

test("guarded staged input rejects a remapped pane before sending text", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              pane_id: "pane-after",
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      throw new Error("staged text should not be sent");
    },
  });

  await assert.rejects(
    () => client.sendPaneText("pane-before", "QUALIFY-UNKNOWN-STAGED", {
      agentName: "managed-agent",
      nativeSession: "native-1",
    }),
    (error) => error.outcome === "recovery_blocked",
  );
  assert.equal(calls.some((args) => args.includes("send-text")), false);
});

test("Herdr waits preserve their caller-selected bound", async () => {
  const observedTimeouts = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args, options) {
      observedTimeouts.push(options.timeout);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{ name: "managed-agent", agent_status: "working" }],
          },
        });
      }
      return JSON.stringify({
        result: {
          agent: { name: "managed-agent", agent_status: "idle" },
        },
      });
    },
  });

  await client.waitForAgent("managed-agent", 300_000);

  assert.deepEqual(observedTimeouts, [
    HERDR_OBSERVATION_TIMEOUT_MS,
    undefined,
  ]);
});

test("Claude prompt delivery refuses to append over staged prompt text", async () => {
  let promptCalls = 0;
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      if (args.includes("read")) {
        return "────────\n❯ Existing staged work\n────────";
      }
      if (args.includes("prompt")) promptCalls += 1;
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    client.prompt("managed-agent", "New work", {
      harness: "claude",
      observedBeforeDelivery: {
        agent_status: "idle",
        agent_session: { value: "native-1" },
        pane_id: "pane-1",
        state_change_seq: 12,
      },
    }),
    {
      code: 4,
      outcome: "adapter_failure",
    },
  );
  assert.equal(promptCalls, 0);
});

test("Claude staged input recovery submits only the exact inspected prompt", async () => {
  let submitted = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("read")) {
        return "────────\n❯ Exact staged work\n────────";
      }
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: submitted ? "working" : "idle",
                state_change_seq: submitted ? 13 : 12,
              },
            ],
          },
        });
      }
      if (args.includes("send-keys")) submitted = true;
      return JSON.stringify({ result: {} });
    },
  });

  const staged = await client.inspectStagedInput("managed-agent", {
    harness: "claude",
  });
  assert.equal(staged.display_text, "Exact staged work");

  await client.recoverStagedInput("managed-agent", {
    harness: "claude",
    action: "submit",
    token: staged.token,
    transitionToken: 12,
  });

  assert.equal(submitted, true);
});

test("Claude staged recovery checks identity immediately before the final snapshot inspection", async () => {
  let submitted = false;
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("read")) {
        calls.push("read");
        return "────────\n❯ Exact staged work\n────────";
      }
      if (args.includes("list")) {
        calls.push("list");
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                pane_id: "pane-1",
                agent_status: submitted ? "working" : "idle",
                state_change_seq: submitted ? 13 : 12,
                agent_session: { value: "native-1" },
              },
            ],
          },
        });
      }
      if (args.includes("send-keys")) {
        calls.push("send-keys");
        submitted = true;
      }
      return JSON.stringify({ result: {} });
    },
  });

  const staged = await client.inspectStagedInput("managed-agent", {
    harness: "claude",
  });
  calls.length = 0;

  await client.recoverStagedInput("managed-agent", {
    harness: "claude",
    action: "submit",
    nativeSession: "native-1",
    paneId: "pane-1",
    token: staged.token,
    transitionToken: 12,
  });

  const sendIndex = calls.indexOf("send-keys");
  assert.deepEqual(calls.slice(0, sendIndex), ["list", "read"]);
  assert.equal(calls[sendIndex - 1], "read");
});

test("Claude failed submission returns an exact Drovr-owned staged-input receipt", async () => {
  let promptSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("read")) {
        return promptSent
          ? "────────\n❯ Exact Drovr work\n────────"
          : "────────\n❯\n────────";
      }
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "idle",
                state_change_seq: 12,
              },
            ],
          },
        });
      }
      if (args.includes("prompt")) promptSent = true;
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    client.prompt("managed-agent", "Exact Drovr work", {
      harness: "claude",
      observedBeforeDelivery: {
        agent_status: "idle",
        agent_session: { value: "native-1" },
        pane_id: "pane-1",
        state_change_seq: 12,
      },
    }),
    (error) => {
      assert.equal(error.outcome, "adapter_failure");
      assert.equal(error.details.staged_input.ownership, "drovr");
      assert.equal(error.details.staged_input.display_text, "Exact Drovr work");
      assert.equal(error.details.staged_input.agent_name, "managed-agent");
      assert.equal(error.details.staged_input.pane_id, "pane-1");
      assert.equal(error.details.staged_input.native_session, "native-1");
      assert.equal(
        error.details.staged_input.state_change_seq_before_delivery,
        12,
      );
      assert.match(error.details.staged_input.token, /^[a-f0-9]{64}$/u);
      return true;
    },
  );
});

test("Claude delivery never claims a prompt box with appended operator text", async () => {
  let promptSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("read")) {
        return promptSent
          ? "────────\n❯ Exact Drovr work plus operator text\n────────"
          : "────────\n❯\n────────";
      }
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "idle",
                state_change_seq: 12,
              },
            ],
          },
        });
      }
      if (args.includes("prompt")) promptSent = true;
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    client.prompt("managed-agent", "Exact Drovr work", {
      harness: "claude",
      observedBeforeDelivery: {
        agent_status: "idle",
        state_change_seq: 12,
      },
    }),
    (error) => {
      assert.equal(error.outcome, "adapter_failure");
      assert.equal(error.details, undefined);
      return true;
    },
  );
});

test("Claude staged input recovery clears only the exact inspected prompt", async () => {
  let cleared = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("read")) {
        return cleared
          ? "────────\n❯\n────────"
          : "────────\n❯ Exact staged work\n────────";
      }
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "idle",
                state_change_seq: cleared ? 13 : 12,
                agent_session: { value: "native-1" },
              },
            ],
          },
        });
      }
      if (args.includes("send-keys")) {
        assert.deepEqual(args.slice(-2), ["esc", "esc"]);
        cleared = true;
      }
      return JSON.stringify({ result: {} });
    },
  });
  const staged = await client.inspectStagedInput("managed-agent", {
    harness: "claude",
  });

  await client.recoverStagedInput("managed-agent", {
    action: "clear",
    harness: "claude",
    nativeSession: "native-1",
    token: staged.token,
    transitionToken: 12,
  });

  assert.equal(cleared, true);
  assert.equal(
    await client.inspectStagedInput("managed-agent", { harness: "claude" }),
    null,
  );
});

test("Claude staged input recovery rejects a stale native transition before sending keys", async () => {
  let sendKeys = 0;
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "idle",
              state_change_seq: 2,
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      if (args.includes("read")) {
        return "────────\n❯ Exact staged work\n────────";
      }
      if (args.includes("send-keys")) sendKeys += 1;
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    () =>
      client.recoverStagedInput("managed-agent", {
        action: "clear",
        harness: "claude",
        nativeSession: "native-1",
        token: stagedInputTextToken("Exact staged work"),
        transitionToken: 1,
      }),
    (error) => error.outcome === "recovery_blocked",
  );
  assert.equal(sendKeys, 0);
});

test("Claude staged input recovery requires an exact native transition token", async () => {
  let sendKeys = 0;
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "idle",
              state_change_seq: 2,
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      if (args.includes("read")) {
        return "────────\n❯ Exact staged work\n────────";
      }
      if (args.includes("send-keys")) sendKeys += 1;
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    () =>
      client.recoverStagedInput("managed-agent", {
        action: "clear",
        harness: "claude",
        nativeSession: "native-1",
        token: stagedInputTextToken("Exact staged work"),
      }),
    (error) => error.outcome === "recovery_blocked",
  );
  assert.equal(sendKeys, 0);
});

test("Claude prompt delivery falls back when native submission remains unobserved", async () => {
  const prompt = "x".repeat(1200);
  let delaySteps = 0;
  let promptSent = false;
  let enterSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {
      if (promptSent) delaySteps += 1;
    },
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: enterSent ? "working" : "idle",
                state_change_seq: enterSent ? 14 : 13,
              },
            ],
          },
        });
      }
      if (args.includes("read")) {
        if (!promptSent) return "";
        return delaySteps >= 3 ? "[Pasted text #1 +1 lines]" : "";
      }
      if (args.includes("prompt")) promptSent = true;
      if (args.includes("send-keys")) enterSent = true;
      return JSON.stringify({ result: {} });
    },
  });

  await client.prompt("managed-agent", prompt, {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(enterSent, true);
  assert.equal(delaySteps, 100);
});

test("Claude long single-line delivery does not add a second submission", async () => {
  const prompt = "x".repeat(1600);
  let delaySteps = 0;
  let promptSent = false;
  let enterSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {
      delaySteps += 1;
    },
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: enterSent ? "working" : "done",
              state_change_seq: enterSent ? 14 : 13,
            }],
          },
        });
      }
      if (args.includes("read")) {
        return promptSent && delaySteps >= 2 ? "[Pasted text #1 +1 lines]" : "";
      }
      if (args.includes("prompt")) promptSent = true;
      if (args.includes("send-keys")) enterSent = true;
      return JSON.stringify({ result: {} });
    },
  });

  await client.prompt("managed-agent", prompt, {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(enterSent, false);
  assert.equal(delaySteps, 0);
});

test("Claude long single-line delivery does not require Drovr-side attachment polling", async () => {
  const prompt = "x".repeat(1600);
  let enterSent = false;
  let delaySteps = 0;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {
      delaySteps += 1;
    },
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: enterSent ? "working" : "done",
              state_change_seq: enterSent ? 14 : 13,
            }],
          },
        });
      }
      if (args.includes("read")) return "";
      if (args.includes("send-keys")) enterSent = true;
      return JSON.stringify({ result: {} });
    },
  });

  await client.prompt("managed-agent", prompt, {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });
  assert.equal(enterSent, false);
  assert.equal(delaySteps, 0);
});

test("Claude prompt delivery does not send another Enter after work starts", async () => {
  let extraEnters = 0;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "working",
                state_change_seq: 13,
              },
            ],
          },
        });
      }
      if (args.includes("read")) return "";
      if (args.includes("send-keys")) extraEnters += 1;
      return JSON.stringify({ result: {} });
    },
  });

  await client.prompt("managed-agent", "first line\nsecond line", {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(extraEnters, 0);
});

test("Claude prompt delivery trusts Herdr 0.8 native prompt submission", async () => {
  let promptSent = false;
  let extraEnters = 0;
  let delaySteps = 0;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {
      delaySteps += 1;
    },
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: promptSent && delaySteps >= 12 ? "working" : "idle",
              state_change_seq: promptSent && delaySteps >= 12 ? 13 : 12,
            }],
          },
        });
      }
      if (args.includes("read")) {
        return promptSent ? "[Pasted text #1 +1 lines]" : "";
      }
      if (args.includes("prompt")) promptSent = true;
      if (args.includes("send-keys")) extraEnters += 1;
      return JSON.stringify({ result: {} });
    },
  });

  await client.prompt("managed-agent", "first line\nsecond line", {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(extraEnters, 0);
});

test("agent wait returns Herdr's atomic settled agent observation", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "working",
                state_change_seq: 9,
              },
            ],
          },
        });
      }
      return JSON.stringify({
        id: "cli:agent:wait",
        result: {
          type: "agent_info",
          agent: {
            name: "managed-agent",
            agent_status: "blocked",
            state_change_seq: 10,
            agent_session: { value: "native-session-1" },
          },
        },
      });
    },
  });

  const observed = await client.waitForAgent("managed-agent", 5000);

  assert.deepEqual(observed, {
    name: "managed-agent",
    agent_status: "blocked",
    state_change_seq: 10,
    agent_session: { value: "native-session-1" },
  });
  assert.deepEqual(calls, [
    ["--session", "delegates", "agent", "list"],
    [
      "--session",
      "delegates",
      "agent",
      "wait",
      "managed-agent",
      "--timeout",
      "5000",
    ],
  ]);
});

test("agent wait rounds fractional milliseconds for Herdr's integer CLI option", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{ name: "managed-agent", agent_status: "working" }],
          },
        });
      }
      return JSON.stringify({
        result: {
          agent: { name: "managed-agent", agent_status: "idle" },
        },
      });
    },
  });

  await client.waitForAgent("managed-agent", 179535.280282);

  assert.equal(calls.at(-1).at(-1), "179535");
});

test("agent wait returns an already settled observation without blocking", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "idle",
                state_change_seq: 13,
              },
            ],
          },
        });
      }
      throw new Error("blocking agent wait must not run");
    },
  });

  const observed = await client.waitForAgent("managed-agent", 5000);

  assert.equal(observed.agent_status, "idle");
  assert.deepEqual(calls, [
    ["--session", "delegates", "agent", "list"],
  ]);
});

test("native recovery resumes the registered Codex and Claude sessions", async () => {
  for (const [harness, resume, expected] of [
    ["codex", "resumeCodexAgent", ["resume", "native-session-1"]],
    ["claude", "resumeClaudeAgent", ["--resume", "native-session-1"]],
  ]) {
    const calls = [];
    const client = new HerdrClient({
      session: "delegates",
      async run(_file, args) {
        calls.push(args);
        if (args.includes("process-info")) {
          return JSON.stringify({
            result: {
              type: "pane_process_info",
              process_info: {
                pane_id: "pane-1",
                shell_pid: 10,
                foreground_processes: [{ pid: 10, name: "zsh" }],
              },
            },
          });
        }
        return JSON.stringify({ result: {} });
      },
    });
    const specification = {
      harness,
      model: harness === "codex" ? "gpt-5.6-luna" : "haiku",
      effort: "low",
      instructions: "",
      native:
        harness === "codex"
          ? { sandbox: "read-only", approval: "never", search: false }
          : { permission_mode: "dontAsk" },
    };

    await client[resume]({
      name: `managed-${harness}`,
      paneId: `pane-${harness}`,
      label: harness,
      specification,
      nativeSession: "native-session-1",
    });

    const start = calls.find(
      (args) => args.includes("agent") && args.includes("start"),
    );
    const separator = start.indexOf("--");
    const nativeArguments = start.slice(separator + 1);
    assert.equal(start[start.indexOf("--kind") + 1], harness);
    const resumeIndex = nativeArguments.indexOf(expected[0]);
    assert.notEqual(resumeIndex, -1);
    assert.deepEqual(
      nativeArguments.slice(resumeIndex, resumeIndex + expected.length),
      expected,
    );
    if (harness === "codex") assert.equal(resumeIndex, 0);
  }
});

test("pane placement uses Herdr layout and split commands with exact resources", async () => {
  const calls = [];
  const layout = {
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    zoomed: false,
    area: { x: 0, y: 0, width: 120, height: 40 },
    focused_pane_id: "pane-1",
    panes: [
      {
        pane_id: "pane-1",
        focused: true,
        rect: { x: 0, y: 0, width: 120, height: 40 },
      },
    ],
    splits: [],
  };
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("layout")) {
        return JSON.stringify({ result: { type: "pane_layout", layout } });
      }
      return JSON.stringify({
        result: {
          type: "pane_created",
          pane: { pane_id: "pane-2", tab_id: "tab-1" },
        },
      });
    },
  });

  assert.deepEqual(await client.paneLayout("pane-1"), layout);
  assert.equal(
    await client.splitPane({
      paneId: "pane-1",
      direction: "right",
      ratio: 0.5,
      cwd: "/work",
    }),
    "pane-2",
  );
  assert.deepEqual(calls, [
    ["--session", "delegates", "pane", "layout", "--pane", "pane-1"],
    [
      "--session",
      "delegates",
      "pane",
      "split",
      "--pane",
      "pane-1",
      "--direction",
      "right",
      "--ratio",
      "0.5",
      "--cwd",
      "/work",
      "--no-focus",
    ],
  ]);
});
