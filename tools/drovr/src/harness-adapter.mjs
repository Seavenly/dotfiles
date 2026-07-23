import { homedir } from "node:os";
import { join } from "node:path";

import {
  captureClaudeTranscriptCursor,
  captureClaudeTranscriptInventory,
  extractClaudeTurn,
  locateClaudeTranscript,
  resolveClaudeInventoryCursor,
} from "./claude-transcript.mjs";
import { validateClaudeLaunchSpecification } from "./claude.mjs";
import {
  captureTranscriptCursor,
  captureTranscriptInventory,
  extractCodexTurn,
  locateCodexTranscript,
  resolveInventoryCursor,
} from "./codex-transcript.mjs";

export function harnessAdapter(harness, env = process.env) {
  const home = env.HOME ?? homedir();
  if (harness === "claude") {
    return {
      label: "Claude",
      root: join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects"),
      locate: locateClaudeTranscript,
      captureCursor: captureClaudeTranscriptCursor,
      captureInventory: captureClaudeTranscriptInventory,
      resolveInventory: resolveClaudeInventoryCursor,
      extract: extractClaudeTurn,
      inventoryBeforeDelivery: true,
      startAgent: (herdr, options) => herdr.startClaudeAgent(options),
      validate: validateClaudeLaunchSpecification,
    };
  }
  return {
    label: "Codex",
    root: join(env.CODEX_HOME ?? join(home, ".codex"), "sessions"),
    locate: locateCodexTranscript,
    captureCursor: captureTranscriptCursor,
    captureInventory: captureTranscriptInventory,
    resolveInventory: resolveInventoryCursor,
    extract: extractCodexTurn,
    startAgent: (herdr, options) => herdr.startCodexAgent(options),
    validate: async () => {},
  };
}
