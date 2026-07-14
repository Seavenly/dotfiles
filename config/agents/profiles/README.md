# Agent profiles

Group each role in its own directory and keep complete native harness variants
beside a small shared contract:

```text
reviewer/
├── CONTRACT.md
├── claude/
│   └── reviewer.md
├── codex/
│   └── reviewer.toml
└── hermes/
    ├── SOUL.md
    ├── config.yaml
    └── distribution.yaml
```

`CONTRACT.md` records shared purpose, behavioral invariants, and expected
capabilities. It is documentation, not a generated source schema. Each harness
variant remains authoritative for its own model, tools, permissions, skills,
hooks, and lifecycle behavior.

Profiles do not need variants for every harness. Add a variant only when the
role is useful in that harness. Keep Hermes runtime credentials, memories,
sessions, gateway state, and databases outside this repository.

Hermes v0.18.2 bundles reads, writes, patches, and search in one `file`
toolset. The analyst and critic contracts are therefore read-oriented policy,
not a filesystem or tool-schema write boundary. Profile doctoring must report
this limitation until Hermes or a separately approved plugin provides a native
read-only subset.

## Hermes automation inventory

The initial Hermes automation profiles are execution lanes, not one profile
per semantic task role:

| Profile | Semantic roles | Distinct lane requirement |
| --- | --- | --- |
| `flow-controller` | Root, slice, review, and epic controllers | Kanban routing authority without code tools |
| `analyst` | Planner, researcher, orientation, lens reviewer | Read-oriented evidence and planning |
| `critic` | Review critic, gap analyst, completeness critic | Independent model and provider routing |
| `builder` | Tester, implementer, prototype builder, revision implementer | Product-code writes in a pinned worktree |
| `artifact` | Synthesizer, diagrammer | Artifact writes without product-code ownership |
| `gate` | Test, verification, commit, rendering, and integration gates | Restricted deterministic commands interpreted by exit status |

Task-pinned skills select semantic behavior within a lane. Add another profile
only when model routing, authority, credentials, runtime, state, or concurrency
must differ. The complete design and the machine-local routing strategy live in
[`config/agent-flow/README.md`](../../agent-flow/README.md).
