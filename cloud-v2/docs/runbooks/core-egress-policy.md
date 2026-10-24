# Core's egress network policy

Core is the only Cloud V2 service that fetches URLs a developer chose (a
miniapp's `miniapp.json`). Core's fetcher refuses private and internal
addresses itself. This policy makes the network refuse them too: Core's pods
may reach the public internet and the cluster's DNS, so a bug in the fetcher
still can't reach the instance metadata address, the Kubernetes API, another
node, another pod or anything else inside the VPC. The network can't close
everything; see [What it doesn't cover](#what-it-doesnt-cover).

- Manifest: [`deploy/kubernetes/core-egress-networkpolicy.yaml`](../../deploy/kubernetes/core-egress-networkpolicy.yaml),
  one `NetworkPolicy` per environment (`cloud-dev-core-egress`,
  `cloud-staging-core-egress`, `cloud-prod-core-egress`).
- Its test: `core-egress-networkpolicy.test.mjs` beside it, run by the Cloud V2
  CI job. It checks that every private range is denied on every port, that
  Core's public upstreams stay allowed, and that the three environments match.
- Probe: [`deploy/kubernetes/core-egress-probe.mjs`](../../deploy/kubernetes/core-egress-probe.mjs),
  run inside a Core pod to verify an apply.

Porter doesn't manage the policy. It is applied and removed with `kubectl`.

## The model

Porter runs every Cloud V2 environment on one EKS cluster (Porter cluster
5692, `aws-us-west-2`), in the `default` namespace. Each policy selects one
environment's Core pods by the labels Porter puts on them
(`porter.run/app-name: cloud-<env>`, `porter.run/service-name: core`). Runtime,
the Store, MFM and every other pod are not selected and keep their egress.

The cluster's VPC CNI enforces NetworkPolicy (the add-on runs with
`enableNetworkPolicy: "true"`, and the `aws-node` DaemonSet has the
`aws-eks-nodeagent` container, in `standard` mode). In standard mode a pod
that no policy selects can reach everything, and a pod that a policy selects
can reach only what the policy allows. A new pod has no restriction for the
few seconds before the agent attaches the policy.

The policy is egress only. Inbound traffic to Core (the ingress controller,
kubelet probes) is unchanged, and replies to inbound connections are allowed
by the agent's connection tracking.

### What it allows

| Rule | Destinations | Ports |
| --- | --- | --- |
| Cluster DNS | kube-dns in `kube-system` (CoreDNS and its Service), `172.21.0.10/32`, `169.254.20.10/32` | 53, UDP and TCP |
| Public internet | `0.0.0.0/0` and `::/0`, except the ranges below | all |

Denied, as exceptions to the public rule: `0.0.0.0/8`, `10.0.0.0/8`,
`100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (which holds the instance
metadata address `169.254.169.254` and EKS Pod Identity), `172.16.0.0/12`
(which holds the cluster's Service addresses, `172.21.0.0/16`),
`192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`,
`240.0.0.0/4`; for IPv6 `::1/128`, `::ffff:0:0/96`, `64:ff9b::/96`,
`fc00::/7`, `fe80::/10`, `ff00::/8`. The cluster is IPv4-only, so the agent
ignores the IPv6 rules today.

Pods resolve names through `172.21.0.10`, the kube-dns Service's address,
which node-local-dns answers on each node (it also listens on
`169.254.20.10`). The kube-dns selector already covers the Service's address;
the two `/32` blocks keep DNS working if that changes. If the cluster's
Service range ever changes, check `kubectl get svc kube-dns -n kube-system`
and update the `/32`.

### What it doesn't cover

- **The pod's own node.** The VPC CNI's agent always allows a pod to reach
  the primary IP of the node it runs on, on every port, whatever the policy
  says, so that kubelet probes work (Kubernetes leaves this to the network
  plugin). From a Core pod that node's kubelet (`:10250`, which requires
  authentication) and any host-network pod on that node stay reachable.
  Other nodes are denied. Only the fetcher's own checks guard the local node.
- **A pod's first seconds.** In standard mode a new Core pod is unrestricted
  until the agent attaches the policy, a few seconds after it starts. Strict
  mode would close this, but it denies every pod in the cluster that no policy
  selects, which is a cluster-wide change.
- **Other Core deployments.** Personal and debug Core apps in the cluster
  (`cloud-debug`, `cloud-isaiah`, and the legacy `cloud-v2` app) aren't
  selected. Copy a policy with the app name swapped, or retire the app.

### Core's egress

Inventoried from Core's configuration and code, and checked from a dev Core
pod on 2026-10-23. Everything Core calls is a public address. Nothing Core
calls is inside the cluster except DNS.

| Upstream | Setting or code | Reached at |
| --- | --- | --- |
| MongoDB Atlas | `MONGO_URL` (`mongodb+srv`) | Atlas public endpoints, port 27017. There is no VPC peering or PrivateLink to Atlas. |
| Mentra account (Supabase) | `SUPABASE_URL`, `CLOUD_CORE_SUPABASE_ISSUER` | Public, behind Cloudflare |
| File storage (R2) | `CLOUD_STORAGE_S3_ENDPOINT`, `CLOUD_CORE_STORAGE_S3_ENDPOINT` | Public. Static keys, so no instance metadata. |
| MFM (Fleet) | `CLOUD_CORE_FLEET_URL` | Its public hostname, through the cluster's public load balancer |
| Billing (the Store backend) | `CLOUD_CORE_BILLING_URL` | Its public hostname, through the cluster's public load balancer |
| Report agent | `CLOUD_REPORT_AGENT_URL` | Public |
| Slack | `CLOUD_REPORTS_SLACK_WEBHOOK_URL`, `CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL`, `CLOUD_MINIAPP_SLACK_WEBHOOK_URL` | Public |
| PostHog, Sentry | `POSTHOG_HOST`, `SENTRY_DSN` | Public |
| GitHub, Resend, npm, Microsoft Entra ID, the artifacts CDN | Fixed in Core's code | Public |
| Developers' miniapp URLs | Core's fetcher | Public only; the fetcher refuses the rest first |

Not Core's: Redis (ElastiCache, in a peered VPC) is used by Runtime only.
Logs leave through the Vector DaemonSet reading container output, not from
Core. The VPC's S3 gateway endpoint routes public S3 addresses and isn't
involved.

**If Core gains a private upstream** (Redis, Atlas over peering or
PrivateLink, a cluster-internal Service), add an explicit allow for it to the
manifest, with its port, and apply it **before** Core's configuration points
at it. Otherwise Core loses that upstream on the next connection.

## Access

Applying needs `kubectl` that can write NetworkPolicies in `default` on the
cluster. `porter kubectl` is read-only (it can read policies, not create
them). The cluster's EKS access entries say who can write; the admin SSO role
among them can:

```bash
aws eks list-access-entries --region us-west-2 --cluster-name aws-us-west-2
aws sso login                       # as a user of the cluster's admin SSO role
aws eks update-kubeconfig --region us-west-2 --name aws-us-west-2
kubectl auth can-i create networkpolicies -n default    # yes
```

Anyone else needs an EKS access entry first, for example
`AmazonEKSEditPolicy` scoped to the `default` namespace. That changes who can
modify the cluster that also runs prod, so the cluster owner approves it.

## Before applying

From `cloud-v2/`:

```bash
# The CNI enforces policies.
kubectl get ds aws-node -n kube-system \
  -o jsonpath='{.spec.template.spec.containers[*].name}'      # includes aws-eks-nodeagent
# DNS: pods use 172.21.0.10, the kube-dns Service.
kubectl get svc kube-dns -n kube-system -o jsonpath='{.spec.clusterIP}'
# The selector finds exactly that environment's Core pod(s).
kubectl get pods -n default -l porter.run/app-name=cloud-dev,porter.run/service-name=core
# No other policy selects Core. Policies add up: any policy that allows more
# (Porter's networkPolicy.blockIMDS allows 0.0.0.0/0) reopens the private ranges.
kubectl get networkpolicy -n default
# Validate the manifest against the cluster (read-only access is enough).
porter kubectl --cluster 5692 -- apply --dry-run=client --validate=strict \
  -f deploy/kubernetes/core-egress-networkpolicy.yaml -l mentra.glass/environment=dev
```

Run the probe (see Verify) once before applying, as a baseline: every
`allowed` line is `ok`, and every `denied` line is `FAIL ... open`. That
proves each denied target answers today, so a timeout after the apply is the
policy's doing.

## Apply

One environment at a time, in order: dev, then 24 hours of watching Core's
errors, then staging, then prod. Prod needs the cluster owner's go; apply it
off-peak. From `cloud-v2/`:

```bash
kubectl apply -f deploy/kubernetes/core-egress-networkpolicy.yaml -l mentra.glass/environment=dev
kubectl get policyendpoints.networking.k8s.aws -n default    # the agent's resolved copy of the policy
```

The `-l` label picks one environment's policy from the file. Applying doesn't
restart Core. A long-lived connection open at that moment may drop once and
reconnect.

## Verify

1. The probe, from the Core pod (swap `dev` for the environment). Its
   arguments are extra private `host:port` targets; pass the VPC's resolver
   (the VPC CIDR's base address plus 2, `10.76.0.2:53` here):

   ```bash
   kubectl exec -i -n default deploy/cloud-dev-core -c cloud-dev-core -- \
     sh -c 'cat > /tmp/core-egress-probe.mjs && bun /tmp/core-egress-probe.mjs 10.76.0.2:53' \
     < deploy/kubernetes/core-egress-probe.mjs
   ```

   It connects to every upstream in that pod's configuration (Mongo's SRV
   hosts, the Mentra account, storage, and Fleet, billing, PostHog, Sentry,
   the report agent and Slack where set), to the fixed upstreams in Core's
   code, and to the denied targets: the instance metadata address, the VPC's
   link-local resolver (`169.254.169.253:53`), the Kubernetes API and the
   arguments. Every line must start with `ok` or `skip`: upstreams `open`,
   denied targets `timeout`. A refused connection on a denied target fails,
   because a reply means the packet wasn't dropped. A setting Core requires
   that is missing fails too, so the probe can't pass outside a Core pod. It
   prints setting names and hosts, never values. Don't test the pod's own
   node: the agent always allows it (see What it doesn't cover).
   Without cluster kubectl, Porter can run it in the pod (pick the core pod at
   the prompt):

   ```bash
   porter app run cloud-dev --cluster 5692 -e -c cloud-dev-core -- sh -c \
     "echo $(gzip -9c < deploy/kubernetes/core-egress-probe.mjs | base64 | tr -d '\n') | base64 -d | gunzip > /tmp/core-egress-probe.mjs && bun /tmp/core-egress-probe.mjs 10.76.0.2:53"
   ```
2. Core is healthy: `curl https://<core host>/ready` answers 200 (Atlas).
3. Sign-in: sign in to that environment's admin portal (the Mentra account).
4. Fleet forwarding: open Fleet in the workspace portal (Core to MFM).
5. Billing: open the workspace's Licenses page (Core to the Store backend).
6. For 24 hours, Core's errors in BetterStack (the environment's
   `MentraCloud V2` source): no new `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`,
   `fleet_unavailable` or failed Atlas connections.

## Roll back

```bash
kubectl delete networkpolicy cloud-dev-core-egress -n default
```

Egress is unrestricted again at once; nothing restarts. Core's fetcher keeps
refusing private addresses on its own. Record the rollback and why below.

## Private Cloud

The Private Cloud recipe runs Core on Azure Container Apps without a VNet,
which can't restrict egress. There, the fetcher's own checks are the only
guard.

## Record

| Date | Environment | Change | By | Result |
| --- | --- | --- | --- | --- |
| 2026-10-23 | dev | Baseline probe, before any apply | Cloud V2 | Every upstream open; instance metadata, the link-local resolver, the Kubernetes API and the VPC resolver all answer. Not applied: needs cluster write access (see Access). |
