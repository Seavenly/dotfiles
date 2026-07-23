#!/usr/bin/env node

import { diagnose } from "./doctor.mjs";
import { delegate } from "./delegate.mjs";
import { DrovrError } from "./errors.mjs";
import { readFile } from "node:fs/promises";
import { attach } from "./attach.mjs";
import {
  getTurn,
  listTurns,
  sendToTurn,
  startTurn,
  turnCommandResult,
  turnListCommandResult,
  waitForTurn,
} from "./turns.mjs";

const HELP = `Usage:
  drovr doctor
  drovr delegate [options] [PROMPT]
  drovr ask AGENT_ID [options] [PROMPT]
  drovr turn start AGENT_ID [options] [PROMPT]
  drovr turn send TURN_ID [options] [PROMPT]
  drovr turn wait TURN_ID [--timeout DURATION]
  drovr turn get TURN_ID [--include-messages]
  drovr turn list [filters]
  drovr attach AGENT_ID [--takeover]

Commands:
  doctor    Diagnose configuration and runtime prerequisites
  delegate  Run one complete logical turn with a managed Claude or Codex agent
  ask       Run a later logical turn with an existing managed agent
  turn      Start, steer, wait for, get, or discover durable logical turns
  attach    Interactively attach to a managed agent
`;

export async function runCli(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (argv[0] === "doctor" && argv.length === 1) {
    const report = await diagnose();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.ok ? 0 : 3;
  }

  if (argv[0] === "delegate") {
    const options = await parseDelegateArguments(argv.slice(1));
    const report = await delegate(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "ask") {
    const options = await parseAgentPromptArguments(argv.slice(1), "ask", {
      timeout: true,
    });
    const started = await startTurn(options.id, options);
    const settled = await waitForTurn(started.turn.id, {
      timeoutMs: options.timeoutMs,
    });
    const report = turnCommandResult("ask", settled, {
      includeMessages: true,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "turn") {
    return runTurnCommand(argv.slice(1));
  }

  if (argv[0] === "attach") {
    if (argv.length < 2 || argv.length > 3) {
      invalidArguments("attach requires AGENT_ID and optional --takeover");
    }
    if (argv[2] && argv[2] !== "--takeover") {
      invalidArguments(`unknown attach option: ${argv[2]}`);
    }
    return attach(argv[1], { takeover: argv[2] === "--takeover" });
  }

  invalidArguments(`unsupported command: ${argv[0]}`);
}

const DELEGATE_OPTIONS = new Map([
  ["--group", "group"],
  ["--group-label", "groupLabel"],
  ["--task-key", "taskKey"],
  ["--task-label", "taskLabel"],
  ["--agent-key", "agentKey"],
  ["--agent-label", "agentLabel"],
  ["--cwd", "cwd"],
  ["--harness", "harness"],
  ["--model", "model"],
  ["--effort", "effort"],
  ["--capability", "capability"],
  ["--role", "role"],
  ["--prompt-file", "promptFile"],
  ["--timeout", "timeout"],
]);

const PROMPT_OPTIONS = new Map([["--prompt-file", "promptFile"]]);
const WAITING_PROMPT_OPTIONS = new Map([
  ...PROMPT_OPTIONS,
  ["--timeout", "timeout"],
]);

async function parseDelegateArguments(argv) {
  const { options, positional } = parseOptions(
    argv,
    DELEGATE_OPTIONS,
    "delegate",
  );
  if (positional.length > 1)
    invalidArguments("delegate accepts one positional prompt");
  const prompt = await resolvePrompt(positional[0], options.promptFile);
  if (!options.taskKey) invalidArguments("--task-key is required");

  return {
    ...options,
    cwd: options.cwd ?? process.cwd(),
    agentKey: options.agentKey ?? "delegate",
    prompt,
    timeoutMs: parseDuration(options.timeout ?? "5m"),
  };
}

function parseOptions(argv, optionMap, command) {
  const options = {};
  const positional = [];
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && argument.startsWith("--")) {
      const key = optionMap.get(argument);
      if (!key) invalidArguments(`unknown ${command} option: ${argument}`);
      const value = argv[index + 1];
      if (value === undefined) invalidArguments(`${argument} requires a value`);
      options[key] = value;
      index += 1;
      continue;
    }
    positional.push(argument);
  }
  return { options, positional };
}

async function resolvePrompt(positionalPrompt, promptFile) {
  const explicitSourceCount =
    Number(positionalPrompt !== undefined) + Number(Boolean(promptFile));
  if (explicitSourceCount > 1) {
    invalidArguments("multiple prompt sources", "ambiguous_prompt");
  }
  let stdin = "";
  if (!process.stdin.isTTY && explicitSourceCount === 0) {
    stdin = await readStandardInput();
  } else if (!process.stdin.isTTY && (await standardInputHasData())) {
    invalidArguments("multiple prompt sources", "ambiguous_prompt");
  }
  const sourceCount = explicitSourceCount + Number(stdin.length > 0);
  if (sourceCount > 1)
    invalidArguments("multiple prompt sources", "ambiguous_prompt");

  let prompt = positionalPrompt;
  if (promptFile) {
    try {
      prompt = await readFile(promptFile, "utf8");
    } catch (error) {
      invalidArguments(`cannot read prompt file: ${error.message}`);
    }
  }
  if (prompt === undefined && stdin.length) prompt = stdin;
  if (prompt === undefined || prompt.length === 0) {
    invalidArguments("no prompt was supplied", "missing_prompt");
  }
  return prompt;
}

async function parseAgentPromptArguments(
  argv,
  command,
  { timeout = false } = {},
) {
  const id = argv[0];
  if (!id) invalidArguments(`${command} requires an identifier`);
  const optionMap = timeout ? WAITING_PROMPT_OPTIONS : PROMPT_OPTIONS;
  const { options, positional } = parseOptions(
    argv.slice(1),
    optionMap,
    command,
  );
  if (positional.length > 1) {
    invalidArguments(`${command} accepts one positional prompt`);
  }
  return {
    id,
    ...options,
    prompt: await resolvePrompt(positional[0], options.promptFile),
    ...(timeout ? { timeoutMs: parseDuration(options.timeout ?? "5m") } : {}),
  };
}

async function runTurnCommand(argv) {
  const subcommand = argv[0];
  if (subcommand === "start") {
    const options = await parseAgentPromptArguments(
      argv.slice(1),
      "turn start",
    );
    const context = await startTurn(options.id, options);
    process.stdout.write(
      `${JSON.stringify(turnCommandResult("turn start", context))}\n`,
    );
    return 0;
  }
  if (subcommand === "wait") {
    const turnId = argv[1];
    if (!turnId) invalidArguments("turn wait requires TURN_ID");
    const { options, positional } = parseOptions(
      argv.slice(2),
      new Map([["--timeout", "timeout"]]),
      "turn wait",
    );
    if (positional.length) invalidArguments("turn wait accepts no prompt");
    const context = await waitForTurn(turnId, {
      ...(options.timeout ? { timeoutMs: parseDuration(options.timeout) } : {}),
    });
    process.stdout.write(
      `${JSON.stringify(turnCommandResult("turn wait", context, { includeMessages: true }))}\n`,
    );
    return 0;
  }
  if (subcommand === "get") {
    const turnId = argv[1];
    if (!turnId) invalidArguments("turn get requires TURN_ID");
    const trailing = argv.slice(2);
    if (trailing.some((argument) => argument !== "--include-messages")) {
      invalidArguments(`unknown turn get option: ${trailing[0]}`);
    }
    if (
      trailing.filter((argument) => argument === "--include-messages").length >
      1
    ) {
      invalidArguments("--include-messages may be supplied once");
    }
    const context = await getTurn(turnId);
    process.stdout.write(
      `${JSON.stringify(turnCommandResult("turn get", context, { includeMessages: trailing.includes("--include-messages") }))}\n`,
    );
    return 0;
  }
  if (subcommand === "list") {
    const { options, positional } = parseOptions(
      argv.slice(1),
      new Map([
        ["--agent", "agentId"],
        ["--task", "taskId"],
        ["--status", "status"],
      ]),
      "turn list",
    );
    if (positional.length)
      invalidArguments("turn list accepts no positional arguments");
    process.stdout.write(
      `${JSON.stringify(turnListCommandResult(await listTurns(options)))}\n`,
    );
    return 0;
  }
  if (subcommand === "send") {
    const options = await parseAgentPromptArguments(argv.slice(1), "turn send");
    const context = await sendToTurn(options.id, options);
    process.stdout.write(
      `${JSON.stringify(turnCommandResult("turn send", context))}\n`,
    );
    return 0;
  }
  invalidArguments(`unsupported turn command: ${subcommand ?? ""}`);
}

async function readStandardInput() {
  const chunks = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join("");
}

async function standardInputHasData() {
  if (process.stdin.readableLength > 0) return true;
  if (process.stdin.readableEnded) return false;
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      process.stdin.off("readable", readable);
      process.stdin.off("end", ended);
      process.stdin.pause();
      process.stdin.unref?.();
      resolve(result);
    };
    const readable = () => finish(process.stdin.readableLength > 0);
    const ended = () => finish(false);
    const timer = setTimeout(() => finish(false), 10);
    process.stdin.once("readable", readable);
    process.stdin.once("end", ended);
  });
}

function parseDuration(value) {
  const match = value.match(/^(\d+)(ms|s|m)?$/u);
  if (!match) invalidArguments(`invalid duration: ${value}`);
  const factor = { ms: 1, s: 1000, m: 60_000 }[match[2] ?? "ms"];
  const milliseconds = Number(match[1]) * factor;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    invalidArguments(`invalid duration: ${value}`);
  }
  return milliseconds;
}

function invalidArguments(message, outcome = "invalid_arguments") {
  throw new DrovrError(message, { code: 2, outcome });
}

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  const known = error instanceof DrovrError;
  const expected = known && error.code === 0;
  const command =
    process.argv[2] === "turn" && process.argv[3]
      ? `turn ${process.argv[3]}`
      : (process.argv[2] ?? null);
  const report = expected
    ? {
        schema: "drovr.command/v1",
        command,
        ok: true,
        result: {
          status: error.outcome,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      }
    : {
        schema: "drovr.command/v1",
        command,
        ok: false,
        error: {
          outcome: known ? error.outcome : "internal_error",
          message: error.message,
          ...(known && error.details ? { details: error.details } : {}),
        },
      };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = known ? error.code : 5;
}
