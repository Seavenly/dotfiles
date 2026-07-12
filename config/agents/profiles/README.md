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
