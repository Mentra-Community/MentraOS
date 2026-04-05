# Cloud Plan

The living plan for the MentraOS cloud. Gives the team visibility into what's happening, what's next, and what recently shipped.

**Updated weekly.** Each section is its own file so they can be updated independently.

## Sections

- **[1-overview.md](./1-overview.md)** — Quick-glance cloud status. Regions, stability, load. Read this first.
- **[2-shipped.md](./2-shipped.md)** — What shipped in the last 2 weeks. Items get pruned after 2 weeks.
- **[3-tickets.md](./3-tickets.md)** — Who's working on what, with goals and context. Active work + assigned tasks.
- **[4-backlog.md](./4-backlog.md)** — Unassigned future work. Flat list. Big projects link to their own plan docs.

## Plans

Bigger projects that need their own design docs live in `plans/`:

- **[plans/cloud-scaling.md](./plans/cloud-scaling.md)** — Multi-region, Redis, horizontal auto-scaling.
- **[plans/cloud-testing.md](./plans/cloud-testing.md)** — E2E testing, cloud-bridge extraction, test harness.

## How to maintain this

- **When something ships:** Add it to the top of 2-shipped.md with a date. Remove it from 3-tickets.md.
- **When picking up new work:** Move it from 4-backlog.md to 3-tickets.md with an assignee.
- **When something changes:** Update 1-overview.md.
- **Weekly:** Prune 2-shipped.md to last 2 weeks. Review 4-backlog.md. Update 1-overview.md.
- **When pasting to Google Docs:** Grab the files you need. They're designed to copy cleanly (headers, bold, bullets, no tables or code blocks that break on paste).
