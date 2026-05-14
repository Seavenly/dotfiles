# agent-teams-kit

Kit mounted into each agent-teams sbx sandbox via `--kit`. Defines the role
agents, in-sandbox lead briefings, settings, and cap defaults that drive
the team.

**For full architecture, read `../AGENT-TEAMS.md` in the dotfiles repo.**
This README covers only kit-internal mechanics — what's in this directory
and how to modify it.

## Contents

```
agent-teams-kit/
├── README.md                          # this file
├── SETUP.md                           # one-time host setup commands
├── template/
│   └── build.sh                       # builds the claude-team sbx template (Phase 2)
└── .claude/                           # mounted into the sandbox's CLAUDE_HOME equivalent
    ├── settings.json                  # enables Agent Teams, teammateMode: tmux
    ├── defaults.yaml                  # cap defaults, merged into brief
    ├── agents/                        # role definitions
    │   ├── researcher.md
    │   ├── planner.md
    │   ├── tester.md
    │   ├── implementer.md
    │   ├── critic.md
    │   └── synthesizer.md
    └── commands/                      # in-sandbox slash commands (lead briefings)
        ├── feature-flow.md
        ├── review-flow.md
        └── spike-flow.md
```

## How role agents work

Each file in `.claude/agents/` defines a role usable in two modes:

1. **As a subagent**: invoked by the lead via the `Agent()` tool when work is
   sequential or same-file (e.g., the TDD inner loop).
2. **As a teammate type**: when the lead spawns an Agent Teams teammate by
   role name (e.g., "spawn a `critic` teammate"), Claude Code looks up the
   role definition and appends its body to the teammate's system prompt.

The mapping per flow is documented in `AGENT-TEAMS.md`.

**Caveat:** when a subagent definition runs as a teammate, its `skills` and
`mcpServers` frontmatter fields are not applied. Put any team-wide skills
or MCP configs at the kit's top-level `.claude/skills/` and `.claude/mcp.json`
so teammate sessions pick them up via normal init.

## How in-sandbox lead briefings work

Files in `.claude/commands/` are slash commands invoked **inside the
sandbox** by the host-side launcher. They tell the lead Claude session:

- Read `/work/brief.md`
- Form a team according to the flow's recipe
- Use which roles for what
- What artifacts to produce in `/work/out/`
- When to escalate to the user vs. proceed autonomously

The host-side slash commands (in `~/.dotfiles/claude/commands/`) are
separate — they handle brief drafting, user confirmation, and sandbox
spawn. They invoke the in-sandbox lead briefing via the sbx `-p` argument.

## Defaults and overrides

`defaults.yaml` carries cap and gate defaults. The host slash command merges
this with brief-level overrides and any command-line flags before writing
the final brief. Agents in the sandbox only ever read the final brief; they
do not read `defaults.yaml` directly at runtime.

## Modifying the kit

- **Tune a role's prompt** — edit `.claude/agents/<role>.md`. Body changes
  apply on next sandbox spawn (no rebuild needed; kit is mounted, not
  baked).
- **Change a flow's recipe** — edit `.claude/commands/<flow>.md`.
- **Change cap defaults** — edit `defaults.yaml`. Brief overrides still win
  per-run.
- **Add a new role** — drop a new `.md` in `.claude/agents/` and reference
  it from the appropriate lead briefing(s).
- **Add a new flow** — new lead briefing in `.claude/commands/`, new
  host-side command in `~/.dotfiles/claude/commands/`, update
  `AGENT-TEAMS.md`.
