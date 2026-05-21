# Doppler: Concepts and Prerequisites

Read this first if you are new to the stack. Operational
procedures live in [daily-use.md](daily-use.md), [adding-secrets.md](adding-secrets.md), and
[porter-integration.md](porter-integration.md).

The summary: Doppler holds every secret used by the cloud and
by team tooling. Production pods load secrets from Doppler at
process startup. The CLI and the web UI are the two ways to
read or change them.

If terms below are unfamiliar, the rest of this doc explains
each one.

## Why we use a secrets manager at all

The simplest way to give a process its config is environment
variables. The simplest way to set them in production is in a
config file checked into the repo. That file ends up in git
history forever. Anyone who clones the repo gets the secrets.
If a single secret leaks, the only fix is to rotate every
secret and audit every consumer.

A secrets manager solves this by being the single source of
truth. The repo references secrets by name; the actual values
live in Doppler with access controls, audit logs, and the
ability to rotate without code changes. Production pods get
their secrets via Porter's Doppler integration (Porter pulls
from Doppler at deploy time and writes them into the pod's
env). Local dev tools fetch the same secrets via `doppler run
--` at process start. See [porter-integration.md](porter-integration.md) for the
production flow.

For our setup: the repo's `porter.yaml` files declare
non-secret env vars literally; secrets come from Doppler via
the Porter integration.

## Project

A project is a top-level container in Doppler. Each project
has its own access controls and its own set of configs.

We have a handful of projects:

| Project | Purpose |
| --- | --- |
| `mentraos-cloud` | Production cloud secrets, per region |
| `mentra-sre` | SRE tooling secrets (BetterStack, Cloudflare LB token, admin JWTs) |
| `live-captions`, `mentra-notes`, `recorder` | Per-app secrets for those apps |

A project can hold any number of secrets. The same secret name
across projects is independent (e.g. `BETTERSTACK_SOURCE_TOKEN`
in `mentraos-cloud` is a different value from
`BETTERSTACK_SOURCE_TOKEN` in `mentra-sre`).

## Config

A config is one environment within a project. Think of configs
as the columns of a spreadsheet: same set of secret names,
different values per environment.

Within `mentraos-cloud` we have:

- `dev`
- `staging`
- `prod_central-us`, `prod_us-east`, `prod_us-west`,
  `prod_france`, `prod_east-asia` (per-region prod)

A config can also "branch" or "inherit" from another config:
`prod_us-east` may inherit common secrets from a parent and
override only what's region-specific. The Doppler UI shows the
inheritance chain.

When you run `doppler run --config <name>`, you are picking
one column of the spreadsheet. The values exported as env vars
are the resolved values for that config (after inheritance).

## Secret name + value

A secret has a name (`MENTRAOS_API_KEY`, `MONGODB_URI`,
`BETTERSTACK_SOURCE_TOKEN`) and a value. Names follow
`UPPER_SNAKE_CASE`. Values are arbitrary strings, including
JSON blobs, certificates with newlines, etc.

The name is what the application reads from `process.env`. The
value is what it gets.

## Tokens

Doppler authenticates clients with tokens. Two kinds matter:

### Personal token

Tied to a Doppler user (you). Created by `doppler login`. Used
by the CLI on your laptop. Has read access to whichever
projects + configs you have been granted via the team
dashboard.

### Service token

Tied to a project + config, not a user. Created in the Doppler
dashboard under a config's Tokens section. Has read access
to ONE config (or read+write if you grant it). Used by long-
running services like Porter pods.

Service tokens are used by Porter's Doppler integration on the
team's behalf to pull secrets at deploy time. The
`DOPPLER_TOKEN` itself is not present in our running pods; the
integration handles auth at sync time, and pods see only the
already-pulled secrets in their env. See
[porter-integration.md](porter-integration.md) for the full flow.

Service tokens are revocable. Rotating one means: generate a
new token, update the consumer (Porter integration), revoke the
old token.

## `doppler run --`

The most common pattern. You wrap a command in
`doppler run --`:

```bash
doppler run --project mentra-sre --config dev -- bstack health
```

Doppler does this:

1. Authenticate with the personal token (from `doppler login`)
   or, in non-interactive contexts, a service token.
2. Pull the secrets for `mentra-sre:dev`.
3. Export them as environment variables.
4. `exec` the rest of the command (`bstack health`) with that
   env block.

The `--` separates Doppler's flags from the inner command's
flags. Without it, Doppler would interpret `bstack`'s flags
as its own.

The injected env exists only for the lifetime of that command.
Subsequent commands in the same shell do not inherit Doppler's
env.

## How Porter pods get secrets

We use Porter's native Doppler integration for production, not
`doppler run --` at process start. The pod's `run` is just
`./start.sh` (which is `cd packages/cloud && bun run start`),
no Doppler CLI involved.

Flow at deploy time:

1. Porter has a Doppler integration linked to a Doppler service
   account. The integration is configured per Porter app to pull
   from a specific Doppler project + config (e.g. `cloud-prod`
   in central pulls `mentraos-cloud:prod_central-us`).
2. When Porter deploys, it calls Doppler with the integration's
   token, fetches the secrets, and writes them into the
   Kubernetes Secret backing the deployment's env.
3. The pod starts. Its env block already contains the secrets
   plus a few Doppler metadata vars (`DOPPLER_PROJECT`,
   `DOPPLER_CONFIG`, `DOPPLER_ENVIRONMENT`) that mark which
   config Porter pulled from.
4. The Bun process reads `process.env.FOO` normally.

Notice: there is no `DOPPLER_TOKEN` in the pod. That token
lives in Porter's integration setup, not in the runtime env.
The Doppler CLI does not run inside the pod.

Updates do not flow into a running pod. The pod read its env
at process start. To pick up a new value: redeploy the app via
the Porter dashboard, which re-syncs the Doppler integration
and rolls the pods. See [adding-secrets.md](adding-secrets.md).

## Web UI vs CLI

Both work. Use whichever fits the task:

- **Web UI** (https://dashboard.doppler.com/): browse,
  diff configs, manage tokens, audit logs. Best for
  exploration and managing access.
- **CLI** (`doppler`): scriptable, fast for repeated tasks,
  used in `doppler run` injection. Best for daily use.

You can use both interchangeably; changes in either show up
immediately in the other.

## Common day-to-day commands

```bash
doppler login                                       # one-time
doppler whoami                                      # confirm logged in
doppler projects                                    # list visible projects
doppler secrets --project foo --config bar          # list secrets
doppler secrets get FOO --plain                     # one value
doppler run --project foo --config bar -- cmd       # inject + exec
```

[daily-use.md](daily-use.md) has the full set.

## What this means for the cloud

The cloud's pods get secrets from Doppler via Porter's
integration at deploy time, not via `doppler run` at process
start. Code reads `process.env.FOO` either way. Nothing in the
repo references the actual secret values; everything is by
name. Secrets are added or rotated in Doppler, then pods are
redeployed (or restarted, which pulls the latest sync) to pick
them up.

Local dev is the inverse: `doppler run -- <command>` pulls the
same secrets at command start, exports them as env vars for
that one process, then exits. Same Doppler config either way;
the difference is who pulls and when.

Anything tempted to live in `porter.yaml` because it is "just
a config" should be checked: if it would be embarrassing in a
public repo, it is a secret. Put it in Doppler.
