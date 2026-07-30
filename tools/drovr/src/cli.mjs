#!/usr/bin/env node

import { diagnose } from "./doctor.mjs";
import { delegate } from "./delegate.mjs";
import { DrovrError } from "./errors.mjs";
import { readFile } from "node:fs/promises";
import { attach } from "./attach.mjs";
import {
  closeGroup,
  closeTask,
  lifecycleCommandResult,
  retireAgent,
} from "./lifecycle.mjs";
import {
  cancelTurn,
  getTurn,
  listTurns,
  sendToTurn,
  startTurn,
  turnCommandResult,
  turnListCommandResult,
  waitForTurn,
} from "./turns.mjs";
import {
  getAgent,
  getGroup,
  getTask,
  listAgents,
  listGroups,
  listTasks,
  queryGetCommandResult,
  queryListCommandResult,
} from "./queries.mjs";
import { statusReport } from "./status.mjs";
import { normalizeInputText } from "./turn-record.mjs";
import { openTask, taskOpenCommandResult } from "./task-open.mjs";
import { agentStartCommandResult, startAgent } from "./agent-start.mjs";

const HELP = `Usage:
  drovr doctor
  drovr status
  drovr delegate [options] [PROMPT]
  drovr ask AGENT_ID [options] [PROMPT]
  drovr turn start AGENT_ID [options] [PROMPT]
  drovr turn send TURN_ID [options] [PROMPT]
  drovr turn wait TURN_ID [--after-block BLOCK_ID] [--timeout DURATION]
  drovr turn get TURN_ID [--include-messages]
  drovr turn list [filters]
  drovr turn cancel TURN_ID
  drovr group list [--status STATUS]
  drovr group get GROUP_ID
  drovr group close GROUP_ID [--force]
  drovr task open [options]
  drovr task list [--group GROUP_ID] [--status STATUS]
  drovr task get TASK_ID
  drovr task close TASK_ID [--force]
  drovr agent start TASK_ID [options]
  drovr agent list [--task TASK_ID] [--status STATUS] [--harness HARNESS]
  drovr agent get AGENT_ID
  drovr agent retire AGENT_ID
  drovr attach AGENT_ID [--takeover]

Commands:
  doctor    Diagnose configuration and runtime prerequisites
  status    Summarize durable state and current Herdr observations
  delegate  Run one complete logical turn with a managed Claude or Codex agent
  ask       Run a later logical turn with an existing managed agent
  turn      Start, steer, wait for, get, or discover durable logical turns
  group     List, inspect, or close delegation groups
  task      Open, list, inspect, or close delegated tasks
  agent     Start, list, inspect, or retire managed agents
  attach    Interactively attach to a managed agent
`;

const DELEGATE_HELP = `Usage:
  drovr delegate [options] [PROMPT]

Options:
  --group GROUP_KEY           Select an existing or stable delegation group
  --group-label LABEL         Label a newly created delegation group
  --task-key KEY              Set the required stable task key
  --task-label LABEL          Set the task label
  --agent-key KEY             Set the agent key (default: delegate)
  --agent-label LABEL         Set the agent label
  --cwd PATH                  Set the task working directory (default: current directory)
  --harness HARNESS           Select claude or codex
  --model MODEL               Select the native harness model
  --effort EFFORT             Select low, medium, high, or xhigh
  --capability CAPABILITY     Select the tracked capability profile
  --role ROLE                 Select the tracked role profile
  --prompt-file PATH          Read the prompt from a file
  --timeout DURATION          Set the settlement timeout (default: 5m)
  -h, --help                  Show this help

Supply the prompt once as PROMPT, with --prompt-file, or on standard input.
`;

export async function runCli(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (
    argv[0] === "delegate" &&
    argv.length === 2 &&
    (argv[1] === "--help" || argv[1] === "-h")
  ) {
    process.stdout.write(DELEGATE_HELP);
    return 0;
  }

  if (argv[0] === "doctor" && argv.length === 1) {
    const report = await diagnose();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.ok ? 0 : 3;
  }

  if (argv[0] === "status" && argv.length === 1) {
    process.stdout.write(`${JSON.stringify(await statusReport())}\n`);
    return 0;
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

  if (argv[0] === "group" && argv[1] === "list") {
    const { options, positional } = parseOptions(
      argv.slice(2),
      new Map([["--status", "status"]]),
      "group list",
    );
    if (positional.length) {
      invalidArguments("group list accepts no positional arguments");
    }
    const report = queryListCommandResult(
      "group",
      await listGroups(options),
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "group" && argv[1] === "get") {
    if (argv.length !== 3) invalidArguments("group get requires GROUP_ID");
    const report = queryGetCommandResult("group", await getGroup(argv[2]));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "group" && argv[1] === "close") {
    const options = parseCloseArguments(
      argv.slice(2),
      "group close",
      "GROUP_ID",
    );
    const report = lifecycleCommandResult(
      "group close",
      await closeGroup(options.id, { force: options.force }),
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "task" && argv[1] === "list") {
    const { options, positional } = parseOptions(
      argv.slice(2),
      new Map([
        ["--group", "groupId"],
        ["--status", "status"],
      ]),
      "task list",
    );
    if (positional.length) {
      invalidArguments("task list accepts no positional arguments");
    }
    const report = queryListCommandResult("task", await listTasks(options));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "task" && argv[1] === "open") {
    const { options, positional } = parseOptions(
      argv.slice(2),
      new Map([
        ["--group", "group"],
        ["--group-label", "groupLabel"],
        ["--key", "key"],
        ["--label", "label"],
        ["--cwd", "cwd"],
      ]),
      "task open",
    );
    if (positional.length) {
      invalidArguments("task open accepts no positional arguments");
    }
    if (!options.key) invalidArguments("--key is required");
    const report = taskOpenCommandResult(
      await openTask({ ...options, cwd: options.cwd ?? process.cwd() }),
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "task" && argv[1] === "get") {
    if (argv.length !== 3) invalidArguments("task get requires TASK_ID");
    const report = queryGetCommandResult("task", await getTask(argv[2]));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "agent" && argv[1] === "list") {
    const { options, positional } = parseOptions(
      argv.slice(2),
      new Map([
        ["--task", "taskId"],
        ["--status", "status"],
        ["--harness", "harness"],
      ]),
      "agent list",
    );
    if (positional.length) {
      invalidArguments("agent list accepts no positional arguments");
    }
    const report = queryListCommandResult("agent", await listAgents(options));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "agent" && argv[1] === "start") {
    const taskId = argv[2];
    if (!taskId) invalidArguments("agent start requires TASK_ID");
    const { options, positional } = parseOptions(
      argv.slice(3),
      new Map([
        ["--key", "key"],
        ["--label", "label"],
        ["--role", "role"],
        ["--harness", "harness"],
        ["--model", "model"],
        ["--effort", "effort"],
        ["--capability", "capability"],
      ]),
      "agent start",
    );
    if (positional.length) {
      invalidArguments("agent start accepts no positional arguments");
    }
    if (!options.key) invalidArguments("--key is required");
    const report = agentStartCommandResult(
      await startAgent(taskId, options),
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "agent" && argv[1] === "get") {
    if (argv.length !== 3) invalidArguments("agent get requires AGENT_ID");
    const report = queryGetCommandResult("agent", await getAgent(argv[2]));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "agent" && argv[1] === "retire") {
    if (argv.length !== 3) invalidArguments("agent retire requires AGENT_ID");
    const report = lifecycleCommandResult(
      "agent retire",
      await retireAgent(argv[2]),
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (argv[0] === "task" && argv[1] === "close") {
    const options = parseCloseArguments(
      argv.slice(2),
      "task close",
      "TASK_ID",
    );
    const report = lifecycleCommandResult(
      "task close",
      await closeTask(options.id, { force: options.force }),
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
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

function parseCloseArguments(argv, command, identifier) {
  const id = argv[0];
  if (!id) invalidArguments(`${command} requires ${identifier}`);
  const trailing = argv.slice(1);
  if (trailing.some((argument) => argument !== "--force")) {
    invalidArguments(`unknown ${command} option: ${trailing[0]}`);
  }
  if (trailing.length > 1) {
    invalidArguments("--force may be supplied once");
  }
  return { id, force: trailing.includes("--force") };
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
  if (prompt !== undefined) prompt = normalizeInputText(prompt);
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
      new Map([
        ["--after-block", "afterBlockId"],
        ["--timeout", "timeout"],
      ]),
      "turn wait",
    );
    if (positional.length) invalidArguments("turn wait accepts no prompt");
    const context = await waitForTurn(turnId, {
      ...(options.afterBlockId
        ? { afterBlockId: options.afterBlockId }
        : {}),
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
  if (subcommand === "cancel") {
    const turnId = argv[1];
    if (!turnId) invalidArguments("turn cancel requires TURN_ID");
    if (argv.length !== 2) invalidArguments("turn cancel accepts no options");
    const context = await cancelTurn(turnId);
    process.stdout.write(
      `${JSON.stringify(turnCommandResult("turn cancel", context))}\n`,
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
      : ["agent", "group", "task"].includes(process.argv[2]) && process.argv[3]
        ? `${process.argv[2]} ${process.argv[3]}`
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
