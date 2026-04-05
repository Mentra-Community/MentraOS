# UDP LoadBalancer Architecture

## The Problem

Porter creates an **nginx Ingress** for HTTP traffic only:

```
Mobile → Cloudflare → nginx Ingress (128.203.164.18:443) → Pod :80
                      ↑
                      HTTP/WebSocket only, no UDP
```

UDP packets can't reach the Bun server because:

1. nginx Ingress only handles HTTP/HTTPS/WebSocket
2. Porter's `additionalPorts` config only creates HTTP Ingress rules
3. No UDP path exists from internet → pod

## The Solution

Create a separate Kubernetes LoadBalancer service for UDP:

```
Mobile HTTP/WS → Cloudflare → nginx Ingress → Pod :80
Mobile UDP     → LoadBalancer IP:8000 → Pod :8000
```

Two independent paths to the same pod.

## NodePort vs LoadBalancer

| Type             | How it works                     | Public IP?                |
| ---------------- | -------------------------------- | ------------------------- |
| **NodePort**     | Opens port on every cluster node | No - need to know node IP |
| **LoadBalancer** | Azure provisions a public IP     | Yes - automatic           |

Porter uses NodePort for HTTP (with nginx Ingress in front). We use LoadBalancer for UDP (direct access).

## UDP Service Manifest

```yaml
# cloud/udp-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: cloud-debug-udp # Change per app: cloud-dev-udp, cloud-prod-udp
  namespace: default
  labels:
    porter.run/app-name: cloud-debug
spec:
  type: LoadBalancer
  selector:
    porter.run/app-name: cloud-debug # Must match your app name
    porter.run/service-name: cloud
  ports:
    - name: udp-audio
      protocol: UDP
      port: 8000
      targetPort: 8000
```

## Setup Commands

```bash
# 1. Switch to the right cluster
porter config set-cluster 4689

# 2. Apply the UDP service
cat cloud/udp-service.yaml | porter kubectl -- apply -f -

# 3. Wait ~30 seconds, then get the IP
porter kubectl -- get svc cloud-debug-udp -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
# Output: 172.168.226.103
```

## Key Behaviors

### Idempotent

Running `kubectl apply` twice is safe:

- Service doesn't exist → creates it
- Service exists → no change (IP stays the same)

### Persistent

The UDP service is **not managed by Porter**. It survives:

- Pod restarts
- App redeploys
- Porter updates

Only deleted if you explicitly delete it.

### IP Stability

LoadBalancer IP stays the same unless:

- Service is deleted and recreated
- Cluster is recreated
- Azure maintenance (rare)

## Services Per Environment

Need one UDP service per app per cluster:

| App           | Cluster | Service Name      | Selector                             |
| ------------- | ------- | ----------------- | ------------------------------------ |
| cloud-debug   | 4689    | cloud-debug-udp   | `porter.run/app-name: cloud-debug`   |
| cloud-dev     | 4689    | cloud-dev-udp     | `porter.run/app-name: cloud-dev`     |
| cloud-staging | 4689    | cloud-staging-udp | `porter.run/app-name: cloud-staging` |
| cloud-prod    | 4689    | cloud-prod-udp    | `porter.run/app-name: cloud-prod`    |
| cloud-prod    | 4696    | cloud-prod-udp    | `porter.run/app-name: cloud-prod`    |
| cloud-prod    | 4754    | cloud-prod-udp    | `porter.run/app-name: cloud-prod`    |

## Verify Setup

```bash
# Check service exists and has IP
porter kubectl -- get svc cloud-debug-udp

# Check pod labels match selector
porter kubectl -- get pods -l porter.run/app-name=cloud-debug --show-labels

# Check UDP server is running
curl -s https://debug.augmentos.cloud/health | jq .udp

# Send test ping
python3 -c "
import socket, struct
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
packet = struct.pack('>I', 0x12345678) + struct.pack('>H', 1) + b'PING'
sock.sendto(packet, ('172.168.226.103', 8000))
"

# Verify ping was received
curl -s https://debug.augmentos.cloud/health | jq .udp.stats.pings
```

## DNS (Optional)

If you want a hostname instead of IP:

1. Go to Cloudflare DNS
2. Add A record:
   - Name: `udp.debug` (becomes `udp.debug.augmentos.cloud`)
   - IPv4: `172.168.226.103`
   - Proxy: **DNS only** (gray cloud ⚪) - Cloudflare proxy doesn't support UDP
3. Mobile connects to `udp.debug.augmentos.cloud:8000`

## Current Status

| Component        | Status      | Value             |
| ---------------- | ----------- | ----------------- |
| UDP Service      | ✅ Created  | `cloud-debug-udp` |
| LoadBalancer IP  | ✅ Assigned | `172.168.226.103` |
| UDP Port         | ✅ Open     | `8000`            |
| Packet Reception | ✅ Tested   | Pings received    |

## Troubleshooting

### No external IP (stuck on `<pending>`)

```bash
porter kubectl -- describe svc cloud-debug-udp
```

Check events for Azure provisioning errors.

### Packets not received

1. Check UDP server is running: `curl .../health | jq .udp.running`
2. Check selector matches pods: `porter kubectl -- get pods -l porter.run/app-name=cloud-debug`
3. Check service endpoints: `porter kubectl -- get endpoints cloud-debug-udp`

### Wrong pods targeted

Verify pod labels:

```bash
porter kubectl -- get pods -l porter.run/app-name=cloud-debug --show-labels | grep service-name
```

Should show `porter.run/service-name=cloud`.
