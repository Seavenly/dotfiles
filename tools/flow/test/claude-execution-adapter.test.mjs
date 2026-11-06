import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeExecutionAdapter } from "../src/claude-execution-adapter.mjs";

function descriptor() {
  return {
    description: {
      launch: { harness: "claude", model: "claude-opus-5-5", effort: "high", capability: "read-only" },
      backend: { harness: "claude", adapter: "flow.claude-print", adapter_version: "1",
        executable: { path: "/fixture/claude", version: "2.1.287 (Claude Code)" } },
      effective_authority: { approvals: "denied", filesystem: "read_only", network: "disabled",
        escalation: false, writable_roots: [] },
    },
    workspace: { path: "/fixture/workspace", claim: { access: "read_only" } },
    output_contract: { schema: { type: "object" } },
    output_schema_bytes: '{"type":"object"}',
  };
}

function init() {
  return { type: "system", subtype: "init", session_id: "session-fixture", cwd: "/fixture/workspace",
    model: "claude-opus-5-5", claude_code_version: "2.1.287", permissionMode: "dontAsk",
    tools: ["Read", "Glob", "Grep"], mcp_servers: [], plugins: [], agents: [], skills: [],
    slash_commands: [], output_style: "default" };
}
function terminal() {
  return { type: "result", subtype: "success", session_id: "session-fixture", is_error: false,
    structured_output: { answer: 42 }, permission_denials: [] };
}
function stream(...events) { return events.map((event) => JSON.stringify(event)).join("\n") + "\n"; }
function parse(stdout, exitCode = 0) {
  return claudeExecutionAdapter.parseTerminal({ descriptor: descriptor(), stdout, exitCode, lastMessage: null });
}
function assistant(content, model = "claude-opus-5-5") {
  return { type: "assistant", session_id: "session-fixture", parent_tool_use_id: null,
    message: { type: "message", role: "assistant", model, content } };
}
function toolResult(id) {
  return { type: "user", session_id: "session-fixture", parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "file contents" }] } };
}

test("Claude admission stays unavailable without trustworthy native policy evidence", () => {
  assert.equal(Object.isFrozen(claudeExecutionAdapter), true);
  assert.equal(claudeExecutionAdapter.harness, "claude");
  assert.equal(claudeExecutionAdapter.supportedVersion, "2.1.287 (Claude Code)");
  for (const env of [{}, { CLAUDE_CODE_SAFE_MODE: "1" }, { trustPolicy: true, policyWitness: {} }]) {
    assert.equal(claudeExecutionAdapter.authorityIssue({ env, workspacePath: "/fixture/workspace" }),
      "claude_native_policy_unproven");
  }
});

test("Claude builds immutable initial stdin argv with one exact schema and a restricted tool ceiling", () => {
  const invocation = claudeExecutionAdapter.buildInvocation({ descriptor: descriptor(), taskDirectory: "/fixture/task" });
  assert.equal(invocation.executable, "/fixture/claude");
  assert.equal(invocation.cwd, "/fixture/workspace");
  assert.equal(Object.isFrozen(invocation), true);
  assert.equal(Object.isFrozen(invocation.args), true);
  for (const flag of ["--print", "--restricted", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"]) {
    assert.ok(invocation.args.includes(flag), flag);
  }
  const value = (flag) => invocation.args[invocation.args.indexOf(flag) + 1];
  assert.equal(value("--json-schema"), '{"type":"object"}');
  assert.equal(value("--output-format"), "stream-json");
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.equal(value("--permission-prompts"), "none");
  assert.equal(value("--tools"), "Read,Glob,Grep");
  assert.equal(value("--mcp-config"), '{"mcpServers":{}}');
  assert.equal(value("--model"), "claude-opus-5-5");
  assert.equal(value("--effort"), "high");
  assert.equal(invocation.args.some((arg) => ["--resume", "--continue", "--bare", "--dangerously-skip-permissions"].includes(arg)), false);
});

test("Claude accepts only the structured terminal envelope and preserves its exact JSON value bytes", () => {
  const output = '{ "answer": 42, "text": "braces } [ and escaped \\\" quote", "nested": {"x":[1,2]} }';
  const result = '{"type":"result","subtype":"success","session_id":"session-fixture","is_error":false,' +
    '"result":"prose is separate","permission_denials":[],"structured_output":' + output + '}';
  assert.deepEqual(parse(stream(init()) + result + "\n"), { output, native_session: "session-fixture" });
});

test("Claude rejects unsupported authority, roots, effort, schema and executable bindings before invocation", async (t) => {
  const cases = [
    ["effort", (d) => { d.description.launch.effort = "xhigh"; }, "unsupported_claude_effort"],
    ["coding", (d) => { d.description.launch.capability = "workspace-write-denied"; }, "unsupported_claude_capability"],
    ["approvals", (d) => { d.description.effective_authority.approvals = "human"; }, "unsupported_claude_authority"],
    ["network", (d) => { d.description.effective_authority.network = "enabled"; }, "unsupported_claude_authority"],
    ["extra roots", (d) => { d.description.effective_authority.writable_roots = ["/"]; }, "unsupported_claude_authority"],
    ["root workspace", (d) => { d.workspace.path = "/"; }, "unsupported_claude_workspace"],
    ["relative workspace", (d) => { d.workspace.path = "relative"; }, "unsupported_claude_workspace"],
    ["writer claim", (d) => { d.workspace.claim.access = "write"; }, "unsupported_claude_workspace"],
    ["schema disagreement", (d) => { d.output_schema_bytes = '{"type":"string"}'; }, "output_schema_disagreement"],
    ["missing schema bytes", (d) => { delete d.output_schema_bytes; }, "output_schema_disagreement"],
    ["relative executable", (d) => { d.description.backend.executable.path = "claude"; }, "invalid_claude_executable"],
    ["wrong version", (d) => { d.description.backend.executable.version = "changed"; }, "invalid_claude_executable"],
    ["option as model", (d) => { d.description.launch.model = "--dangerously-skip-permissions"; }, "unsupported_claude_model"],
  ];
  for (const [name, mutate, code] of cases) await t.test(name, () => {
    const d = descriptor(); mutate(d);
    assert.throws(() => claudeExecutionAdapter.buildInvocation({ descriptor: d, taskDirectory: "/fixture/task" }),
      { message: code });
  });
});

test("Claude rejects init identities and inventories that differ from the pinned readonly launch", async (t) => {
  const cases = [
    ["missing session", { session_id: null }, "ambiguous_native_session"],
    ["model", { model: "claude-other" }, "native_launch_mismatch"],
    ["cwd", { cwd: "/" }, "native_launch_mismatch"],
    ["version", { claude_code_version: "2.1.288" }, "native_launch_mismatch"],
    ["permission mode", { permissionMode: "bypassPermissions" }, "native_launch_mismatch"],
    ["write tool", { tools: ["Read", "Glob", "Grep", "Edit"] }, "unexpected_native_inventory"],
    ["MCP", { mcp_servers: [{ name: "ambient" }] }, "unexpected_native_inventory"],
    ["plugin", { plugins: [{ name: "ambient" }] }, "unexpected_native_inventory"],
    ["skills", { skills: ["ambient"] }, "unexpected_native_inventory"],
    ["agents", { agents: ["ambient"] }, "unexpected_native_inventory"],
    ["commands", { slash_commands: ["ambient"] }, "unexpected_native_inventory"],
    ["memory config", { memory_paths: { user: "/ambient" } }, "unexpected_native_inventory"],
    ["additional native capabilities", { capabilities: ["background"] }, "unexpected_native_inventory"],
    ["background worker", { worker_epoch: 1 }, "unexpected_native_inventory"],
  ];
  for (const [name, changes, code] of cases) await t.test(name, () => {
    assert.throws(() => parse(stream({ ...init(), ...changes }, terminal())), { message: code });
  });
  await t.test("duplicate init", () => assert.throws(() => parse(stream(init(), init(), terminal())),
    { message: "ambiguous_native_session" }));
  await t.test("changed terminal session", () => assert.throws(() => parse(stream(init(), { ...terminal(), session_id: "another" })),
    { message: "ambiguous_native_session" }));
});

test("Claude accepts bounded preterminal read tool traffic without treating tool or prose output as the result", () => {
  const events = [init(), assistant([{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/fixture/workspace/source.mjs" } }]),
    toolResult("read-1"), assistant([{ type: "text", text: '{"answer":999}' }]), terminal()];
  assert.deepEqual(parse(stream(...events)), { output: '{"answer":42}', native_session: "session-fixture" });
  assert.throws(() => parse(stream(...events.slice(0, -1))), { message: "nonterminal_provider_output" });
});

test("Claude quarantines failed, incomplete, ambiguous and incompatible terminal streams", async (t) => {
  const cases = [
    ["no result", stream(init()), 0, "nonterminal_provider_output"],
    ["no init", stream(terminal()), 0, "ambiguous_native_session"],
    ["multiple results", stream(init(), terminal(), terminal()), 0, "ambiguous_structured_output"],
    ["nonzero", stream(init(), terminal()), 1, "provider_exit_failure"],
    ["truncated", stream(init(), terminal()).trimEnd(), 0, "truncated_provider_output"],
    ["malformed", stream(init()) + '{broken}\n', 0, "malformed_provider_output"],
    ["scalar event", 'null\n', 0, "malformed_provider_output"],
    ["missing structured", stream(init(), { ...terminal(), structured_output: undefined }), 0, "missing_structured_output"],
    ["prose only", stream(init(), { ...terminal(), result: '{"answer":42}', structured_output: undefined }), 0, "missing_structured_output"],
    ["array output", stream(init(), { ...terminal(), structured_output: [] }), 0, "missing_structured_output"],
    ["error subtype", stream(init(), { ...terminal(), subtype: "error_max_turns" }), 0, "provider_terminal_failure"],
    ["is_error", stream(init(), { ...terminal(), is_error: true }), 0, "provider_terminal_failure"],
    ["permission denial", stream(init(), { ...terminal(), permission_denials: [{ tool_name: "Edit" }] }), 0, "provider_terminal_failure"],
    ["config event", stream(init(), { type: "system", subtype: "config_changed", session_id: "session-fixture" }, terminal()), 0, "unsupported_provider_event"],
    ["unknown event", stream(init(), { type: "error", session_id: "session-fixture" }, terminal()), 0, "unsupported_provider_event"],
    ["changed assistant session", stream(init(), { ...assistant([{ type: "text", text: "hi" }]), session_id: "other" }, terminal()), 0, "ambiguous_native_session"],
    ["changed assistant model", stream(init(), assistant([{ type: "text", text: "hi" }], "changed"), terminal()), 0, "native_launch_mismatch"],
    ["changed terminal model", stream(init(), { ...terminal(), model: "changed" }), 0, "native_launch_mismatch"],
    ["fallback model usage", stream(init(), { ...terminal(), modelUsage: { "claude-other": {} } }), 0, "native_launch_mismatch"],
    ["write tool", stream(init(), assistant([{ type: "tool_use", id: "edit-1", name: "Edit", input: {} }]), terminal()), 0, "unexpected_native_tool"],
    ["outside read root", stream(init(), assistant([{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/etc/passwd" } }]), terminal()), 0, "unexpected_native_tool"],
    ["orphan tool result", stream(init(), toolResult("unknown"), terminal()), 0, "unexpected_native_tool"],
    ["pending tool", stream(init(), assistant([{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "source.mjs" } }]), terminal()), 0, "unfinished_native_tool"],
    ["postterminal message", stream(init(), terminal(), assistant([{ type: "text", text: "late" }])), 0, "out_of_order_provider_event"],
  ];
  for (const [name, stdout, exitCode, code] of cases) await t.test(name, () => {
    assert.throws(() => parse(stdout, exitCode), { message: code });
  });
  await t.test("duplicate envelope key", () => {
    const line = '{"type":"result","type":"result","subtype":"success","session_id":"session-fixture","is_error":false,"structured_output":{"answer":42}}';
    assert.throws(() => parse(stream(init()) + line + "\n"), { message: "ambiguous_provider_output" });
  });
});

test("Claude fixture execution preserves shell metacharacters in stdin, paths and the single schema argument", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-claude-adapter-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const workspace = join(scratch, "workspace $(echo unsafe) `literal`");
  await mkdir(workspace);
  const executable = join(scratch, "claude;literal.mjs");
  const d = descriptor();
  d.workspace.path = workspace;
  d.description.backend.executable.path = executable;
  d.output_contract.schema = { description: '$(echo unsafe) `literal` "quotes"', type: "object" };
  d.output_schema_bytes = '{"description":"$(echo unsafe) `literal` \\"quotes\\"","type":"object"}';
  const metadata = { ...init(), cwd: workspace };
  await writeFile(executable, '#!/usr/bin/env node\nimport {readFileSync} from "node:fs";\n' +
    'const output={input:readFileSync(0,"utf8"),args:process.argv.slice(2),cwd:process.cwd()};\n' +
    'console.log(JSON.stringify(' + JSON.stringify(metadata) + '));\n' +
    'console.log(JSON.stringify({...'+ JSON.stringify(terminal()) +',structured_output:output}));\n');
  await chmod(executable, 0o700);
  const invocation = claudeExecutionAdapter.buildInvocation({ descriptor: d, taskDirectory: join(scratch, "task") });
  const input = 'exact stdin bytes $(echo unsafe) `literal`\nUnicode λ\n';
  const stdout = execFileSync(invocation.executable, invocation.args, { cwd: invocation.cwd, input, encoding: "utf8", timeout: 5000 });
  const result = claudeExecutionAdapter.parseTerminal({ descriptor: d, stdout, exitCode: 0, lastMessage: null });
  const output = JSON.parse(result.output);
  assert.equal(output.input, input);
  assert.equal(output.cwd, workspace);
  assert.deepEqual(output.args, invocation.args);
  assert.equal(output.args.filter((value) => value === "--json-schema").length, 1);
  assert.equal(output.args[output.args.indexOf("--json-schema") + 1], d.output_schema_bytes);
});

test("Claude rejects ambiguous nested JSON keys and contradictory StructuredOutput tool results", () => {
  const ambiguous = '{"type":"result","subtype":"success","session_id":"session-fixture","is_error":false,"permission_denials":[],"structured_output":{"answer":41,"answer":42}}';
  assert.throws(() => parse(stream(init()) + ambiguous + "\n"), { message: "ambiguous_provider_output" });
  const structured = assistant([{ type: "tool_use", id: "structured-1", name: "StructuredOutput", input: { answer: 42 } }]);
  assert.deepEqual(parse(stream({ ...init(), tools: [...init().tools, "StructuredOutput"] }, structured,
    toolResult("structured-1"), terminal())), { output: '{"answer":42}', native_session: "session-fixture" });
  assert.throws(() => parse(stream(init(), structured, toolResult("structured-1"),
    { ...terminal(), structured_output: { answer: 43 } })), { message: "ambiguous_structured_output" });
});

test("supervised Claude pins installed official version and preserves subscription auth controls", () => {
  const d = descriptor();
  d.description.launch.trust_posture = "supervised-native-cli";
  d.description.backend.trust_contract = "flow.supervised-native-cli/v1";
  d.description.backend.executable.version = "2.1.318 (Claude Code)";
  d.description.effective_authority = { assurance: "operator_supervised_cli", approvals: "cli_requested_never", filesystem: "cli_requested_read_only", network: "not_independently_verified", escalation: "not_independently_verified", writable_roots: [] };
  assert.equal(claudeExecutionAdapter.supportedVersionForTrust("supervised-native-cli"), "2.1.318 (Claude Code)");
  assert.equal(claudeExecutionAdapter.authorityIssue({ executionTrust: "supervised-native-cli", launch: d.description.launch }), null);
  const invocation = claudeExecutionAdapter.buildInvocation({ descriptor: d });
  assert.ok(invocation.args.includes("--restricted")); assert.ok(invocation.args.includes("--safe-mode"));
  assert.equal(invocation.args.some(a => ["--bare", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"].includes(a)), false);
  const initialized = { ...init(), claude_code_version: "2.1.318" };
  assert.equal(claudeExecutionAdapter.parseTerminal({ descriptor: d, stdout: stream(initialized, terminal()), exitCode: 0 }).native_session, "session-fixture");
  assert.throws(() => claudeExecutionAdapter.parseTerminal({ descriptor: d, stdout: stream(init(), terminal()), exitCode: 0 }), /native_launch_mismatch/u);
});


test("supervised Claude recognizes observed builtin metadata without enabling ambient tools", () => {
  const d = descriptor();
  d.description.launch.trust_posture = "supervised-native-cli";
  d.description.backend.trust_contract = "flow.supervised-native-cli/v1";
  d.description.backend.adapter_version = "2";
  d.description.backend.executable.version = "2.1.318 (Claude Code)";
  d.description.effective_authority = { assurance: "operator_supervised_cli", approvals: "cli_requested_never", filesystem: "cli_requested_read_only", network: "not_independently_verified", escalation: "not_independently_verified", writable_roots: [] };
  const metadata = { ...init(), claude_code_version: "2.1.318", tools: [...init().tools, "StructuredOutput"],
    plugins: ["agents-md", "telemetry", "privacy", "plugin-authoring"].map(name => ({ name: "cc-plugin-" + name, path: "builtin", source: "cc-plugin-" + name + "@builtin" })),
    agents: ["claude", "Explore", "general-purpose", "Plan", "web-fetch"], capabilities: ["interrupt_receipt_v1", "sdk_mcp_manifests", "mcp_call_result_not_for_model_v1"] };
  const read = () => claudeExecutionAdapter.parseTerminal({ descriptor: d, stdout: stream(metadata, terminal()), exitCode: 0 });
  assert.equal(read().output, '{"answer":42}');
  const rate = { type: "rate_limit_event", session_id: "session-fixture", rate_limit_info: { status: "allowed", overageStatus: "rejected", isUsingOverage: false } };
  assert.equal(claudeExecutionAdapter.parseTerminal({ descriptor: d, stdout: stream(metadata, rate, terminal()), exitCode: 0 }).output, '{"answer":42}');
  for (const changed of [{ ...rate, session_id: "other" }, { ...rate, rate_limit_info: { status: "rejected" } }]) assert.throws(() => claudeExecutionAdapter.parseTerminal({ descriptor: d, stdout: stream(metadata, changed, terminal()), exitCode: 0 }));
  assert.throws(() => claudeExecutionAdapter.parseTerminal({ descriptor: d, stdout: stream(metadata, terminal(), rate), exitCode: 0 }), /out_of_order_provider_event/u);
  for (const mutation of [m => m.plugins.push({ name: "external", path: "/ambient", source: "external" }), m => m.tools.push("Agent"), m => m.capabilities.push("unknown"), m => m.agents.push("external"), m => m.mcp_servers.push({ name: "external" })]) {
    const copy = structuredClone(metadata); mutation(copy);
    assert.throws(() => claudeExecutionAdapter.parseTerminal({ descriptor: d, stdout: stream(copy, terminal()), exitCode: 0 }), /unexpected_native_inventory/u);
  }
  assert.throws(() => parse(stream({ ...metadata, claude_code_version: "2.1.287" }, terminal())), /unexpected_native_inventory/u);
});
