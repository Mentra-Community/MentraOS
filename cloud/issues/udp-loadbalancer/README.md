# UDP LoadBalancer for Cloud Audio

Expose UDP port 8000 for direct audio streaming from mobile to cloud.

## Documents

- **udp-loadbalancer-spec.md** - Problem, goals, constraints
- **udp-loadbalancer-architecture.md** - Technical design
- **udp-client-improvements.md** - Dynamic host discovery, packet reordering
- **setup-udp-service-script.md** - Setup script usage and enhancements

## Quick Context

**Problem**: Porter only creates HTTP Ingress. UDP packets can't reach the Bun UDP server.

**Solution**: Create a separate Kubernetes LoadBalancer service for UDP via kubectl. One-time setup per app per cluster.

## How It Works

```
Mobile HTTP/WS → Cloudflare → nginx Ingress → Pod :80
Mobile UDP     → LoadBalancer IP:8000 → Pod :8000
```

Two independent paths to the same pod.

## MTU Limit Discovery

**Max reliable UDP packet size: 1472 bytes** (1466 bytes PCM + 6 byte header)

| Chunk Duration | Samples | PCM Bytes | Total Bytes | Status                |
| -------------- | ------- | --------- | ----------- | --------------------- |
| 100ms          | 1600    | 3200      | 3206        | ❌ Lost (exceeds MTU) |
| 50ms           | 800     | 1600      | 1606        | ❌ Lost (exceeds MTU) |
| 45ms           | 720     | 1440      | 1446        | ✅ Works              |
| **40ms**       | 640     | 1280      | 1286        | ✅ **Recommended**    |
| 20ms           | 320     | 640       | 646         | ✅ Works              |

Mobile must send **≤40ms chunks** (1286 bytes) to avoid packet loss from MTU fragmentation.

## Setup (One-Time Per App Per Cluster)

### Using the Script (Recommended)

```bash
# Setup UDP service for an app
./cloud/scripts/setup-udp-service.sh --app cloud-debug --cluster 4689
./cloud/scripts/setup-udp-service.sh --app cloud-prod --cluster 4696

# Check status of all UDP services
./cloud/scripts/setup-udp-service.sh --status
```

### Manual Commands

```bash
# 1. Switch to the right cluster
porter config set-cluster <cluster-id>

# 2. Apply the UDP service (edit app name in yaml first)
cat cloud/udp-service.yaml | porter kubectl -- apply -f -

# 3. Get the LoadBalancer IP (wait ~30 seconds)
porter kubectl -- get svc <app-name>-udp -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

Running the command twice is safe (idempotent). IP stays the same unless service is deleted.

## Current Status

| App           | Cluster | Region     | UDP Service    | IP                     |
| ------------- | ------- | ---------- | -------------- | ---------------------- |
| cloud-debug   | 4689    | US Central | ✅ created     | `172.168.226.103:8000` |
| cloud-dev     | 4689    | US Central | ❌ not created | -                      |
| cloud-staging | 4689    | US Central | ❌ not created | -                      |
| cloud-prod    | 4689    | US Central | ❌ not created | -                      |
| cloud-prod    | 4696    | France     | ❌ not created | -                      |
| cloud-prod    | 4754    | East Asia  | ❌ not created | -                      |

## Verify It Works

```bash
# Check health endpoint
curl -s https://debug.augmentos.cloud/health | jq .udp

# Send a test UDP ping
python3 -c "
import socket, struct
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
packet = struct.pack('>I', 0x12345678) + struct.pack('>H', 1) + b'PING'
sock.sendto(packet, ('172.168.226.103', 8000))
print('Sent!')
"

# Check ping count increased
curl -s https://debug.augmentos.cloud/health | jq .udp.stats.pings
```

## Key Details

- **Service persists independently** - Porter doesn't touch it during redeploys
- **IP is stable** - Only changes if service is deleted and recreated
- **No CI/CD needed** - One-time manual setup per environment
- **Cloudflare DNS optional** - Can use IP directly or add A record (DNS-only mode, not proxied)
- **MTU limit: 1472 bytes** - Packets larger than this get fragmented and lost

## UDP Host Configuration

Mobile needs the UDP LoadBalancer IP (different from HTTP endpoint).

**Option 1: Environment variable (build time)**

```
EXPO_PUBLIC_UDP_HOST_OVERRIDE=172.168.226.103
```

**Option 2: Developer settings (runtime)**
Settings → Developer → UDP LoadBalancer Host → Enter IP

**Option 3: Per-environment .env files**

```
# .env.debug
EXPO_PUBLIC_UDP_HOST_OVERRIDE=172.168.226.103

# .env.production
EXPO_PUBLIC_UDP_HOST_OVERRIDE=<prod-udp-ip>
```

## Clusters Reference

| Cluster ID | Name                      | Region         |
| ---------- | ------------------------- | -------------- |
| 4689       | mentra-cluster-central-us | US Central     |
| 4696       | france                    | France Central |
| 4754       | east-asia                 | East Asia      |
| 4753       | canada-central            | Canada Central |
| 4965       | us-west                   | US West 2      |
| 4977       | us-east                   | US East        |
| 4978       | australia-east            | Australia East |
