#!/usr/bin/env node

import { runCli } from "./cli-command.mjs";

process.exitCode = await runCli(process.argv.slice(2));
