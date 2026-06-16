# Cloud-v2 runbooks

What an engineer on the cloud-v2 team needs to know about how this service
is built, deployed, and operated. Not a tutorial — install instructions live
in the project [`README.md`](../../README.md). These docs cover the *model*
behind the infrastructure: what runs where, why we made specific choices,
and what to do when something breaks.

## Start here

| Doc | Purpose |
| --- | --- |
| [`infra.md`](./infra.md) | The system primer — services, clusters, datastores, how the pieces fit. |

## Platforms

How we use each external system. NOT product overviews — covers our
configuration choices, conventions, and what's set up where.

| Doc | Topic |
| --- | --- |
| [`aws.md`](./aws.md) | What we own in AWS: regions, EKS, ECR, ElastiCache, NLB, ALB, VPC. |
| [`porter/deploys.md`](./porter/deploys.md) | Porter's app/services model, env-group flow, what `porter apply` actually does. |
| [`doppler/porter-integration.md`](./doppler/porter-integration.md) | Doppler ↔ Porter sync, multi-env model, token rotation. |
| [`cloudflare/dns-for-nlb.md`](./cloudflare/dns-for-nlb.md) | DNS, DNS-only mode for UDP, how to wire a hostname to an NLB. |
| `betterstack.md` | Log aggregation, querying, alerts. *(TODO — port from v1)* |

## Doing a thing

Operational procedures — the "how do I X" docs.

| Doc | Task |
| --- | --- |
| [`deploy/udp-nlb-aws.md`](./deploy/udp-nlb-aws.md) | Provision UDP NLB for a new region (manifest, AWS LB Controller, DNS). |
| `deploy/new-region.md` | Bring up cloud-v2 in a new AWS region from scratch. *(TODO)* |
| `deploy/promote-to-prod.md` | dev → staging → prod release flow. *(TODO)* |
| `secrets/adding-a-secret.md` | Add a new secret in Doppler so it reaches the pods. *(TODO)* |
| `secrets/rotating-a-secret.md` | Rotate provider creds, JWT keys, etc. *(TODO)* |

## When pager fires

| Doc | Symptom |
| --- | --- |
| [`incident-response/pod-crash-loop.md`](./incident-response/pod-crash-loop.md) | A service's pods keep restarting. |
| `incident-response/ws-disconnect-storm.md` | All clients disconnecting at once. *(TODO — port v1 issues 034, 035, 066)* |
| `incident-response/soniox-outage.md` | Soniox API returning errors. *(TODO)* |
| `incident-response/mongo-latency.md` | Atlas latency spike. *(TODO — port v1 issue 062)* |
| `incident-response/elasticache-down.md` | ElastiCache unreachable from pods. *(TODO)* |

## Conventions

Decisions that aren't enforced by code but matter for working as a team.

| Doc | What it covers |
| --- | --- |
| [`conventions/naming.md`](./conventions/naming.md) | Doppler config names, env group names, AWS resource names, DNS hostnames, where files live. |
| `conventions/branching.md` | Git branches, per-developer deployment targets, PR previews. *(TODO)* |

## How to add to these runbooks

When you find yourself explaining the same thing twice — "wait, why does
the dev MONGO_URL point at localhost when prod is Atlas?", "what does
`additionalPorts:` in porter.yaml actually do?" — write it down here.

The format is unstructured but the contract is "an engineer joining the team
in 6 months should be able to read this and understand the operational
context, not just the code." That usually means:

- **The model** (how a thing works in our setup, not the vendor's marketing)
- **The decisions** (why we did it this way, what alternatives we passed on)
- **The gotchas** (what we tried that didn't work)
- **The handles** (commands / dashboards / configs the doc references)
