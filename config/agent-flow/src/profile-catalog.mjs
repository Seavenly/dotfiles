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

export const PROFILE_CONCURRENCY = {
  maxInProgress: 6,
  maxInProgressPerProfile: 3,
  maxSpawn: 6,
};

export const PROFILE_CATALOG = {
  "flow-controller": {
    configuredToolsets: ["kanban", "terminal", "no_mcp"],
    enabledToolsets: ["terminal"],
    workerTools: [...kanbanTools, "process", "terminal"],
    terminal: true,
    contractOnly: [
      "create only transitions declared by the selected versioned graph",
      "run only the exact agent-flow controller command pinned by the card",
      "end every worker attempt with a Kanban lifecycle call",
    ],
  },
  analyst: {
    configuredToolsets: ["file", "web", "no_mcp"],
    enabledToolsets: ["file", "web"],
    workerTools: [...kanbanTools, ...fileTools],
    terminal: false,
    contractOnly: [
      "treat the assigned repository and pinned target as read-only",
      "end every worker attempt with a Kanban lifecycle call",
    ],
    note:
      "Hermes v0.18.2 bundles write operations into the read-oriented file " +
      "toolset; the profile contract forbids their use.",
  },
  critic: {
    configuredToolsets: ["file", "web", "no_mcp"],
    enabledToolsets: ["file", "web"],
    workerTools: [...kanbanTools, ...fileTools],
    terminal: false,
    contractOnly: [
      "treat the assigned repository and pinned target as read-only",
      "remain independent from the builder lane beyond provider routing",
      "end every worker attempt with a Kanban lifecycle call",
    ],
    note:
      "Hermes v0.18.2 bundles write operations into the read-oriented file " +
      "toolset; the profile contract forbids their use.",
  },
  builder: {
    configuredToolsets: ["file", "terminal", "no_mcp"],
    enabledToolsets: ["file", "terminal"],
    workerTools: [...kanbanTools, ...fileTools, "process", "terminal"].sort(),
    terminal: true,
    contractOnly: [
      "write only inside the assigned worktree",
      "avoid concurrent writes beyond Kanban dependency serialization",
      "end every worker attempt with a Kanban lifecycle call",
    ],
  },
  artifact: {
    configuredToolsets: ["file", "no_mcp"],
    enabledToolsets: ["file"],
    workerTools: [...kanbanTools, ...fileTools],
    terminal: false,
    contractOnly: [
      "write only declared artifact paths and never product code",
      "end every worker attempt with a Kanban lifecycle call",
    ],
  },
  gate: {
    configuredToolsets: ["terminal", "no_mcp"],
    enabledToolsets: ["terminal"],
    workerTools: [...kanbanTools, "process", "terminal"],
    terminal: true,
    contractOnly: [
      "execute only the exact command and workspace declared by the gate spec",
      "never edit product code directly",
      "end every worker attempt with a Kanban lifecycle call",
    ],
  },
};

export const PROFILE_NAMES = Object.keys(PROFILE_CATALOG);
export const SUPPORTED_HERMES_VERSIONS = ["0.18.2"];
