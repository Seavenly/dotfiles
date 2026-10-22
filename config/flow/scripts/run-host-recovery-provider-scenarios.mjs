#!/usr/bin/env node

import { isAbsolute } from "node:path";

import {
  runHostRecoveryProviderScenario,
} from "../src/host-recovery-provider-scenarios.mjs";

const options = parseArgs(process.argv.slice(2));
const scenario = required(options, "scenario");
const runId = required(options, "run-id");
const result = await runHostRecoveryProviderScenario(scenario, {
  worktreeRoot: requiredAbsolute(options, "worktree"),
  ...(options["authority-directory"] === undefined ? {} : {
    authorityDirectory: requiredAbsolute(options, "authority-directory"),
  }),
  ...(options["home-directory"] === undefined ? {} : {
    homeDirectory: requiredAbsolute(options, "home-directory"),
    ownerHome: requiredAbsolute(options, "home-directory"),
  }),
  ...(options["xdg-state-home"] === undefined ? {} : {
    xdgStateHome: requiredAbsolute(options, "xdg-state-home"),
    ownerStateHome: requiredAbsolute(options, "xdg-state-home"),
  }),
  ...(options["drovr-config-directory"] === undefined ? {} : {
    drovrConfigDirectory: requiredAbsolute(options, "drovr-config-directory"),
  }),
  ...(options["owner-isolation-root"] === undefined ? {} : {
    ownerIsolationRoot: requiredAbsolute(options, "owner-isolation-root"),
  }),
  ...(options["repository-root"] === undefined ? {} : {
    repositoryRoot: requiredAbsolute(options, "repository-root"),
  }),
  ...(options["backup-directory"] === undefined ? {} : {
    backupDirectory: requiredAbsolute(options, "backup-directory"),
  }),
  runId,
  ...(options.timeout === undefined ? {} : { timeoutMs: Number(options.timeout) }),
  ...(options["no-owner-lifecycle"] === undefined ? {} : {
    includeOwnerLifecycle: false,
  }),
});
const boundResult = { ...result, run_id: runId };
process.stdout.write(`${JSON.stringify(boundResult, null, 2)}\n`);
if (boundResult.status !== "pass") process.exitCode = 1;

function parseArgs(args) {
  const options = {};
  const flags = new Map([
    ["--scenario", "scenario"],
    ["--worktree", "worktree"],
    ["--authority-directory", "authority-directory"],
    ["--home-directory", "home-directory"],
    ["--xdg-state-home", "xdg-state-home"],
    ["--drovr-config-directory", "drovr-config-directory"],
    ["--owner-isolation-root", "owner-isolation-root"],
    ["--repository-root", "repository-root"],
    ["--backup-directory", "backup-directory"],
    ["--run-id", "run-id"],
    ["--timeout", "timeout"],
    ["--no-owner-lifecycle", "no-owner-lifecycle"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const key = flags.get(args[index]);
    if (!key) throw new Error(`unknown argument: ${args[index]}`);
    if (key === "no-owner-lifecycle") {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${args[index]}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function required(options, key) {
  if (typeof options[key] !== "string" || options[key].length === 0) {
    throw new Error(`--${key} is required`);
  }
  return options[key];
}

function requiredAbsolute(options, key) {
  const value = required(options, key);
  if (!isAbsolute(value)) throw new Error(`--${key} must be absolute`);
  return value;
}
