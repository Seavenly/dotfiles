import { access, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfiguration } from "./config.mjs";
import { walkFiles } from "./files.mjs";
import { execute } from "./process.mjs";

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
          ? "current"
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

  const ok = checks.every(({ status }) => status !== "fail");
  return {
    schema: "drovr.command/v1",
    command: "doctor",
    ok,
    result: {
      status: ok ? "ready" : "unavailable",
      defaults: configuration?.defaults ?? null,
      checks,
    },
  };
}
