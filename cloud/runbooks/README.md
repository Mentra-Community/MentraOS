# Runbooks

Operational and how-to docs for the team. Each folder covers one
external service or topic. Read the folder's `README.md` first;
the specific procedures are in sibling files.

## Audience

Internal team. Assumes shell access, the relevant CLI tools
installed, and that you can ask Isaiah or Israelov when access is
missing.

## Conventions

- One folder per external service or topic.
- Each folder has a `README.md` that explains what the service
  does for us and who has access.
- Each folder also has a `concepts.md` that explains the
  underlying technology (what is a DaemonSet, what is anycast,
  what is a dist-tag). Read it first if the service is new to
  you.
- Specific procedures live in named files (`deploys.md`,
  `publishing.md`, etc.). Use the imperative title that matches
  the task you would type to find it.
- Code blocks are runnable. Comments explain why, not what.
- Runbooks describe present-tense actions. They are living docs
  and stay up to date.
- Past-tense reasoning (the why behind a decision, RCA, design
  spike) lives in `cloud/issues/*` or `cloud/.architecture/*`. Do
  not park living docs in there.

## Folders

| Folder | Service | What it covers |
| --- | --- | --- |
| `npm/` | npmjs.com | Publishing `@mentra/*` packages |
| `porter/` | Porter (on AKS) | Deploys, env vars, logs, rollback |
| `cloudflare/` | Cloudflare | Edge, DNS, load balancer, idle timeouts |
| `betterstack/` | BetterStack | Logs, dashboards, the `bstack` CLI |
| `doppler/` | Doppler | Secrets across environments |

[infra.md](infra.md) in this folder is a primer on how the pieces fit
together (Porter, Kubernetes, Vector, BetterStack). Read it once,
then use the per-folder runbooks for actual tasks.

## Related

- `cloud/tools/bstack/runbooks/` has incident-response runbooks
  (`client-disconnect.md`, `pod-crash.md`, `weekly-error-audit.md`)
  that go deeper than the bstack CLI usage doc here. Those stay
  where they live today; the BetterStack runbook here cross-links
  to them.
