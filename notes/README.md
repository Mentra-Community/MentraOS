# Notes

Design specs, implementation plans, and working notes for MentraOS live here. This is intentionally a working tree for humans and agents — not the public product docs (those live in `mintlify-docs/`).

## Specs vs plans

This seed convention is based on a small set of examples under `notes/superpowers/` (originally one plan + a few specs). It is a convention to adopt going forward, not a long historical archive of every past plan.

| Kind | Path | Purpose |
|---|---|---|
| **Spec** | `notes/superpowers/specs/YYYY-MM-DD-kebab-topic.md` | Design / requirements source of truth: **what** should be built and **why** |
| **Plan** | `notes/superpowers/plans/YYYY-MM-DD-kebab-topic.md` | Execution checklist that **references a spec** and tracks **how** implementation progresses |

## Frontmatter

Start specs and plans with:

```yaml
---
status: draft | active | completed | archived
owner: <name or handle>
---
```

## Lifecycle

1. Write a **spec** when the design is non-trivial.
2. Write a **plan** that points at that spec and lists concrete tasks.
3. When a plan’s `status` becomes `completed`, **move** the file into `notes/superpowers/plans/archive/` (do not delete it). That keeps the active plans directory short while preserving history.

## Multi-session work

Any plan that will span multiple chat sessions should be saved as a file under `notes/superpowers/plans/` and updated in place. Prefer that over pasting the same plan YAML into every new conversation.

- **Cursor:** reference with `@notes/superpowers/plans/<file>.md`
- **Other tools:** open or attach the file by path

## Templates

- Plan skeleton: [superpowers/plans/TEMPLATE.md](superpowers/plans/TEMPLATE.md)

## Other content under `notes/`

Architecture notes, bluetooth-sdk subsystem docs, OTA specs, and related material also live under `notes/` (and under `agents/` for agent scratchpads). Use the superpowers layout above for **new** multi-session implementation plans.
