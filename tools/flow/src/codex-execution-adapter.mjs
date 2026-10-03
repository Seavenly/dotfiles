import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export const codexExecutionAdapter = Object.freeze({
  id: "flow.codex-exec", version: "1", harness: "codex",
  supportedVersion: "codex-cli 0.160.0",
  // Filesystem dependencies are a trusted adapter test seam, never supplied
  // by a Flow request or native invocation environment.
  authorityIssue({ env, workspacePath }, {
    pathExists = existsSync, canonicalPath = realpathSync,
  } = {}) {
    const home = env.CODEX_HOME ?? join(env.HOME, ".codex");
    // Ignore user config/rules, but never assume these flags disable managed
    // policy or plugin/hook inventories. Do not inspect authentication bytes.
    const ambient = ["/etc/codex/config.toml", "/etc/codex/requirements.toml",
      join(home, "requirements.toml"), join(home, "hooks"), join(home, "plugins")];
    if (workspacePath) {
      let path = canonicalPath(workspacePath);
      while (true) {
        ambient.push(join(path, ".codex", "config.toml"), join(path, ".codex", "hooks"));
        const parent = dirname(path); if (parent === path) break; path = parent;
      }
    }
    return ambient.some((path) => pathExists(path)) ? "unproved_ambient_authority" : null;
  },
  buildInvocation({ descriptor, taskDirectory }) {
    const launch = descriptor.description.launch;
    const args = ["exec", "--strict-config", "--ignore-user-config", "--ignore-rules", "--ephemeral",
      "--json", "--color", "never", "--cd", descriptor.workspace.path,
      "--model", launch.model, "--sandbox", launch.capability === "read-only" ? "read-only" : "workspace-write",
      "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
      "-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
      "-c", "sandbox_workspace_write.writable_roots=" + JSON.stringify(launch.capability === "read-only" ? [] : [join(taskDirectory, "scratch")]),
      "-c", 'model_reasoning_effort=' + JSON.stringify(launch.effort),
      "-c", "project_doc_max_bytes=0", "-c", "mcp_servers={}", "-c", "hooks={}",
      "--output-schema", join(taskDirectory, "output-schema.json"),
      "--output-last-message", join(taskDirectory, "last-message.json"), "-"];
    return { executable: descriptor.description.backend.executable.path, args, cwd: descriptor.workspace.path };
  },
  parseTerminal({ stdout, lastMessage, exitCode }) {
    if (exitCode !== 0) throw new Error("provider_exit_failure");
    if (!stdout.endsWith("\n")) throw new Error("truncated_provider_output");
    const lines = stdout.split("\n").filter((line) => line.trim());
    let session = null, started = false, completed = false, final = null;
    const completedMessages = new Set();
    for (const line of lines) {
      let event; try { event = JSON.parse(line); } catch { throw new Error("malformed_provider_output"); }
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("malformed_provider_output");
      if (completed) throw new Error("out_of_order_provider_event");
      if (event.type === "thread.started") {
        if (session || typeof event.thread_id !== "string" || !event.thread_id.trim()) throw new Error("ambiguous_native_session");
        session = event.thread_id;
      } else if (event.type === "turn.started") {
        if (!session || started) throw new Error("ambiguous_native_turn"); started = true;
      } else if (event.type === "turn.completed") {
        if (!started || completed || final === null) throw new Error("missing_structured_output"); completed = true;
      } else if (event.type === "turn.failed" || event.type === "error") {
        throw new Error("provider_terminal_failure");
      } else if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
        if (!started || completed) throw new Error("out_of_order_provider_event");
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          if (typeof event.item.id !== "string" || !event.item.id || typeof event.item.text !== "string" || completedMessages.has(event.item.id)) throw new Error("ambiguous_structured_output");
          completedMessages.add(event.item.id);
          if (final !== null) {
            try { const previous = JSON.parse(final); if (previous && typeof previous === "object" && previous.schema) throw new Error("ambiguous_structured_output"); }
            catch (error) { if (error.message === "ambiguous_structured_output") throw error; }
          }
          final = event.item.text;
        }
      } else throw new Error("unsupported_provider_event");
    }
    if (!completed || !session || final === null) throw new Error("nonterminal_provider_output");
    if (typeof lastMessage !== "string" || lastMessage.trim() !== final.trim()) throw new Error("output_file_disagreement");
    let output; try { output = JSON.parse(final); } catch { throw new Error("unstructured_provider_output"); }
    if (output === null || typeof output !== "object" || Array.isArray(output)) throw new Error("unstructured_provider_output");
    return { output: final, native_session: session };
  },
});
