# Internal scratchpad — not authoritative documentation

This folder is an **internal scratchpad** for LLM-assisted feature planning, design exploration, and one-off investigations. The files here are not maintained, may not reflect the current code, and should **not** be linked to from public docs (the top-level [docs/README.md](../README.md) index).

## Treat this folder as

- **Useful for context** — what we were thinking when a feature was being designed
- **A place to dump LLM planning output** while iterating on a change
- **A graveyard of partial ideas** that didn't turn into shipped features

## Do NOT treat this folder as

- A reference for how things currently work
- A substitute for reading the code
- A target for the public docs index

## When a doc here describes shipped behavior

Move it out — write a fresh, current doc under [`docs/features/`](../features/) (or wherever fits the public structure) and either delete the scratch version or leave a one-line pointer to the new location. Public docs should be:

- Verified against the current code
- Linked from [`docs/README.md`](../README.md)
- Maintained as the code changes

## When a doc here describes a proposal

Leave it here. If the feature ships, do the migration above. If it gets abandoned, delete it (the design is preserved in git).
