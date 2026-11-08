#!/usr/bin/env node
// agent-local-guard.js - PreToolUse hook for workflow agents that must stay
// local.
//
// The host alone decides what reaches external systems and when. A prompt
// rule did not hold: during a review-only relaunch an agent rewrote a live
// pull-request description to describe an unpushed head. This blocks pushes
// and GitHub writes; reads (`gh pr view`, `gh api` GETs, `git log`) stay
// allowed. Exit 2 blocks the call and tells the agent why.
//
// Reads the hook payload on stdin: { tool_name, tool_input: { command } }.

const fs = require("node:fs");

const PUSH = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+push\b/;
const GH_WRITE = new RegExp(
  "\\bgh\\s+(?:" +
    [
      "(?:pr|issue)\\s+(?:create|edit|comment|review|merge|close|reopen|ready|lock|unlock|delete|transfer|develop|pin|unpin)",
      "release\\s+(?:create|edit|delete|upload)",
      "repo\\s+(?:create|edit|delete|fork|rename|archive|sync)",
      "(?:label|gist)\\s+(?:create|edit|delete|clone)",
      "(?:secret|variable)\\s+(?:set|delete)",
      "workflow\\s+(?:run|enable|disable)",
      "run\\s+(?:rerun|cancel|delete)",
    ].join("|") +
    ")\\b",
);
// `gh api` writes when given a non-GET method, or fields/input (which default to POST).
const GH_API = /\bgh\s+api\b([^;&|]*)/g;
const API_WRITE = /(?:-X|--method)[\s=]*['"]?(?:POST|PATCH|PUT|DELETE)\b|\s(?:-f|-F|--field|--raw-field|--input)\b/i;

function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

let payload = {};
try { payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
if (payload.tool_name !== "Bash") process.exit(0);
const command = String((payload.tool_input || {}).command || "");

const apiWrite = [...command.matchAll(GH_API)].some((m) => API_WRITE.test(m[1]) && !/(?:-X|--method)[\s=]*['"]?GET\b/i.test(m[1]));
if (PUSH.test(command) || GH_WRITE.test(command) || apiWrite) {
  block("Blocked: workflow agents stay local. Do not push or write to GitHub (pull requests, issues, comments, releases, API writes). Put what you would publish in your output; the host decides what leaves this machine and when.");
}

process.exit(0);
