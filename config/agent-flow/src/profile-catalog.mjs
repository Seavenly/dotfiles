const kanbanTools = [
  "kanban_block",
  "kanban_comment",
  "kanban_complete",
  "kanban_create",
  "kanban_heartbeat",
  "kanban_link",
  "kanban_show",
];
const fileTools = ["patch", "read_file", "search_files", "write_file"];

export const PROFILE_CATALOG = {
  "flow-controller": {
    configuredToolsets: ["kanban", "no_mcp"],
    enabledToolsets: [],
    workerTools: kanbanTools,
  },
  analyst: {
    configuredToolsets: ["file", "web", "no_mcp"],
    enabledToolsets: ["file", "web"],
    workerTools: [...kanbanTools, ...fileTools],
    note:
      "Hermes v0.18.2 bundles write operations into the read-oriented file " +
      "toolset; the profile contract forbids their use.",
  },
  critic: {
    configuredToolsets: ["file", "web", "no_mcp"],
    enabledToolsets: ["file", "web"],
    workerTools: [...kanbanTools, ...fileTools],
    note:
      "Hermes v0.18.2 bundles write operations into the read-oriented file " +
      "toolset; the profile contract forbids their use.",
  },
  builder: {
    configuredToolsets: ["file", "terminal", "no_mcp"],
    enabledToolsets: ["file", "terminal"],
    workerTools: [...kanbanTools, ...fileTools, "process", "terminal"].sort(),
  },
  artifact: {
    configuredToolsets: ["file", "no_mcp"],
    enabledToolsets: ["file"],
    workerTools: [...kanbanTools, ...fileTools],
  },
  gate: {
    configuredToolsets: ["terminal", "no_mcp"],
    enabledToolsets: ["terminal"],
    workerTools: [...kanbanTools, "process", "terminal"],
  },
};

export const PROFILE_NAMES = Object.keys(PROFILE_CATALOG);
export const SUPPORTED_HERMES_VERSIONS = ["0.18.2"];
