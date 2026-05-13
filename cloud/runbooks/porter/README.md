# Porter

Porter is the deployment platform that runs the cloud. It sits on
top of Azure Kubernetes Service (AKS) and provides a UI/CLI for
deploying apps, managing clusters, viewing logs, and configuring
services. Each Porter "application" maps to a Kubernetes
deployment.

For a deeper architecture primer see [../infra.md](../infra.md).

## What runs on Porter

| App | What it is | Config file |
| --- | --- | --- |
| `cloud-prod` | Production cloud, central US | `cloud/porter.yaml` |
| `cloud-prod-us-east` | Production cloud, US East | `cloud/porter-us-east.yaml` |
| `cloud-prod-us-west` | Production cloud, US West | `cloud/porter-us-west.yaml` |
| `cloud-stress` | Stress / debug cluster | `cloud/porter-stress.yaml` |

Other apps (rtmp relay, individual miniapps) have their own
`porter.yaml` files in their package folders.

## Access

You need a Porter account that has been added to the Mentra org.
Ask Isaiah or Israelov.

- Web dashboard: https://dashboard.porter.run/
- CLI: `brew install porter` (or download from
  https://docs.porter.run/getting-started/installation), then
  `porter login`.

Verify CLI access:

```bash
porter projects list
porter app list --cluster <CLUSTER_ID>
```

Cluster IDs are visible in the Porter dashboard URL when you open
a cluster, and at the bottom-right of pod-detail pages.

## Procedures

- [concepts.md](concepts.md): read first. Explains Kubernetes (nodes, pods,
  Deployments, Services, Ingress, probes), Porter, AKS, and
  the rolling-deploy flow.
- [deploys.md](deploys.md): how to ship a change to a Porter app
- [env-vars.md](env-vars.md): where environment variables live and how to
  change them
- [logs.md](logs.md): viewing logs from Porter vs. BetterStack

## Related

- [../cloudflare/](../cloudflare/): traffic flows Cloudflare -> nginx Ingress ->
  Porter pods. The Cloudflare runbook covers the edge layer.
- [../doppler/](../doppler/): Porter pulls secrets from Doppler via its
  native integration at deploy time and writes them into the
  pod's env. See [../doppler/porter-integration.md](../doppler/porter-integration.md) for how
  the integration is wired and how to verify it.
- [../betterstack/](../betterstack/): pod stdout is shipped to BetterStack via the
  Vector DaemonSet running in each cluster.
- `cloud/tools/bstack/runbooks/pod-crash.md` walks through what
  to do when a Porter pod is crashlooping.
