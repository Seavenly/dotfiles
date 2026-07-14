#!/usr/bin/env node

import { doctorProfiles } from "./doctor.mjs";

function usage(stream = process.stdout) {
  stream.write("Usage: agent-flow doctor profiles [--json]\n");
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  usage();
} else if (args[0] === "doctor" && args[1] === "profiles") {
  const options = args.slice(2);
  if (options.some((option) => option !== "--json")) {
    process.stderr.write(
      `Unknown option: ${options.find((option) => option !== "--json")}\n`,
    );
    usage(process.stderr);
    process.exitCode = 2;
  } else {
    const report = await doctorProfiles();
    if (options.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const check of report.checks) {
        process.stdout.write(
          `${check.ok ? "ok" : "not ok"} - ${check.summary}\n`,
        );
        for (const detail of check.details)
          process.stdout.write(`  - ${detail}\n`);
      }
    }
    if (!report.ok) process.exitCode = 1;
  }
} else {
  process.stderr.write(`Unknown command: ${args[0]}\n`);
  usage(process.stderr);
  process.exitCode = 2;
}
