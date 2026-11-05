import { isAbsolute, relative, resolve } from "node:path";
import { canonicalize } from "./canonical.mjs";

const READ_TOOLS = ["Read", "Glob", "Grep"];

// Intended native argv/result implementation only. Restricted/safe mode still
// retains managed policy effects and additive roots; no trustworthy preflight
// is available for this version, so production admission remains unavailable.
export const claudeExecutionAdapter = Object.freeze({
  id: "flow.claude-print", version: "1", harness: "claude",
  supportedVersion: "2.1.287 (Claude Code)",
  authorityIssue() { return "claude_native_policy_unproven"; },
  buildInvocation({ descriptor }) {
    validateDescriptor(descriptor);
    const launch = descriptor.description.launch;
    const settings = JSON.stringify({
      disableAllHooks: true,
      permissions: { allow: ["Read", "Glob", "Grep"], additionalDirectories: [],
        deny: ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent"] },
      enableAllProjectMcpServers: false,
    });
    return Object.freeze({
      executable: descriptor.description.backend.executable.path,
      cwd: descriptor.workspace.path,
      args: Object.freeze(["--print", "--restricted", "--safe-mode", "--verbose",
        "--output-format", "stream-json", "--no-session-persistence", "--disable-slash-commands",
        "--permission-mode", "dontAsk", "--permission-prompts", "none",
        "--tools", "Read,Glob,Grep", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--settings", settings, "--model", launch.model, "--effort", launch.effort,
        "--json-schema", descriptor.output_schema_bytes]),
    });
  },
  parseTerminal({ descriptor, stdout, exitCode }) {
    validateDescriptor(descriptor);
    if (exitCode !== 0) throw new Error("provider_exit_failure");
    if (typeof stdout !== "string" || !stdout.endsWith("\n")) throw new Error("truncated_provider_output");
    let session = null, output = null, structuredInput = null;
    const tools = new Map(), pending = new Set();
    for (const line of stdout.split("\n").filter((value) => value.trim())) {
      let event;
      try { event = JSON.parse(line); } catch { throw new Error("malformed_provider_output"); }
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("malformed_provider_output");
      const eventFields = fields(line);
      if (output !== null) throw new Error(event.type === "result" ? "ambiguous_structured_output" : "out_of_order_provider_event");
      if (event.model !== undefined && event.model !== descriptor.description.launch.model) throw new Error("native_launch_mismatch");
      if (event?.type === "system" && event.subtype === "init") {
        if (session || typeof event.session_id !== "string" || !event.session_id.trim()) throw new Error("ambiguous_native_session");
        const launch = descriptor.description.launch;
        if (event.cwd !== descriptor.workspace.path || event.model !== launch.model ||
            event.claude_code_version !== "2.1.287" || event.permissionMode !== "dontAsk") throw new Error("native_launch_mismatch");
        const tools = event.tools;
        if (!Array.isArray(tools) || new Set(tools).size !== tools.length ||
            READ_TOOLS.some((tool) => !tools.includes(tool)) ||
            tools.some((tool) => ![...READ_TOOLS, "StructuredOutput"].includes(tool))) throw new Error("unexpected_native_inventory");
        for (const key of ["mcp_servers", "plugins", "agents", "skills", "slash_commands"]) {
          if (!Array.isArray(event[key]) || event[key].length) throw new Error("unexpected_native_inventory");
        }
        for (const key of ["plugin_errors", "plugin_warnings", "mcp_server_errors", "memory_paths", "terminal_slash_commands", "capabilities"]) {
          if (event[key] !== undefined && (!event[key] || typeof event[key] !== "object" || Object.keys(event[key]).length)) {
            throw new Error("unexpected_native_inventory");
          }
        }
        if (event.worker_epoch !== undefined || event.messaging_socket_path !== undefined) throw new Error("unexpected_native_inventory");
        if (event.output_style !== "default") throw new Error("unexpected_native_inventory");
        session = event.session_id;
      } else if (event?.type === "result") {
        if (event.subtype !== "success" || event.is_error !== false ||
            !Array.isArray(event.permission_denials) || event.permission_denials.length) throw new Error("provider_terminal_failure");
        if (!session || event.session_id !== session) throw new Error("ambiguous_native_session");
        if (event.modelUsage !== undefined && (!event.modelUsage || typeof event.modelUsage !== "object" ||
            Array.isArray(event.modelUsage) || Object.keys(event.modelUsage).some((model) => model !== descriptor.description.launch.model))) {
          throw new Error("native_launch_mismatch");
        }
        if (pending.size) throw new Error("unfinished_native_tool");
        if (!event.structured_output || typeof event.structured_output !== "object" || Array.isArray(event.structured_output)) {
          throw new Error("missing_structured_output");
        }
        if (structuredInput !== null && JSON.stringify(canonicalize(structuredInput)) !==
            JSON.stringify(canonicalize(event.structured_output))) throw new Error("ambiguous_structured_output");
        output = eventFields.get("structured_output");
      } else if (event.type === "assistant" || event.type === "user") {
        if (!session || event.session_id !== session) throw new Error("ambiguous_native_session");
        if (event.parent_tool_use_id !== null || event.is_error === true) throw new Error("unexpected_native_tool");
        const message = event.message;
        if (!message || message.role !== event.type || !Array.isArray(message.content)) throw new Error("malformed_provider_output");
        if (event.type === "assistant" && message.model !== descriptor.description.launch.model) throw new Error("native_launch_mismatch");
        for (const block of message.content) {
          if (event.type === "assistant" && (block?.type === "text" || block?.type === "thinking")) {
            if (typeof block[block.type] !== "string") throw new Error("malformed_provider_output");
          } else if (event.type === "assistant" && block?.type === "tool_use") {
            if (typeof block.id !== "string" || !block.id || tools.has(block.id) ||
                ![...READ_TOOLS, "StructuredOutput"].includes(block.name) || !block.input ||
                typeof block.input !== "object" || Array.isArray(block.input)) throw new Error("unexpected_native_tool");
            if (block.name === "StructuredOutput") {
              if (structuredInput !== null) throw new Error("ambiguous_structured_output");
              structuredInput = block.input;
            } else {
              const path = block.name === "Read" ? block.input.file_path : block.input.path ?? ".";
              if (typeof path !== "string" || !path || !withinWorkspace(descriptor.workspace.path, path)) throw new Error("unexpected_native_tool");
            }
            tools.set(block.id, block.name); pending.add(block.id);
          } else if (event.type === "user" && block?.type === "tool_result") {
            if (!pending.delete(block.tool_use_id) || block.is_error === true) throw new Error("unexpected_native_tool");
          } else throw new Error("unexpected_native_tool");
        }
      } else throw new Error("unsupported_provider_event");
    }
    if (!session || output === null) throw new Error("nonterminal_provider_output");
    return { output, native_session: session };
  },
});

function withinWorkspace(workspace, path) {
  const delta = relative(workspace, resolve(workspace, path));
  return delta !== ".." && !delta.startsWith("../") && !isAbsolute(delta);
}

function validateDescriptor(descriptor) {
  const launch = descriptor?.description?.launch;
  if (launch?.harness !== "claude" || launch.capability !== "read-only") throw new Error("unsupported_claude_capability");
  if (!["low", "medium", "high", "max"].includes(launch.effort)) throw new Error("unsupported_claude_effort");
  if (typeof launch.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(launch.model)) throw new Error("unsupported_claude_model");
  const authority = descriptor.description.effective_authority;
  if (authority?.approvals !== "denied" || authority.filesystem !== "read_only" || authority.network !== "disabled" ||
      authority.escalation !== false || !Array.isArray(authority.writable_roots) || authority.writable_roots.length) {
    throw new Error("unsupported_claude_authority");
  }
  const workspace = descriptor.workspace;
  if (typeof workspace?.path !== "string" || !isAbsolute(workspace.path) || resolve(workspace.path) !== workspace.path ||
      workspace.path === "/" || workspace.claim?.access !== "read_only") throw new Error("unsupported_claude_workspace");
  const backend = descriptor.description.backend;
  const executable = backend?.executable;
  if (backend?.harness !== "claude" || backend.adapter !== "flow.claude-print" || backend.adapter_version !== "1" ||
      typeof executable?.path !== "string" || !isAbsolute(executable.path) || executable.version !== "2.1.287 (Claude Code)") {
    throw new Error("invalid_claude_executable");
  }
  if (typeof descriptor.output_schema_bytes !== "string" ||
      descriptor.output_schema_bytes !== JSON.stringify(canonicalize(descriptor.output_contract?.schema))) {
    throw new Error("output_schema_disagreement");
  }
}

// JSON.parse validates syntax. This scanner retains the original structured
// value instead of reserializing it and changing accepted evidence bytes.
function fields(text, depth = 0) {
  if (depth > 128) throw new Error("malformed_provider_output");
  const result = new Map();
  let cursor = text.indexOf("{") + 1;
  const whitespace = () => { while (/\s/u.test(text[cursor] ?? "") && cursor < text.length) cursor++; };
  while (cursor < text.length) {
    whitespace();
    if (text[cursor] === "}") break;
    const keyEnd = tokenEnd(text, cursor);
    const key = JSON.parse(text.slice(cursor, keyEnd));
    if (result.has(key)) throw new Error("ambiguous_provider_output");
    cursor = keyEnd; whitespace(); cursor++; whitespace();
    const end = tokenEnd(text, cursor);
    const raw = text.slice(cursor, end);
    nestedFields(raw, depth + 1);
    result.set(key, raw);
    cursor = end; whitespace();
    if (text[cursor] === ",") cursor++;
  }
  return result;
}
function nestedFields(text, depth) {
  if (depth > 128) throw new Error("malformed_provider_output");
  if (text.startsWith("{")) fields(text, depth);
  else if (text.startsWith("[")) {
    let cursor = 1;
    while (cursor < text.length) {
      while (/\s/u.test(text[cursor])) cursor++;
      if (text[cursor] === "]") return;
      const end = tokenEnd(text, cursor);
      nestedFields(text.slice(cursor, end), depth + 1);
      cursor = end;
      while (/\s/u.test(text[cursor])) cursor++;
      if (text[cursor] === ",") cursor++;
    }
  }
}
function tokenEnd(text, start) {
  let depth = 0, quoted = false;
  for (let cursor = start; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (quoted) {
      if (char === "\\") cursor++;
      else if (char === '"') { quoted = false; if (depth === 0) return cursor + 1; }
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      if (depth === 0) return cursor;
      if (--depth === 0) return cursor + 1;
    } else if (depth === 0 && (char === "," || /\s/u.test(char))) return cursor;
  }
  return text.length;
}
