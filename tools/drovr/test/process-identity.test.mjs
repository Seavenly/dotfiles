import assert from "node:assert/strict";
import test from "node:test";

import {
  processEnvironmentPath,
  processExecutablePath,
} from "../src/process-identity.mjs";

test("process environment lookup reads a NUL-delimited proc environment", async () => {
  let fallbackCalls = 0;
  const path = await processEnvironmentPath(42, {
    async run() {
      fallbackCalls += 1;
      return "";
    },
  }, {
    readFileImpl: async (file) => {
      assert.equal(file, "/proc/42/environ");
      return Buffer.from("HOME=/home/test\0PATH=/managed/bin:/usr/bin\0PWD=/workspace\0");
    },
  });

  assert.equal(path, "/managed/bin:/usr/bin");
  assert.equal(fallbackCalls, 0);
});

test("process environment lookup parses PATH from a multi-assignment ps eww line", async () => {
  for (const { output, commandLine } of [
    {
      output: "codex --sandbox read-only HOME=/home/test PWD=/workspace PATH=/managed/bin:/usr/bin\n",
    },
    {
      output: "env PATH=/caller/bin codex PATH=/managed/bin:/usr/bin\n",
      commandLine: "env PATH=/caller/bin codex",
    },
  ]) {
    const calls = [];
    const path = await processEnvironmentPath(42, {
      env: { PATH: "/caller/bin" },
      async run(file, args, options) {
        calls.push({ file, args, options });
        return output;
      },
    }, {
      commandLine,
      readFileImpl: async () => {
        throw new Error("/proc unavailable");
      },
    });

    assert.equal(path, "/managed/bin:/usr/bin");
    assert.deepEqual(calls, [{
      file: "ps",
      args: ["eww", "-p", "42", "-o", "command="],
      options: { env: { PATH: "/caller/bin" } },
    }]);
  }
});

test("process executable lookup accepts the proc executable identity", async () => {
  const expectedPath = "/opt/codex/bin/codex";
  let fallbackCalls = 0;
  const path = await processExecutablePath({ pid: 42 }, new Set([expectedPath]), {
    async run() {
      fallbackCalls += 1;
      return "";
    },
  }, {
    realpathImpl: async (file) => {
      assert.equal(file, "/proc/42/exe");
      return expectedPath;
    },
  });

  assert.equal(path, expectedPath);
  assert.equal(fallbackCalls, 0);
});

test("process executable lookup falls back to ps comm", async () => {
  const expectedPath = "/opt/codex/bin/codex";
  const calls = [];
  const path = await processExecutablePath({ pid: 42 }, new Set([expectedPath]), {
    env: { PATH: "/caller/bin" },
    async run(file, args) {
      calls.push([file, args]);
      return `${expectedPath}\n`;
    },
  }, {
    realpathImpl: async (file) => {
      if (file === "/proc/42/exe") throw new Error("/proc unavailable");
      return file;
    },
  });

  assert.equal(path, expectedPath);
  assert.deepEqual(calls, [["ps", ["-p", "42", "-o", "comm="]]]);
});

test("process executable lookup falls back to lsof after non-path ps results", async () => {
  const expectedPath = "/opt/codex/bin/codex";
  const calls = [];
  const path = await processExecutablePath({ pid: 42 }, new Set([expectedPath]), {
    env: { PATH: "/caller/bin" },
    async run(file, args) {
      calls.push([file, args]);
      if (file === "lsof") return `p42\nn${expectedPath}\n`;
      return "codex\n";
    },
  }, {
    realpathImpl: async (file) => {
      if (file === "/proc/42/exe") throw new Error("/proc unavailable");
      return file;
    },
  });

  assert.equal(path, expectedPath);
  assert.deepEqual(calls, [
    ["ps", ["-p", "42", "-o", "comm="]],
    ["ps", ["-p", "42", "-o", "command="]],
    ["lsof", ["-p", "42", "-a", "-d", "txt", "-Fn"]],
  ]);
});

test("process executable lookup rejects a proc mismatch without fallback", async () => {
  let fallbackCalls = 0;
  const path = await processExecutablePath({ pid: 42 }, new Set([
    "/opt/codex/bin/codex",
  ]), {
    async run() {
      fallbackCalls += 1;
      return "/opt/codex/bin/codex\n";
    },
  }, {
    realpathImpl: async (file) => {
      if (file === "/proc/42/exe") return "/opt/other/codex";
      return file;
    },
  });

  assert.equal(path, null);
  assert.equal(fallbackCalls, 0);
});

test("process executable lookup rejects unexpected fallback paths", async () => {
  const calls = [];
  const path = await processExecutablePath({ pid: 42 }, new Set([
    "/opt/codex/bin/codex",
  ]), {
    async run(file, args) {
      calls.push([file, args]);
      if (file === "lsof") return "p42\nn/opt/other/codex\n";
      return "/opt/other/codex\n";
    },
  }, {
    realpathImpl: async (file) => {
      if (file === "/proc/42/exe") throw new Error("/proc unavailable");
      return file;
    },
  });

  assert.equal(path, null);
  assert.equal(calls.length, 3);
});

test("process identity lookup fails closed for invalid pids and missing PATH", async () => {
  let environmentFallbackCalls = 0;
  const client = {
    async run() {
      environmentFallbackCalls += 1;
      throw new Error("process lookup unavailable");
    },
  };
  const unavailableFile = async () => {
    throw new Error("/proc unavailable");
  };

  assert.equal(await processEnvironmentPath(0, client), null);
  assert.equal(await processEnvironmentPath("42", client), null);
  assert.equal(await processEnvironmentPath(42, client, {
    readFileImpl: unavailableFile,
  }), null);
  assert.equal(await processEnvironmentPath(42, {
    async run() {
      return "env PATH=/caller/bin codex PATH=/managed/bin\n";
    },
  }, {
    commandLine: "different-command",
    readFileImpl: unavailableFile,
  }), null);
  assert.equal(await processExecutablePath({ pid: 0 }, new Set(), client), null);
  assert.equal(await processExecutablePath({ pid: "42" }, new Set(), client), null);
  assert.equal(environmentFallbackCalls, 1);
});
