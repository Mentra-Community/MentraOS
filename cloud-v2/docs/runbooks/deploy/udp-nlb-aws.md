# UDP audio ingress via AWS NLB

Cloud-v2 receives audio from phones over UDP port 8000. This doc covers how
that UDP traffic reaches our EKS cluster on AWS.

## The problem

Porter's standard ingress is an **ALB** (Application Load Balancer, layer-7).
ALB only speaks HTTP/HTTPS — no UDP. Porter's `additionalPorts:` in
`porter.yaml` exposes the port on the container but does NOT create a
public-facing Service to receive UDP from the internet.

So we need a separate, manually-managed **NLB** (Network Load Balancer,
layer-4) sitting in front of audio pods.

This mirrors v1's approach on Azure, where we created `udp-service.yaml`
manually outside Porter. AWS's equivalent uses the AWS Load Balancer
Controller (installed in the cluster) which provisions an NLB when it sees
a `Service` of `type: LoadBalancer` with the right annotations.

## Why NLB, not ALB

| | ALB | NLB |
| --- | --- | --- |
| Protocol | HTTP/HTTPS only | TCP, UDP, TLS |
| Latency | Higher (L7 inspection) | Lower (L4 pass-through) |
| Use case | Web traffic, REST APIs, WS | Audio, gaming, low-latency |
| TLS termination | At LB | At pod (NLB pass-through) |
| Cost | ~$22/mo + LCU | ~$16/mo + NLCU |

Our audio path needs **NLB** (UDP, low latency). Our HTTP/WS path stays on
the **ALB** (Porter manages it; it's the `*.onporter.run` hostname).

## What's deployed (verified 2026-07-09)

Per-environment state:

| Env | NLB Service | UDP path |
| --- | --- | --- |
| `cloud-isaiah` | `cloud-isaiah-audio-udp` (applied 2026-07-09) | WORKING: probe packets from the internet reach the pod; `AUDIO_UDP_ADVERTISED_HOST` is the raw NLB hostname |
| `cloud-dev` / `cloud-debug` / `cloud-staging` / `cloud-prod` | none applied | WS fallback only; Doppler advertises `audio-udp.<env>` names that have no DNS record |
| (legacy) | `cloud-v2-audio-udp` still exists in-cluster | DEAD: selects the retired `cloud-v2` app, zero endpoints, still billing ~$16/mo; candidate for `kubectl delete svc cloud-v2-audio-udp` |

- The apps are now per-environment (`cloud-dev`, `cloud-debug`,
  `cloud-staging`, `cloud-prod`, plus personal envs like `cloud-isaiah`),
  each with a `runtime` service. An NLB Service is also per-environment: its
  selector pins one app's runtime pods, so one NLB cannot serve two envs.
- [`deploy/audio-udp-nlb-debug.yaml`](../../../deploy/audio-udp-nlb-debug.yaml)
  is the per-env template (targets `cloud-debug`). Clone it and swap the
  app name in `metadata` and `selector` for a new env
  (`cloud-<env>-audio-udp`).
- [`deploy/audio-udp-nlb.yaml`](../../../deploy/audio-udp-nlb.yaml) is the
  LEGACY manifest from before the per-env split: it selects
  `porter.run/app-name: cloud-v2`, an app name that no longer deploys.
  Kept for reference; do not apply it.
- The Doppler configs advertise per-env hostnames (for example `dev_debug`
  sets `AUDIO_UDP_ADVERTISED_HOST=audio-udp.debug.us-west-2.mentraglass.com`),
  but as of 2026-07-09 those names have NO Cloudflare record and do not
  resolve. Clients try UDP, fail, and fall back to WS. If you provision an
  NLB, fix the advertised host in the same change or the new NLB is unused.

The intended shape, once an env's NLB exists:

```
internet
  │
  ▼
audio-udp.<env>.us-west-2.mentraglass.com   ← Cloudflare DNS-only (optional for dev-grade envs)
  │
  ▼
<nlb-hostname>.elb.us-west-2.amazonaws.com  ← AWS NLB (UDP :8000)
  │
  ▼ (cross-zone load balancing on)
EKS nodes
  │
  ▼ (k8s Service routes to pods by selector)
cloud-<env> runtime pods (Porter-managed)
  │
  ▼
container :8000/udp → Bun.udpSocket → parse → Redis Stream
```

## The manifest, annotated

```yaml
apiVersion: v1
kind: Service
metadata:
  name: cloud-<env>-audio-udp               # per-env: cloud-debug-audio-udp, ...
  namespace: default
  labels:
    porter.run/app-name: cloud-<env>        # match Porter's app labeling
    app.kubernetes.io/managed-by: kubectl   # NOT Porter — kubectl-applied
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
spec:
  type: LoadBalancer
  selector:
    porter.run/app-name: cloud-<env>
    porter.run/service-name: runtime        # runtime pods ONLY (NOT core)
  ports:
    - name: udp-audio
      protocol: UDP
      port: 8000
      targetPort: 8000
  externalTrafficPolicy: Local              # REQUIRED for UDP (see Gotchas)
```

Annotation breakdown:

- **`aws-load-balancer-type: nlb`** — without this, AWS LB Controller would
  try to provision a Classic ELB (deprecated; doesn't support UDP well).
- **`aws-load-balancer-scheme: internet-facing`** — public hostname. Use
  `internal` for private-only NLB (e.g., between clusters in a VPC).
- **`cross-zone-load-balancing-enabled: true`** — without this, an NLB
  zone with no healthy targets routes packets through other zones with
  extra hop latency. Costs a bit more in cross-AZ data transfer; eliminates
  AZ-skew failure modes. We're on a 2-AZ subnet; turning this off would
  matter more at higher scale.

Selector breakdown:

- Porter labels pods with `porter.run/app-name=<app>` +
  `porter.run/service-name=<service>`. We want one env's runtime pods only.
- Verify the labels match real pods with:
  ```bash
  kubectl get pods -l porter.run/app-name=cloud-<env>,porter.run/service-name=runtime --show-labels
  ```

## How to provision a new NLB (per environment)

> ⚠️ **Porter's `kubectl` is read-only** — it can't create Services. You need
> direct kubectl access to the cluster via AWS CLI. See "Getting kubectl
> write access" below. (The auth is SSO-backed on our setup: if kubectl
> errors with "Token has expired and refresh failed", run `aws sso login`
> first.)

```bash
# 1. Make the env's manifest: clone deploy/audio-udp-nlb-debug.yaml and
#    replace cloud-debug with cloud-<env> in metadata.name, metadata.labels,
#    and spec.selector. Keep externalTrafficPolicy: Local (see Gotchas).

# 2. Get kubectl write access via AWS CLI (one-time setup, see section below).
aws eks update-kubeconfig --region us-west-2 --name aws-us-west-2

# 3. Apply the manifest with your own kubectl (NOT `porter kubectl`).
kubectl apply -f deploy/audio-udp-nlb-<env>.yaml

# 4. Wait ~2-4 min for AWS to provision the NLB. Get the hostname:
kubectl get svc cloud-<env>-audio-udp \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
# → something like: a1b2c3d4...elb.us-west-2.amazonaws.com

# 5. Plug it into the ENV'S OWN Doppler config so the runtime's
#    CONNECTION_ACK advertises the right host. For dev-grade envs the raw
#    NLB hostname is fine (skip the Cloudflare CNAME); for staging/prod add
#    a DNS-only CNAME first and advertise the friendly name (see DNS below).
doppler secrets set "AUDIO_UDP_ADVERTISED_HOST=<nlb-hostname>" \
  --project cloud-v2 --config dev_<env>

# 6. The Doppler→Porter integration auto-syncs the env group in ~5s, but
#    pods do not restart on env changes. Redeploy the env:
#    trigger its GitHub workflow (cloud-v2-<env>.yml) or
#    `porter apply -f porter.<env>.yaml` from cloud-v2/.

# 7. Verify UDP reachability from outside the cluster (UDP packet → NLB → pod).
#    The test-client's smoke script is the easiest way. If packets vanish,
#    check target-group health first (see Gotchas).
```

## Getting kubectl write access

`porter kubectl` uses a service account with read-only RBAC — by design, so
the Porter UI can show pods/services without risk of accidentally mutating
state. For applying resources (Services, ConfigMaps, etc.) you need direct
EKS access via AWS CLI.

```bash
# 1. Install AWS CLI if you don't have it.
brew install awscli

# 2. Configure AWS credentials. You need an IAM user/role with EKS access.
#    Ask the cluster owner for credentials or generate via Porter's
#    Settings → Cloud Provider Credentials → "Get kubeconfig" flow.
aws configure
# Enter: Access Key ID, Secret Access Key, region=us-west-2, output=json

# 3. Find the cluster name.
aws eks list-clusters --region us-west-2

# 4. Update your kubeconfig.
aws eks update-kubeconfig --region us-west-2 --name <cluster-name>

# 5. Verify access.
kubectl get nodes
kubectl auth can-i create svc
# → "yes" if your IAM role has the right RBAC mapping
```

**Alternative**: Porter dashboard → Settings → Cluster → "Raw Manifests"
(if your project has that feature). Paste the YAML, apply through the UI.

## DNS

For prod we map a friendly hostname (e.g. `audio-udp-us-west-2.mentra.glass`)
to the NLB. Two options:

1. **Cloudflare CNAME, DNS-only mode** — orange-cloud OFF. Cloudflare doesn't
   proxy UDP, so the proxy can't help here. DNS-only just resolves the name
   to the NLB hostname. This matches v1's approach.
2. **Route 53 alias** — AWS's own DNS, alias record points at the NLB.
   Slightly faster resolution from AWS clients; otherwise equivalent. v1
   was on Cloudflare so we stick with Cloudflare for consistency.

For dev cluster we can skip DNS and use the raw NLB hostname directly in
`AUDIO_UDP_ADVERTISED_HOST` — the test-client doesn't care about pretty names.

## Gotchas

### Selector mismatch → 0 healthy targets

If the selector labels don't exactly match what Porter puts on the runtime
pods, the NLB has no targets and packets get dropped. Check:

```bash
kubectl describe svc cloud-<env>-audio-udp | grep -E "Selector|Endpoints"
```

`Endpoints` should list the runtime pod IPs. If it's empty, the selector is
wrong. Compare the labels you used against what Porter actually attaches:

```bash
kubectl get pods -l porter.run/app-name=cloud-<env> --show-labels
```

(In v1 the porter.run labels were stable; in cloud-v2 we use the same
ones — see the v1 reference manifest at `cloud/udp-service.yaml`.)

### NLB hostname is unstable on re-create

If you `kubectl delete svc cloud-<env>-audio-udp` and re-apply, AWS gives you
a NEW hostname. The old one is gone. Anything that hardcoded the old
hostname (DNS records, Doppler `AUDIO_UDP_ADVERTISED_HOST`) breaks.

Mitigation:
- Don't delete unless necessary
- If you have to, update `AUDIO_UDP_ADVERTISED_HOST` immediately afterward
- For prod, set up Route 53 / Cloudflare CNAME pointing at the NLB so the
  hostname clients see (`audio-udp.mentra.glass`) is stable across NLB
  recreations — just update the CNAME on the rare delete.

### NLB takes 2-4 minutes to provision

Right after `kubectl apply`, the Service exists but its `EXTERNAL-IP` is
`<pending>` for a few minutes while AWS spins up the NLB. The hostname
becomes available once provisioning completes:

```bash
# poll until hostname appears
while ! kubectl get svc cloud-<env>-audio-udp \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null | \
    grep -q elb; do
  echo "waiting..."
  sleep 30
done
```

### "Could not create LB" errors usually mean missing IAM

The AWS Load Balancer Controller needs IAM permissions to create NLBs.
If errors mention `AccessDenied` or `UnauthorizedOperation`, the
controller's service-account role is missing
`elasticloadbalancing:CreateLoadBalancer` (and friends). Fix in the EKS
cluster's IAM policy — not Porter's problem.

```bash
kubectl describe svc cloud-<env>-audio-udp | grep -E "Warning|Event"
```

### Cross-zone load balancing turn-OFF causes uneven routing

If you disable cross-zone in the annotation, an NLB in 2 AZs but pods
only in 1 AZ will silently drop ~50% of packets (the AZ without pods
routes nowhere). Leave cross-zone ON unless you've thought hard about it.

### `externalTrafficPolicy: Local` is REQUIRED for UDP NLB health checks

NLBs run **TCP health checks** even when serving UDP traffic. The default
behavior is to TCP-connect to the same port as the listener — but UDP
listeners don't accept TCP. Result: target group health checks all
return `Target.FailedHealthChecks`, NLB has zero healthy targets, every
UDP packet gets blackholed silently.

The clean fix is `externalTrafficPolicy: Local`. Two things happen:

1. k8s allocates a stable `healthCheckNodePort` (TCP, separate from the
   UDP traffic port). AWS LB Controller picks it up and points the
   target group's health check at that.
2. Traffic only routes to nodes hosting actual pods (real source IP
   preserved as a bonus).

Without `Local`, you'd need annotations to override the health check
port/protocol, which gets messy with auto-allocated NodePorts. `Local`
is simpler.

**Symptom you'll see if you forget**: NLB is provisioned, gets a
hostname, DNS resolves, but UDP packets you send don't appear in the
audio pod logs. Check the target group:

```bash
aws elbv2 describe-target-health \
  --region us-west-2 \
  --target-group-arn <tg-arn> \
  --query 'TargetHealthDescriptions[*].TargetHealth.State'
```

If all `unhealthy` with reason `Target.FailedHealthChecks`, it's this.
Apply `externalTrafficPolicy: Local` and within ~30s health checks pass.

## Cost

- NLB itself: ~$16/month per region per NLB.
- NLCUs (load balancer capacity units): roughly $0.006/hr per NLCU. For
  audio traffic at our scale (KB/s per user, thousands of users) we'd be
  under 1 NLCU per NLB → bundled in the base price.
- Cross-zone data transfer: ~$0.01/GB. At ~1 KB/s per user × 30 days =
  ~2.5 GB/user/month. Cross-zone is half that worst case → ~$0.01/user/mo.

Negligible compared to Soniox.

## Reference: v1's Azure equivalent

[`cloud/udp-service.yaml`](../../../../cloud/udp-service.yaml) is v1's
Azure version. Same shape; the only differences:

- No NLB-specific annotations (Azure's basic LoadBalancer Service works fine)
- Selector uses the same `porter.run/app-name` + `porter.run/service-name` pattern
- Applied via GitHub Actions instead of manually

We could follow the same pattern (CI applies the manifest after deploy) but
it's a single artifact that rarely changes, so manual apply is fine for now.
