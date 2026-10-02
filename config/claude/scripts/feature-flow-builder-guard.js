#!/usr/bin/env node
// feature-flow-builder-guard.js - PreToolUse hook for the feature-flow builder.
//
// Only the gate script commits, so the builder may not rewrite history, move
// HEAD, or touch gate state. Prompt rules alone did not hold: implementers
// committed their own work in 106 of 1,133 audited attempts, which made the
// gate reject passing slices. Exit 2 blocks the call and tells the agent why.
//
// Reads the hook payload on stdin: { tool_name, tool_input: { command | file_path } }.

const fs = require("node:fs");

const HISTORY = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+(commit|reset|stash|checkout|switch|clean|rebase|merge|cherry-pick|revert|am|push|pull|fetch|tag|worktree|update-ref|symbolic-ref|filter-branch|replace|notes)\b/;
const BRANCH_WRITE = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+branch\s+(?:-[a-zA-Z]*[dDmMcCf]|--(?:delete|move|copy|force))/;
// Any gate invocation other than `red`, anywhere in a chained command.
const GATE_OTHER = /feature-flow-gate\.js(?!\s+red\b)/;
const GATE_STATE = /^gate(\/|\.json$)/;

function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

let payload = {};
try { payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
const tool = payload.tool_name || "";
const input = payload.tool_input || {};

if (tool === "Bash") {
  const command = String(input.command || "");
  // Read-only forms of otherwise blocked subcommands stay allowed.
  const reads = command.replace(/\bgit\b(?:\s+-[cC]\s+\S+)*\s+(?:stash\s+(?:list|show)|worktree\s+list|tag\s+(?:-l|--list)|notes\s+(?:list|show))\b/g, "");
  if (HISTORY.test(reads) || BRANCH_WRITE.test(reads)) {
    block("Blocked: the gate is the only committer in feature-flow. Leave your changes uncommitted (do not commit, stash, reset, checkout, or switch); the gate verifies and commits them. Use `git diff`, `git status`, and `git log` freely.");
  }
  if (GATE_OTHER.test(command.replace(/feature-flow-gate\.js\s+red\b/g, ""))) {
    block("Blocked: the builder may run only `feature-flow-gate.js red`; the workflow runs verify and finalize.");
  }
  if (/agent-teams\/runs\/[^\s/]+\/gate(\/|\.json)/.test(command) && /(>|\btee\b|\bsed\s+-i|\brm\b|\bmv\b|\bcp\b)/.test(command)) {
    block("Blocked: gate state under the run directory is written only by the gate script.");
  }
}

if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const file = String(input.file_path || input.notebook_path || "");
  if (/agent-teams\/runs\//.test(file) && GATE_STATE.test(file.split(/agent-teams\/runs\/[^/]+\//)[1] || "")) {
    block("Blocked: gate.json and gate/ are written only by the host and the gate script.");
  }
}

process.exit(0);
