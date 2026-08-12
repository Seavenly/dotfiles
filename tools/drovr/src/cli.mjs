#!/usr/bin/env node

import { diagnose } from "./doctor.mjs";
import { delegate } from "./delegate.mjs";
import { describeDelegatedAgent } from "./description.mjs";
import { DrovrError } from "./errors.mjs";
import { publicErrorDetails, publicErrorMessage } from "./public-output.mjs";
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
  discoverTurn,
  dispatchTurn,
  getTurn,
  listTurns,
  sendToTurn,
  startTurn,
  turnCommandResult,
  turnDiscoveryCommandResult,
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
import {
  abandonBareRegistryLock,
  releaseAbsentRegistryLock,
  stateDirectory,
} from "./registry.mjs";
import { openTask, taskOpenCommandResult } from "./task-open.mjs";
import { agentStartCommandResult, startAgent } from "./agent-start.mjs";
import {
  inspectAgentStagedInput,
  recoverAgentStagedInput,
  stageUnknownAgentInput,
} from "./staged-input.mjs";

const HELP = `Usage:
  drovr doctor
  drovr status
  drovr lock abandon LOCK_ENTRY --authority-watermark JSON --decision ID
  drovr lock release-absent LOCK_ENTRY --lock-id LOCK_ID --authority-watermark JSON --decision ID
  drovr describe [launch options] --caller-metadata JSON
  drovr delegate [options] [PROMPT]
  drovr ask AGENT_ID [options] [PROMPT]
  drovr turn start AGENT_ID [options] [PROMPT]
  drovr turn dispatch AGENT_ID --caller-key KEY --input-key KEY --caller-metadata JSON --launch-binding JSON [PROMPT]
  drovr turn discover CALLER_KEY
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
  drovr agent staged-input AGENT_ID [--submit TOKEN | --clear TOKEN | --clear-unknown TOKEN | --stage-unknown-file PATH]
  drovr agent retire AGENT_ID
  drovr attach AGENT_ID [--takeover] [--json-result]

Commands:
  doctor    Diagnose configuration and runtime prerequisites
  status    Summarize durable state and current Herdr observations
  describe  Resolve a non-mutating exact launch and feature description
  delegate  Run one complete logical turn with a managed Claude or Codex agent
  ask       Run a later logical turn with an existing managed agent
  turn      Start, steer, wait for, get, or discover durable logical turns
  group     List, inspect, or close delegation groups
  task      Open, list, inspect, or close delegated tasks
  agent     Start, list, inspect, or retire managed agents
  attach    Interactively attach to a managed agent

Waiting commands emit one JSON result after settlement or timeout. They do not
stream progress while the process remains active.
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
Delegate emits one JSON result after settlement or timeout and does not stream
progress while the process remains active.
`;

const TURN_WAIT_HELP = `Usage:
  drovr turn wait TURN_ID [--after-block BLOCK_ID] [--timeout DURATION]

Options:
  --after-block BLOCK_ID      Wait beyond an acknowledged blocked transition
  --timeout DURATION          Return still_running after this non-destructive bound
  -h, --help                  Show this help

Wait emits one JSON result after settlement or timeout and does not stream
progress while the process remains active. Use "drovr turn get TURN_ID" for a
nonblocking durable-state snapshot. If a command runner yields a live process
handle, resume that process instead of starting another wait.
`;

const DESCRIPTION_HELP = `Usage:
  drovr describe [launch options] --caller-metadata JSON

Options:
  --harness HARNESS           Select claude or codex
  --role ROLE                 Select the tracked role profile
  --model MODEL               Select the native harness model
  --effort EFFORT             Select low, medium, high, or xhigh
  --capability CAPABILITY     Select the tracked capability profile
  --caller-metadata JSON      Bind opaque caller ownership metadata
  -h, --help                  Show this help
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

  if (
    argv[0] === "describe" &&
    argv.length === 2 &&
    (argv[1] === "--help" || argv[1] === "-h")
  ) {
    process.stdout.write(DESCRIPTION_HELP);
    return 0;
  }

  if (
    argv[0] === "turn" &&
    argv[1] === "wait" &&
    argv.length === 3 &&
    (argv[2] === "--help" || argv[2] === "-h")
  ) {
    process.stdout.write(TURN_WAIT_HELP);
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

  if (argv[0] === "lock" && argv[1] === "abandon") {
    const options = parseLockAbandonArguments(argv.slice(2));
    const result = await abandonBareRegistryLock(
      stateDirectory(process.env),
      options.lockEntry,
      {
        authorityWatermark: options.authorityWatermark,
        decisionId: options.decisionId,
      },
    );
    process.stdout.write(`${JSON.stringify({
      schema: "drovr.command/v1",
      command: "lock abandon",
      ok: true,
      result,
    })}\n`);
    return 0;
  }

  if (argv[0] === "lock" && argv[1] === "release-absent") {
    const options = parseLockReleaseAbsentArguments(argv.slice(2));
    const result = await releaseAbsentRegistryLock(
      stateDirectory(process.env),
      options.lockEntry,
      {
        lockId: options.lockId,
        authorityWatermark: options.authorityWatermark,
        decisionId: options.decisionId,
      },
    );
    process.stdout.write(`${JSON.stringify({
      schema: "drovr.command/v1",
      command: "lock release-absent",
      ok: true,
      result,
    })}\n`);
    return 0;
  }

  if (argv[0] === "describe") {
    const request = parseDescriptionArguments(argv.slice(1));
    const result = await describeDelegatedAgent(request, {
      requireCompatibility: true,
    });
    process.stdout.write(`${JSON.stringify({
      schema: "drovr.command/v1",
      command: "describe",
      ok: true,
      result,
    })}\n`);
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

  if (argv[0] === "agent" && argv[1] === "staged-input") {
    const agentId = argv[2];
    if (!agentId) invalidArguments("agent staged-input requires AGENT_ID");
    const trailing = argv.slice(3);
    let context;
    if (trailing.length === 0) {
      context = await inspectAgentStagedInput(agentId);
    } else if (
      trailing.length === 2 &&
      trailing[0] === "--stage-unknown-file"
    ) {
      context = await stageUnknownAgentInput(agentId, {
        text: await resolvePrompt(undefined, trailing[1]),
      });
    } else {
      if (
        trailing.length !== 2 ||
        !["--submit", "--clear", "--clear-unknown"].includes(trailing[0])
      ) {
        invalidArguments(
          "agent staged-input accepts --submit TOKEN, --clear TOKEN, --clear-unknown TOKEN, or --stage-unknown-file PATH",
        );
      }
      context = await recoverAgentStagedInput(agentId, {
        action:
          trailing[0] === "--submit"
            ? "submit"
            : trailing[0] === "--clear-unknown"
              ? "clear_unknown"
              : "clear",
        token: trailing[1],
      });
    }
    process.stdout.write(
      `${JSON.stringify(stagedInputCommandResult(context))}\n`,
    );
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
    if (argv.length < 2 || argv.length > 4) {
      invalidArguments(
        "attach requires AGENT_ID and optional --takeover and --json-result",
      );
    }
    const options = argv.slice(2);
    if (
      options.some(
        (option) => !["--takeover", "--json-result"].includes(option),
      ) ||
      new Set(options).size !== options.length
    ) {
      invalidArguments(`unknown or repeated attach option: ${argv[2]}`);
    }
    const code = await attach(argv[1], {
      takeover: options.includes("--takeover"),
    });
    if (options.includes("--json-result")) {
      process.stdout.write(
        `${JSON.stringify({
          schema: "drovr.command/v1",
          command: "attach",
          ok: code === 0,
          ...(code === 0
            ? { result: { status: "detached", agent_id: argv[1] } }
            : {
                error: {
                  outcome: "attach_failed",
                  message: `interactive attach exited with status ${code}`,
                },
              }),
        })}\n`,
      );
    }
    return code;
  }

  invalidArguments(`unsupported command: ${argv[0]}`);
}

function parseDescriptionArguments(args) {
  const fields = new Map([
    ["--harness", "harness"],
    ["--role", "role"],
    ["--model", "model"],
    ["--effort", "effort"],
    ["--capability", "capability"],
  ]);
  const launch = {};
  let callerMetadata;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof value !== "string") {
      invalidArguments(`describe option requires a value: ${flag ?? "missing"}`);
    }
    if (flag === "--caller-metadata") {
      if (callerMetadata !== undefined) {
        invalidArguments("describe caller metadata may be supplied only once");
      }
      try {
        callerMetadata = JSON.parse(value);
      } catch {
        invalidArguments("describe caller metadata must be valid JSON");
      }
      continue;
    }
    const field = fields.get(flag);
    if (!field || Object.hasOwn(launch, field)) {
      invalidArguments(`unsupported or repeated describe option: ${flag}`);
    }
    launch[field] = value;
  }
  if (callerMetadata === undefined) {
    invalidArguments("describe requires --caller-metadata JSON");
  }
  return {
    schema: "drovr.delegated-agent-description-request/v1",
    launch,
    caller_metadata: callerMetadata,
  };
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

function parseLockAbandonArguments(argv) {
  const lockEntry = argv[0];
  if (!lockEntry) invalidArguments("lock abandon requires LOCK_ENTRY");
  const { options, positional } = parseOptions(
    argv.slice(1),
    new Map([
      ["--authority-watermark", "authorityWatermark"],
      ["--decision", "decisionId"],
    ]),
    "lock abandon",
  );
  if (positional.length) invalidArguments("lock abandon accepts one LOCK_ENTRY");
  if (!options.authorityWatermark) {
    invalidArguments("lock abandon requires --authority-watermark JSON");
  }
  if (!options.decisionId) {
    invalidArguments("lock abandon requires --decision ID");
  }
  return {
    lockEntry,
    authorityWatermark: parseJsonOption(
      options.authorityWatermark,
      "--authority-watermark",
    ),
    decisionId: options.decisionId,
  };
}

function parseLockReleaseAbsentArguments(argv) {
  const lockEntry = argv[0];
  if (!lockEntry) invalidArguments("lock release-absent requires LOCK_ENTRY");
  const { options, positional } = parseOptions(
    argv.slice(1),
    new Map([
      ["--lock-id", "lockId"],
      ["--authority-watermark", "authorityWatermark"],
      ["--decision", "decisionId"],
    ]),
    "lock release-absent",
  );
  if (positional.length) {
    invalidArguments("lock release-absent accepts one LOCK_ENTRY");
  }
  if (!options.lockId) {
    invalidArguments("lock release-absent requires --lock-id LOCK_ID");
  }
  if (!options.authorityWatermark) {
    invalidArguments("lock release-absent requires --authority-watermark JSON");
  }
  if (!options.decisionId) {
    invalidArguments("lock release-absent requires --decision ID");
  }
  return {
    lockEntry,
    lockId: options.lockId,
    authorityWatermark: parseJsonOption(
      options.authorityWatermark,
      "--authority-watermark",
    ),
    decisionId: options.decisionId,
  };
}

function stagedInputCommandResult(context) {
  const stateChangeSeq = Number.isSafeInteger(context.transition_token)
    ? context.transition_token
    : Number.isSafeInteger(context.staged_input?.transition_token)
      ? context.staged_input.transition_token
      : null;
  return {
    schema: "drovr.command/v1",
    command: "agent staged-input",
    ok: true,
    result: {
      status: context.status,
      agent: {
        id: context.agent.id,
        key: context.agent.key,
        harness: context.agent.launch.harness,
        native_session: context.agent.native_session,
        state_change_seq: stateChangeSeq,
      },
      state_change_seq: stateChangeSeq,
      ...(context.staged_input
        ? {
            staged_input: {
              ...context.staged_input,
              state_change_seq: stateChangeSeq,
            },
          }
        : {}),
      ...(context.turn
        ? {
            turn: {
              id: context.turn.id,
              status: context.turn.status,
              input_count: context.turn.inputs.length,
            },
          }
        : {}),
    },
  };
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
const CALLER_INPUT_OPTIONS = new Map([
  ...PROMPT_OPTIONS,
  ["--caller-key", "callerKey"],
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
  { timeout = false, callerInput = false } = {},
) {
  const id = argv[0];
  if (!id) invalidArguments(`${command} requires an identifier`);
  const optionMap = timeout
    ? WAITING_PROMPT_OPTIONS
    : callerInput
      ? CALLER_INPUT_OPTIONS
      : PROMPT_OPTIONS;
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
  if (subcommand === "dispatch") {
    const id = argv[1];
    if (!id) invalidArguments("turn dispatch requires AGENT_ID");
    const { options, positional } = parseOptions(
      argv.slice(2),
      new Map([
        ...PROMPT_OPTIONS,
        ["--caller-key", "callerKey"],
        ["--input-key", "inputKey"],
        ["--caller-metadata", "callerMetadata"],
        ["--launch-binding", "launchBinding"],
      ]),
      "turn dispatch",
    );
    if (positional.length > 1) {
      invalidArguments("turn dispatch accepts one positional prompt");
    }
    if (!options.callerKey || !options.inputKey) {
      invalidArguments("turn dispatch requires --caller-key and --input-key");
    }
    const context = await dispatchTurn(id, {
      ...options,
      callerMetadata: parseJsonOption(
        options.callerMetadata,
        "--caller-metadata",
      ),
      launchBinding: parseJsonOption(
        options.launchBinding,
        "--launch-binding",
      ),
      prompt: await resolvePrompt(positional[0], options.promptFile),
    });
    process.stdout.write(
      `${JSON.stringify(turnCommandResult("turn dispatch", context))}\n`,
    );
    return 0;
  }
  if (subcommand === "discover") {
    if (argv.length !== 2) {
      invalidArguments("turn discover requires exactly one CALLER_KEY");
    }
    const discovery = await discoverTurn(argv[1]);
    process.stdout.write(
      `${JSON.stringify(turnDiscoveryCommandResult(argv[1], discovery))}\n`,
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
    const options = await parseAgentPromptArguments(
      argv.slice(1),
      "turn send",
      { callerInput: true },
    );
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

function parseJsonOption(value, flag) {
  if (value === undefined) invalidArguments(`turn dispatch requires ${flag}`);
  try {
    return JSON.parse(value);
  } catch {
    invalidArguments(`${flag} must be valid JSON`);
  }
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
      : ["agent", "group", "task", "lock"].includes(process.argv[2]) && process.argv[3]
        ? `${process.argv[2]} ${process.argv[3]}`
        : (process.argv[2] ?? null);
  const report = expected
    ? {
        schema: "drovr.command/v1",
        command,
        ok: true,
        result: {
          status: error.outcome,
          message: publicErrorMessage(error),
          ...(error.details
            ? { details: publicErrorDetails(error.details) }
            : {}),
        },
      }
    : {
        schema: "drovr.command/v1",
        command,
        ok: false,
        error: {
          outcome: known ? error.outcome : "internal_error",
          message: publicErrorMessage(error),
          ...(known && error.details
            ? { details: publicErrorDetails(error.details) }
            : {}),
        },
      };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = known ? error.code : 5;
}
