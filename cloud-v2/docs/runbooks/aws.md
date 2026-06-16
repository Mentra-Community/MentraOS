# AWS resources

What we own in AWS for cloud-v2, what's managed by Porter, what's managed
outside Porter, and where to find each.

## Account

Single AWS account (same as v1). Porter integrates with it for image
registry, EKS, and load balancer provisioning.

Get console access from the cluster owner. Or set up CLI access:

```bash
brew install awscli
aws configure                                # access key + region us-west-2
aws sts get-caller-identity                  # verify
```

## Regions

| Region | Used for | Cluster ID |
| --- | --- | --- |
| `us-west-2` | dev (currently), prod (planned, primary for west-coast users) | aws-us-west-2 (Porter ID 5692) |
| `us-east-2` | future east-coast prod | aws-us-west-2 (Porter ID 5690) — currently empty |

The user's office is in SF → us-west-2 is closest. v1's primary cluster
was Azure central-us; cloud-v2 reorients around AWS us-west-2.

## EKS (managed Kubernetes)

Two EKS clusters exist (one per region). Porter provisioned and manages
them; we rarely touch the cluster directly.

For raw `kubectl` access (needed for things Porter doesn't manage — UDP
NLB Service, ConfigMaps for cluster-wide controllers, etc.):

```bash
aws eks update-kubeconfig --region us-west-2 --name <cluster-name>
# cluster-name is something like porter-<id>-cluster
```

`porter kubectl` is **read-only** by design — its service account can
list pods/services/ingresses but not mutate them. For applies, use your
own kubectl.

## ECR (image registry)

Porter pushes our Docker images here per `porter apply`:

```
042724764545.dkr.ecr.us-west-2.amazonaws.com/cloud-v2-<commit-sha>
```

You don't normally interact with ECR directly. If you ever need to:

```bash
aws ecr get-login-password --region us-west-2 | \
  docker login --username AWS --password-stdin 042724764545.dkr.ecr.us-west-2.amazonaws.com

aws ecr list-images --repository-name cloud-v2 --region us-west-2
```

## ElastiCache (Redis)

| Name | Region | Type | Purpose |
| --- | --- | --- | --- |
| `cloud-elasticache-us-west-2` | us-west-2 | `cache.t4g.medium`, Redis 7.1 | Audio streams, ownership claims, sessionTag registry |

**Cluster-only access** — TLS + auth token required, only pods inside the
EKS cluster can connect. From a local dev machine you can't reach it;
use `docker compose` locally (`bun run setup:test`).

Connection string is in Doppler `dev_aws` config as `REDIS_URL`.

For a temporary tunnel to debug from your laptop:

```bash
porter datastore connect cloud-elasticache-us-west-2
# Opens local port forwarding; stays open while the command runs.
```

For prod we may add a separate ElastiCache cluster per region. The dev
cluster is sized for development load; prod sizing TBD based on traffic.

## NLB (Network Load Balancer)

We provision NLBs manually via a `Service type=LoadBalancer` manifest
in `deploy/audio-udp-nlb.yaml` — Porter doesn't create NLBs for `additionalPorts`
in `porter.yaml`. See [`deploy/udp-nlb-aws.md`](./deploy/udp-nlb-aws.md).

When applied, you'll see a new NLB in AWS Console → EC2 → Load Balancers.
Name pattern: `<random>.elb.us-west-2.amazonaws.com`. Custom domain via
Cloudflare CNAME points at this.

## ALB (Application Load Balancer)

Porter provisions an ALB per cluster automatically (shared across all
Porter apps in that cluster). Each Porter app's `web` service gets an
Ingress backed by this ALB.

Look like: `k8s-ingressn-ingressn-<id>.elb.us-west-2.amazonaws.com`

You don't manage this. Just know that all HTTPS traffic to
`*.onporter.run` and any custom domains we add for web services flows
through this single ALB.

## Mongo Atlas (NOT in AWS)

Hosted by MongoDB themselves (separate from our AWS account). The cluster
that cloud-v2 uses connects via `mongodb+srv://...` URL stored in Doppler
`dev_aws` as `MONGO_URL`.

For prod we'll have a separate Atlas cluster (separate billing, separate
backup schedule). v1 already has its own Atlas cluster — don't share with
v1; schemas differ.

Atlas peering with our AWS VPC: TBD when we move from dev to prod.

## VPC + networking

Standard EKS VPC layout, set up by Porter when the cluster was created:

- 2 public subnets (one per AZ), for the ALB/NLB ENIs
- 2 private subnets (one per AZ), for nodes + pods
- NAT gateways for egress (outbound to Soniox, BetterStack, Atlas)

You don't normally touch this. Two things to know:

1. **Egress from pods has a fixed set of IPs** (the NAT gateways'). For
   third-party services that allowlist IPs (Atlas, Soniox if needed),
   ask the cluster owner for the NAT IPs.
2. **NLBs live in the public subnets**. The cross-zone annotation on
   the audio UDP NLB ensures both AZs route to pods regardless of where
   the pod lives.

## IAM

Two service roles matter to cloud-v2:

1. **AWS Load Balancer Controller** — runs as a pod in `kube-system`, has
   IAM permissions to create/modify NLBs and ALBs. If NLB provisioning
   fails with `AccessDenied`, this role needs a policy update.
2. **EKS node role** — what our pods inherit. Can pull from ECR (so
   ImagePullSecrets aren't needed). For pods that need other AWS
   permissions (e.g., S3), we'd attach IRSA (IAM roles for service
   accounts).

Currently no cloud-v2 pod needs AWS API access. Mongo/Soniox/BetterStack
use their own credentials (not AWS IAM).

## Things we don't use (yet)

- **S3** — could store audio recordings or static assets later; not needed
  for the audio pipeline (everything is real-time, nothing is persisted).
- **RDS / Aurora** — Atlas covers our Mongo needs.
- **CloudWatch logs** — pod logs go to BetterStack via Vector DaemonSet,
  not CloudWatch.
- **Route 53** — DNS lives in Cloudflare (see [`cloudflare/dns-for-nlb.md`](./cloudflare/dns-for-nlb.md)).

## Cost shape (rough)

For dev-cluster scale:

| Resource | ~/month |
| --- | --- |
| EKS control plane | $73 |
| 2x m5.large nodes | $140 |
| ElastiCache `cache.t4g.medium` | $40 |
| ALB | $22 + LCUs |
| NLB (when applied) | $16 + NLCUs |
| ECR storage | <$1 |
| Cross-zone data transfer | <$5 at dev volumes |

Soniox is the big spend at any real user scale — $0.012/min × concurrent
minutes. Not AWS, but worth knowing the cost shape.
