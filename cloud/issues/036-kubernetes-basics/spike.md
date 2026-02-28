# Spike: Kubernetes Basics — How Our Cloud Infrastructure Works

## Overview

**What this doc covers:** The Kubernetes concepts you need to understand to work on Mentra's cloud infrastructure — from "what is a cluster" all the way up to Ingress routing rules and how Porter fits in. Written for someone who has never touched Kubernetes.

**Why this doc exists:** The WS ingress timeout fix (035) required creating a standalone Kubernetes resource outside of Porter's management. Without understanding what Kubernetes objects are and how they relate, it's unclear why that fix works, why Porter won't overwrite it, and what could go wrong. More generally, if you deploy cloud changes or debug production issues, you need a mental model of what's underneath.

**Who should read this:** Anyone on the team. No Kubernetes knowledge assumed.

---

## Starting From Scratch

### What problem does Kubernetes solve?

Without Kubernetes, deploying a server means: rent a machine, SSH into it, install your dependencies, copy your code, run it. If it crashes, you SSH back in and restart it. If you need more capacity, you rent another machine and set everything up again. If you want zero-downtime deploys, you figure out load balancing yourself.

Kubernetes automates all of that. You tell it "I want 1 copy of my server running at all times" and it handles: which machine to run it on, restarting it if it crashes, routing traffic to it, rolling out new versions without downtime, and scaling up if needed.

The tradeoff: Kubernetes is complex. It introduces a dozen new concepts between "my code" and "a user's request reaches my code." This doc walks through each one.

---

## Layer 0: Cloud Provider

Before Kubernetes, there's a cloud provider — the company that owns the physical hardware. We use **Microsoft Azure**. Azure runs data centers around the world. We pay Azure for virtual machines (VMs) in specific regions.

You never interact with Azure directly. Porter handles that.

## Layer 1: Clusters

A **cluster** is a group of machines that Kubernetes manages as one unit. Think of it as "one deployment of Kubernetes." Everything inside a cluster can talk to everything else. Things in different clusters are completely isolated — they don't know about each other.

**Our clusters:**

| Cluster           | Cloud Provider | Region     | What runs there                     |
| ----------------- | -------------- | ---------- | ----------------------------------- |
| us-central (4689) | Azure          | Central US | debug, dev, staging, prod, all TPAs |
| east-asia (4754)  | Azure          | East Asia  | prod (regional replica)             |
| france (4696)     | Azure          | France     | prod (regional replica)             |

Porter created these clusters for us. Each cluster is a separate Kubernetes installation on a separate set of machines in a different part of the world. The prod deploy workflow pushes to all three:

```
porter-prod.yml:
  us-central:  PORTER_CLUSTER: "4689"
  east-asia:   PORTER_CLUSTER: "4754"
  france:      PORTER_CLUSTER: "4696"
```

When you run `porter kubectl -- get pods`, you're talking to one specific cluster (us-central by default). The other clusters have their own pods, services, and ingresses that you'd need to switch context to see.

**Why multiple clusters?** Latency. A user in Tokyo connecting to a server in Iowa has ~150ms round-trip. A server in East Asia cuts that to ~30ms. For real-time glasses streaming, that matters.

## Layer 2: Nodes

A **node** is a single machine (VM) inside a cluster. It has a CPU, RAM, and a disk — like a computer. Kubernetes schedules pods onto nodes based on available resources.

**Our us-central cluster has 43 nodes:**

```
31 nodes:  4 CPU,   8 GB RAM   (general workloads)
 2 nodes:  2 CPU,   8 GB RAM   (memory-optimized)
 5 nodes:  8 CPU,  16 GB RAM   (heavy workloads — our cloud pods run here)
 3 nodes:  2 CPU,   4 GB RAM   (system/lightweight)
 2 nodes:  2 CPU,   4 GB RAM   (small)
```

All spread across 3 availability zones (centralus-1, centralus-2, centralus-3) — different physical buildings in the same region, so if one building loses power, the others keep running.

**You almost never think about nodes.** Kubernetes decides which node to put your pod on. You say "I need 5 CPU cores and 4 GB RAM" (in porter.yaml) and Kubernetes finds a node with enough room. If a node dies, Kubernetes moves your pods to other nodes automatically.

The only time nodes matter is capacity planning: if all nodes are full, new pods can't be scheduled and sit in "Pending" state until Porter/Azure adds more nodes.

**Our cloud pods and the nodes they're on right now:**

```
cloud-debug-cloud     → aks-u4689eanqib-...-vmss000072  (8 CPU, 16GB, zone 1)
cloud-dev-cloud       → aks-u4689eanqib-...-vmss000074  (8 CPU, 16GB, zone 1)
cloud-staging-cloud   → aks-u4689eanqib-...-vmss000075  (8 CPU, 16GB, zone 3)
cloud-prod-cloud      → aks-u4689eanqib-...-vmss00006y  (8 CPU, 16GB, zone 3)
```

All running on the 8-CPU nodes (makes sense — porter.yaml requests 5 CPU cores).

---

## Layer 3: The Kubernetes Resources

Now we're inside a cluster. Kubernetes manages everything as **resources** — objects stored in the cluster's database. You create a resource (a YAML file describing what you want), Kubernetes reads it, and continuously makes reality match your description. If a pod crashes, Kubernetes sees "desired: 1 pod, actual: 0 pods" and creates a new one.

Here are the resources that matter for us, bottom-up:

### Pods — The Actual Running Process

A Pod is a running instance of your code. It's the closest thing to "a server." One pod = one container = one process group.

**Our pods:**

```
cloud-debug-cloud-6fd6cdb7f8-p98w2       Running
cloud-dev-cloud-6d848dfc7f-27qgx         Running
cloud-staging-cloud-65ff67f6bb-bn8mt      Running
cloud-prod-cloud-fc78c8447-998jq          Running
```

Each pod runs the Docker container built from `cloud/docker/Dockerfile.livekit`. Inside: `start.sh` launches the Bun server (port 80) and the Go bridge (gRPC over Unix socket). The pod IS the cloud server.

**Key things about pods:**

- **Ephemeral.** Kubernetes can kill and recreate them at any time — deploys, crashes, node maintenance, scaling. Your code must handle this. No local state that can't be rebuilt.
- **Random names.** The suffix (`6fd6cdb7f8-p98w2`) changes every time. You never hardcode a pod name in config.
- **When a pod dies, all connections through it die.** Every WebSocket, every TCP connection — gone. This is why we saw 4 users disconnect at the exact same second during the nginx controller pod restart in the 035 spike.

You don't create pods directly. You create a **Deployment**, which creates pods for you.

### Deployments — "Keep N Copies Running"

A Deployment says "I want N replicas of this pod running at all times." For us, N = 1 per environment. If the pod crashes, the Deployment creates a new one. If you push a new Docker image, the Deployment does a rolling update: starts a new pod with the new image, waits for it to be healthy, then kills the old one.

You don't interact with Deployments directly either — Porter manages them. But it helps to know they exist because `kubectl` output references them:

```
cloud-debug-cloud-6fd6cdb7f8-p98w2
│                 │           │
│                 │           └── random pod ID
│                 └── Deployment revision hash
└── Deployment name
```

### Services — The Stable Name

Pods come and go. Their IP addresses change every time. A **Service** gives a stable name and IP that always points to whatever pod(s) are currently running.

**Our services:**

```
NAME                  TYPE            CLUSTER-IP      PORT
cloud-debug-cloud     NodePort        10.0.19.175     80
cloud-debug-udp       LoadBalancer    10.0.142.173    8000
cloud-prod-cloud      NodePort        10.0.114.107    80
cloud-prod-udp        LoadBalancer    10.0.123.18     8000
```

`cloud-debug-cloud` always resolves to `10.0.19.175:80`. Behind that IP, Kubernetes routes to whatever pod is currently running debug. Deploy a new version, old pod dies, new pod starts — the Service IP stays the same. Nothing else needs to change.

**Two types we use:**

| Type             | What it does                                                  | Created by                  | Used for                                       |
| ---------------- | ------------------------------------------------------------- | --------------------------- | ---------------------------------------------- |
| **NodePort**     | Exposes the service inside the cluster. nginx connects to it. | Porter (automatic)          | HTTP/WS traffic (port 80)                      |
| **LoadBalancer** | Gets a real public IP from Azure. Bypasses nginx entirely.    | Us (manual `kubectl apply`) | UDP audio (port 8000) — nginx can't handle UDP |

Porter creates the NodePort service automatically. The LoadBalancer service for UDP is **not** created by Porter — Porter's `additionalPorts` config doesn't actually create UDP LoadBalancer services (see [udp-loadbalancer spec](../udp-loadbalancer/udp-loadbalancer-spec.md)). We create and manage the UDP LoadBalancer services ourselves via `kubectl apply`, the same way we create the WS ingress.

This is why the audio path is different from WebSocket:

```
WebSocket:  Internet → Cloudflare → nginx → Service (NodePort) → Pod :80
UDP Audio:  Internet →                       LoadBalancer IP    → Pod :8000
```

UDP skips Cloudflare and nginx entirely. That's why the nginx timeout bug only affected WebSocket, not audio.

### nginx — The Reverse Proxy

Before we get to Ingress, we need to understand what nginx is and why it exists.

**The problem:** Your cluster has many Services — `cloud-debug-cloud`, `cloud-prod-cloud`, `cloud-staging-cloud`, etc. They're all internal. Nothing on the internet can reach them. You need something sitting at the edge of the cluster that:

1. Holds a public IP address
2. Receives all incoming HTTP/HTTPS traffic
3. Looks at the request (which domain? which path?) and forwards it to the right internal Service

That "something" is **nginx**. nginx is a web server / reverse proxy — a program that receives requests and forwards them somewhere else. It's not a Kubernetes concept. It's a regular open-source program (like Apache, Caddy, HAProxy) that happens to be the most popular choice for this job.

In our cluster, nginx runs as a pod (just like our cloud pods):

```
Namespace: ingress-nginx
Pod: ingress-nginx-controller-64b464ff46-xxxxx
```

This pod holds the public IP that all HTTP traffic to our cluster hits. Every request to `debug.augmentos.cloud`, `api.mentra.glass`, `stagingapi.mentraglass.com` — all of it goes to this one nginx pod first. nginx then decides where to forward it based on the domain and path.

```
Internet
    │
    ▼
nginx pod (public IP: 128.203.164.18)
    ├── debug.augmentos.cloud  → cloud-debug-cloud service → debug pod
    ├── api.mentra.glass       → cloud-prod-cloud service  → prod pod
    ├── stagingapi.mentraglass.com → cloud-staging-cloud    → staging pod
    └── ... etc
```

**nginx is the single entry point for all HTTP traffic.** Without it, every Service would need its own public IP and its own TLS certificate setup. nginx consolidates everything into one front door.

### Ingress — The Config That Tells nginx What To Do

So nginx needs to know: "when a request comes in for `debug.augmentos.cloud/glasses-ws`, forward it to `cloud-debug-cloud` on port 80, and use a 3600 second timeout."

How does nginx know this? It reads **Ingress** resources.

An **Ingress** is a Kubernetes resource — just a YAML object stored in the cluster's database. It contains routing rules: "this domain + this path → that Service." It does NOT handle traffic itself. It's pure configuration. nginx is the thing that reads the config and acts on it.

Think of it like this:

```
Ingress resource                 nginx
────────────────                 ─────
A config file                    The program that reads the config file

Like a .env file                 Like the app that reads .env

You write:                       nginx watches for Ingress resources,
  "route /glasses-ws             regenerates its nginx.conf,
   to cloud-debug-cloud          and starts routing traffic accordingly.
   with 3600s timeout"
```

When you create, update, or delete an Ingress resource, the nginx pod detects the change (within seconds), regenerates its internal `nginx.conf`, and reloads. No restart needed.

**Our Ingress resources (us-central cluster):**

```
NAME                      HOSTS                                          PATHS
cloud-debug-cloud         debug.augmentos.cloud, debugapi.mentra.glass   / (everything)
cloud-debug-cloud-ws      debug.augmentos.cloud, debugapi.mentra.glass   /glasses-ws, /app-ws
cloud-dev-cloud           dev.augmentos.cloud, devapi.mentra.glass       / (everything)
cloud-staging-cloud       stagingapi.mentraglass.com                     / (everything)
cloud-prod-cloud          api.mentra.glass, global.augmentos.cloud, ...  / (everything)
```

Notice **two** Ingress resources for debug: the main one (Porter-created) and the WS-specific one (we created manually). Both point to the same Service. The difference is their **annotations** — metadata that configures nginx's behavior for those routes.

**Multiple Ingress resources = one merged nginx config.** nginx reads ALL Ingress resources in the cluster and combines them into one `nginx.conf`. Internally it becomes something like:

```
# Generated from cloud-debug-cloud-ws Ingress:
location /glasses-ws {
    proxy_pass http://cloud-debug-cloud;
    proxy_send_timeout 3600s;
    proxy_read_timeout 3600s;
}

# Generated from cloud-debug-cloud Ingress:
location / {
    proxy_pass http://cloud-debug-cloud;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
}
```

When a request arrives, nginx picks the **most specific path match**:

```
Request: debug.augmentos.cloud/glasses-ws
  → matches cloud-debug-cloud-ws: /glasses-ws  ← WINS (more specific)
  → matches cloud-debug-cloud:    /            ← loses
  → uses 3600s timeouts ✅

Request: debug.augmentos.cloud/api/health
  → no match in cloud-debug-cloud-ws
  → matches cloud-debug-cloud:    /            ← only match
  → uses 60s timeouts ✅
```

**Annotations — how you configure nginx behavior per-Ingress:**

The routing rules (domain + path → Service) come from the Ingress `spec`. But nginx has dozens of knobs (timeouts, buffer sizes, rate limits, etc.) that you configure through **annotations** — key-value metadata on the Ingress resource.

The nginx ingress controller recognizes annotation keys that start with `nginx.ingress.kubernetes.io/`:

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-read-timeout: "3600" # kill connection if server sends nothing for 3600s
  nginx.ingress.kubernetes.io/proxy-send-timeout: "3600" # kill connection if client sends nothing for 3600s
  nginx.ingress.kubernetes.io/proxy-connect-timeout: "60" # give up connecting to the Service after 60s
```

These annotations only affect the routes defined in THAT Ingress resource. The WS Ingress has 3600s timeouts — those only apply to `/glasses-ws` and `/app-ws`. The main Ingress has 60s timeouts — those apply to everything else.

This is exactly what caused the 035 bug. Porter created one Ingress for all paths with 60s timeouts. For REST (short request → response), 60s is plenty. For WebSocket (long-lived connection, can be idle for minutes), `proxy-send-timeout: 60s` killed the connection whenever the client was quiet for over a minute.

### TLS Secrets — The Certificates

Each Ingress can reference **Secrets** that hold SSL certificates. We use **cert-manager** (a Kubernetes add-on) with Let's Encrypt to auto-provision these.

```yaml
tls:
  - hosts:
      - debug.augmentos.cloud
    secretName: cloud-debug-cloud-debug-augmentos-cloud
```

The WS ingress reuses the same TLS secrets as the main ingress. It doesn't need its own certificates — they're shared. cert-manager sees the secret already exists and skips it.

### Namespaces — Folders

Namespaces are organizational folders. All our stuff lives in `default`. System components live in their own namespaces:

```bash
porter kubectl -- get pods                      # our app pods (default namespace)
porter kubectl -- get pods -n ingress-nginx     # nginx controller pods
porter kubectl -- get pods -n cert-manager      # cert-manager pods
```

Not critical to understand deeply — just know the `-n` flag switches namespaces.

---

## How It All Connects

The full picture from physical hardware to a user request:

```
Azure Data Center (Central US)
├── Node (VM): aks-...-vmss000072  [8 CPU, 16GB RAM]
│   └── Pod: cloud-debug-cloud-6fd6cdb7f8-p98w2
│       └── Container: Bun server (:80) + Go bridge
│
├── Node (VM): aks-...-vmss00006y  [8 CPU, 16GB RAM]
│   └── Pod: cloud-prod-cloud-fc78c8447-998jq
│       └── Container: Bun server (:80) + Go bridge
│
├── Node (VM): aks-...-vmss000000  [4 CPU, 8GB RAM]
│   └── Pod: ingress-nginx-controller-xxxxx
│       └── Container: nginx (receives ALL inbound HTTP traffic)
│
└── ... 40 more nodes with other pods
```

And the request flow when Matt's glasses connect to `debug.augmentos.cloud/glasses-ws`:

```
1. Matt's Glasses (BLE) → Phone App (WebSocket client)
        │
2.      ▼
   Cloudflare Edge (CDN / DDoS / TLS termination)
        │  Cloudflare maintains two TCP connections:
        │  Phone ↔ Cloudflare edge, Cloudflare edge ↔ our cluster
        │
3.      ▼
   nginx Ingress Controller Pod
        │  Checks all Ingress resources:
        │    cloud-debug-cloud-ws matches /glasses-ws  ← wins
        │    Uses annotations: proxy_send_timeout 3600s
        │
4.      ▼
   Service: cloud-debug-cloud (10.0.19.175:80)
        │  Looks up current pod by label selector
        │
5.      ▼
   Pod: cloud-debug-cloud-6fd6cdb7f8-p98w2
        │  Container port 80
        │
6.      ▼
   Bun WebSocket handler → UserSession → Apps
```

For UDP audio, it's much shorter:

```
1. Phone App (UDP client)
        │
2.      ▼
   Azure LoadBalancer → public IP → Pod :8000
        │  No Cloudflare. No nginx. No Ingress.
        │
3.      ▼
   Bun UDP handler → AudioManager
```

---

## How Porter Fits In

Porter is a **platform-as-a-service** (PaaS) that sits on top of Kubernetes and Azure. It's the reason you don't need to write Kubernetes YAML or manage Azure VMs directly.

### What Porter does when you push to `main`

GitHub Actions runs `porter apply -f ./cloud/porter.yaml`. Porter:

1. **Builds** a Docker image from `cloud/docker/Dockerfile.livekit`
2. **Creates/updates a Deployment** → "run 1 pod of this image"
3. **Creates/updates a Service** → `cloud-prod-cloud`, NodePort on port 80
4. **Creates/updates an Ingress** → `cloud-prod-cloud`, routes domains to the service, 60s timeouts

That's it. Porter does NOT create the UDP LoadBalancer services or the WS ingress — those are manually-created resources we manage ourselves (see below).

### How Porter knows what's "its"

Porter tags everything it creates with Helm labels:

```yaml
# On Porter-managed ingress (cloud-debug-cloud):
labels:
  app.kubernetes.io/managed-by: Helm
  app.kubernetes.io/instance: cloud-debug
  helm.sh/chart: cloud-debug-cloud-0.244.0
```

Every deploy, Porter looks for resources **with its own labels** and updates them. It doesn't scan everything in the namespace. Anything without these labels is invisible to Porter.

### What Porter does NOT touch

Our WS ingress (`cloud-debug-cloud-ws`) has **no labels**:

```yaml
# Our manually-created WS ingress:
metadata:
  name: cloud-debug-cloud-ws
  annotations:
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    ...
  # No labels. No Helm metadata. Porter can't see this.
```

Porter will never update, overwrite, or delete it. It persists across every deploy. This is why manually-created resources survive.

### The porter.yaml → Kubernetes mapping

```
porter.yaml field                    Kubernetes resource created
──────────────────────────────────   ──────────────────────────────
build:                          →    Docker image in registry
  dockerfile: Dockerfile.livekit

services:
  - name: cloud                 →    Deployment + Pod
    run: ./start.sh                  (what container to run, how many)
    port: 80                    →    Service (NodePort)
                                     (stable name → pod routing)
    cpuCores: 5                 →    Resource requests on pod
    ramMegabytes: 4096               (Kubernetes uses these to pick a node)

                                →    Ingress (auto-created by Porter)
                                     (domain → service routing, 60s timeouts)
                                     ⚠️  No way to configure timeout annotations
                                         in porter.yaml — this is why we need
                                         the separate WS ingress

    additionalPorts:            ✗    Does NOT actually create a UDP LoadBalancer.
      - port: 8000                   Porter only understands HTTP Ingress rules.
        protocol: UDP                We create the UDP service manually via kubectl.
```

### What we manage manually (outside Porter)

These are Kubernetes resources we create with `kubectl apply`. Porter doesn't know about them:

| Resource                 | Name                   | What it does                        | Docs                                                             |
| ------------------------ | ---------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| **LoadBalancer Service** | `cloud-{env}-udp`      | Public IP for UDP audio (port 8000) | [udp-loadbalancer](../udp-loadbalancer/udp-loadbalancer-spec.md) |
| **Ingress**              | `cloud-{env}-cloud-ws` | WS paths with 3600s timeouts        | [035-nginx-ws-timeout](../035-nginx-ws-timeout/spec.md)          |

Both survive Porter deploys (no Helm labels). Both need to be re-applied if the cluster is rebuilt from scratch.

````

---

## `kubectl` — Talking to Kubernetes

`kubectl` is the CLI for Kubernetes. We access it through Porter: `porter kubectl -- <command>`. The `porter` wrapper handles authentication and cluster selection.

### Read stuff (safe, changes nothing)

```bash
# List resources
porter kubectl -- get pods                          # all pods in default namespace
porter kubectl -- get services                      # all services
porter kubectl -- get ingress                       # all ingress resources
porter kubectl -- get nodes                         # all nodes in the cluster

# Get details of one resource (YAML dump)
porter kubectl -- get ingress cloud-debug-cloud -o yaml

# Read pod logs
porter kubectl -- logs cloud-debug-cloud-6fd6cdb7f8-p98w2            # current logs
porter kubectl -- logs cloud-debug-cloud-6fd6cdb7f8-p98w2 --tail=50  # last 50 lines
porter kubectl -- logs cloud-debug-cloud-6fd6cdb7f8-p98w2 -f         # live stream

# Shell into a running pod
porter kubectl -- exec -it cloud-debug-cloud-6fd6cdb7f8-p98w2 -- sh
````

### Write stuff (changes the cluster)

```bash
# Create or update a resource from a YAML file
porter kubectl -- apply -f k8s/ws-ingress-debug.yaml
# "apply" is declarative: make this exist and look like this.
# First run: creates it. Second run: no-op (already matches).
# Changed the YAML: updates only what changed.

# Delete a resource
porter kubectl -- delete ingress cloud-debug-cloud-ws
# Immediately removes it. nginx regenerates config without those routes.

# Edit an annotation on an existing resource
porter kubectl -- annotate ingress cloud-debug-cloud \
    nginx.ingress.kubernetes.io/proxy-send-timeout="3600" --overwrite
```

### Inspect nginx's generated config

```bash
# Find the nginx controller pod
porter kubectl -- get pods -n ingress-nginx

# See how nginx is routing /glasses-ws
porter kubectl -- exec <nginx-pod-name> -n ingress-nginx -- \
    cat /etc/nginx/nginx.conf | grep -A10 'location.*glasses-ws'
```

---

## What Can Go Wrong

### "Will Porter overwrite my manual resource?"

**No.** Porter only touches resources with its Helm labels. Manually-created resources are invisible to Porter. Every deploy is safe.

### "Will my manual resource survive a deploy?"

**Yes.** Deploys only replace the pod (new Docker image) and update Porter-managed resources. Standalone Ingress, ConfigMaps, Secrets, etc. are untouched.

### "What if the cluster is rebuilt from scratch?"

**Everything is gone** — including manual resources. This is rare (cluster migrations, major infrastructure changes) but possible. This is why we check manifests into the repo (`cloud/k8s/`). They're not auto-applied, but you can re-apply them:

```bash
porter kubectl -- apply -f cloud/k8s/ws-ingress-staging.yaml
porter kubectl -- apply -f cloud/k8s/ws-ingress-prod.yaml
```

A fresh cluster needs:

1. Porter redeploy (recreates Deployments, Services, main Ingress)
2. Manual `kubectl apply` of WS ingress manifests
3. cert-manager reprovisioning TLS certs (automatic)

### "What if Porter changes the service name?"

The WS ingress hardcodes `cloud-debug-cloud` as the backend service name. If Porter ever changes this (unlikely, would require major refactor), the WS ingress would route to a nonexistent service → 503 on WebSocket paths. You'd update the WS ingress YAML to match.

### "What happens when the nginx ingress controller pod restarts?"

**All WebSocket connections through that pod die instantly** (1006). The nginx controller runs as a pod too — it can restart for upgrades, crashes, or node maintenance. When it comes back, new connections work fine, but every existing WebSocket session is gone. This is what caused the simultaneous disconnect of 4 users in the 035 investigation.

### "Can two Ingress resources conflict?"

If two Ingress resources define the exact same host + path, behavior is undefined (depends on creation order). Our setup avoids this: WS ingress uses `/glasses-ws` and `/app-ws` (Prefix match), main ingress uses `/` (catch-all). No overlap — nginx picks the most specific match.

### "What if a node dies?"

Kubernetes detects the dead node and reschedules its pods onto other nodes with enough capacity. There's a brief gap (seconds to minutes) while the new pod starts. During that gap, the environment is down. For prod, this means a specific region might blip — the other regional clusters (east-asia, france) are unaffected.

---

## Putting It All Together: The 035 Fix Explained

Now the WS ingress fix should make sense:

**Problem:** Porter creates one Ingress for all paths with 60s timeouts. We can't change timeout annotations through porter.yaml. Glasses WebSocket goes idle (no client → server data after audio moved to UDP). nginx's `proxy_send_timeout: 60s` fires → kills the connection → 1006.

**Fix:** Create a **second** Ingress resource manually — same hosts, but only `/glasses-ws` and `/app-ws` paths, with 3600s timeouts. nginx merges both Ingress resources into its config. `/glasses-ws` matches the specific WS ingress (3600s), everything else matches the Porter ingress (60s).

**Why it persists:** The WS ingress has no Helm labels. Porter doesn't know it exists. Deploys don't touch it. It survives indefinitely unless someone deletes it or the cluster is rebuilt.

**Why we check it into the repo:** If the cluster IS rebuilt, having the YAML in `cloud/k8s/` means we can re-apply it in one command instead of recreating it from memory.

---

## Glossary

| Term             | What it is                             | Our example                                               |
| ---------------- | -------------------------------------- | --------------------------------------------------------- |
| **Cluster**      | A group of machines running Kubernetes | us-central (4689), east-asia (4754), france (4696)        |
| **Node**         | One machine (VM) in a cluster          | `aks-u4689eanqib-...-vmss000072` (8 CPU, 16GB)            |
| **Pod**          | A running container (your server)      | `cloud-debug-cloud-6fd6cdb7f8-p98w2`                      |
| **Deployment**   | "Keep N copies of this pod running"    | Managed by Porter, N=1 per environment                    |
| **Service**      | Stable name → pod routing              | `cloud-debug-cloud` → pod on port 80                      |
| **Ingress**      | Host/path → Service routing rules      | `cloud-debug-cloud-ws` → 3600s timeouts for WS paths      |
| **Annotation**   | Key-value config on a resource         | `proxy-send-timeout: "3600"`                              |
| **Label**        | Key-value tag for grouping/selecting   | `app.kubernetes.io/managed-by: Helm`                      |
| **Namespace**    | Organizational folder                  | `default` (our stuff), `ingress-nginx` (nginx controller) |
| **Secret**       | Encrypted data (TLS certs, API keys)   | `cloud-debug-cloud-debug-augmentos-cloud`                 |
| **ConfigMap**    | Non-secret config data                 | nginx global settings                                     |
| **kubectl**      | CLI to talk to Kubernetes              | `porter kubectl -- get pods`                              |
| **Porter**       | PaaS that manages K8s for us           | Creates Deployments, Services, Ingress from porter.yaml   |
| **Helm**         | Package manager Porter uses internally | You don't use it directly                                 |
| **cert-manager** | Auto-provisions TLS certs              | Creates Let's Encrypt certs as Secrets                    |
| **Azure**        | Cloud provider (owns the hardware)     | Runs our VMs in Central US, East Asia, France             |

---

## Next Steps

- See [035-nginx-ws-timeout/spec.md](../035-nginx-ws-timeout/spec.md) for the WS ingress manifests to apply to staging and prod
- WS ingress manifests should be checked into `cloud/k8s/` so they survive knowledge loss
