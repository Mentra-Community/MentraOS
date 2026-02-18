# Debug Commands for LiveKit iOS Bug

## Better Stack Logging Setup (RECOMMENDED)

### Quick Setup for Go Bridge Logs

The Go LiveKit bridge logs are not currently being captured. Follow these steps to send them to Better Stack:

1. **Create Better Stack HTTP Source:**

   ```bash
   # Go to https://telemetry.betterstack.com/
   # Create new source with platform: "HTTP"
   # Name: "LiveKit gRPC Bridge"
   # Save the token and ingesting host
   ```

2. **Add to .env:**

   ```bash
   BETTERSTACK_SOURCE_TOKEN=your_token_here
   BETTERSTACK_INGESTING_HOST=sXXX.region.betterstackdata.com
   ```

3. **Update docker-compose.dev.yml:**

   ```yaml
   livekit-bridge:
     environment:
       - BETTERSTACK_SOURCE_TOKEN=${BETTERSTACK_SOURCE_TOKEN}
       - BETTERSTACK_INGESTING_HOST=${BETTERSTACK_INGESTING_HOST}
   ```

4. **See full setup guide:**
   ```bash
   cat cloud/packages/cloud-livekit-bridge/BETTERSTACK_SETUP.md
   ```

### Search Better Stack After Setup

Once configured, you can search logs with:

- `service:livekit-bridge AND error:*token is expired*`
- `service:livekit-bridge AND user_id:"isaiah@mentra.glass"`
- `service:livekit-bridge AND message:*JoinRoom*`
- `service:livekit-bridge AND level:error`

## Porter Setup

```bash
# Login to Porter
porter auth login

# List clusters
porter cluster list

# Set cluster (for centralus)
porter cluster set 4689
```

## Check Environment Variables

```bash
# Get kubeconfig
porter kubectl --print-kubeconfig > /tmp/kubeconfig.yaml
export KUBECONFIG=/tmp/kubeconfig.yaml

# Find cloud pods
kubectl get pods -n default | grep cloud

# Check environment variables for cloud-debug
kubectl exec cloud-debug-cloud-XXXXX -n default -- env | grep LIVEKIT

# Check environment variables for cloud-livekit
kubectl exec cloud-livekit-cloud-XXXXX -n default -- env | grep LIVEKIT
```

## Get Logs

```bash
# Cloud debug logs (last 100 lines with livekit mentions)
kubectl logs cloud-debug-cloud-XXXXX -n default --tail=100 | grep -i livekit

# Cloud livekit logs
kubectl logs cloud-livekit-cloud-XXXXX -n default --tail=100 | grep -i livekit

# All recent logs without filter
kubectl logs cloud-debug-cloud-XXXXX -n default --tail=200

# Follow logs in real-time
kubectl logs cloud-debug-cloud-XXXXX -n default -f
```

## Check for Bridge Container/Sidecar

```bash
# List containers in a pod
kubectl get pod cloud-debug-cloud-XXXXX -n default -o jsonpath='{.spec.containers[*].name}'

# If bridge is a sidecar, get its logs
kubectl logs cloud-debug-cloud-XXXXX -n default -c livekit-bridge --tail=200

# Check all pods with "bridge" in name
kubectl get pods -n default | grep bridge
```

## Get gRPC Bridge Logs

```bash
# Find bridge pods
kubectl get pods -n default | grep livekit

# Get bridge logs
kubectl logs cloud-livekit-cloud-XXXXX -n default --tail=500

# Search for specific user
kubectl logs cloud-livekit-cloud-XXXXX -n default --tail=500 | grep "isaiah@mentra.glass"

# Search for errors
kubectl logs cloud-livekit-cloud-XXXXX -n default --tail=500 | grep -i "error\|fail"
```

## Test Specific User Flow

```bash
# Watch logs for specific user in real-time
kubectl logs cloud-debug-cloud-XXXXX -n default -f | grep "isaiah@mentra.glass"

# Get all logs for user in last hour
kubectl logs cloud-debug-cloud-XXXXX -n default --since=1h | grep "isaiah@mentra.glass"
```

## Check Services and Endpoints

```bash
# List services
kubectl get svc -n default | grep -E "livekit|cloud"

# Get service details
kubectl describe svc cloud-debug-cloud -n default
kubectl describe svc cloud-livekit-cloud -n default

# Check endpoints
kubectl get endpoints -n default | grep cloud
```

## Compare Regions

```bash
# Centralus (cloud-debug)
kubectl exec cloud-debug-cloud-XXXXX -n default -- env | grep -E "LIVEKIT|REGION" | sort

# Cloud-livekit
kubectl exec cloud-livekit-cloud-XXXXX -n default -- env | grep -E "LIVEKIT|REGION" | sort

# Switch to france cluster
porter cluster set 4696
export KUBECONFIG=/tmp/kubeconfig-france.yaml
porter kubectl --print-kubeconfig > /tmp/kubeconfig-france.yaml

# Check france pods
kubectl get pods -n default | grep cloud

# Compare france env vars
kubectl exec cloud-france-XXXXX -n default -- env | grep LIVEKIT
```

## BetterStack Queries

```bash
# Already have connection established in the session
# Search for user logs with livekit
SELECT dt, raw
FROM remote(t373499_augmentos_logs)
WHERE raw LIKE '%isaiah@mentra.glass%'
  AND raw LIKE '%livekit%'
ORDER BY dt DESC
LIMIT 100

# Search for errors
SELECT dt, raw
FROM remote(t373499_augmentos_logs)
WHERE (raw LIKE '%livekit%' OR raw LIKE '%LiveKit%')
  AND (raw LIKE '%error%' OR raw LIKE '%Error%' OR raw LIKE '%fail%')
ORDER BY dt DESC
LIMIT 100

# Filter by region
SELECT dt, raw
FROM remote(t373499_augmentos_logs)
WHERE raw LIKE '%livekit%'
  AND raw LIKE '%region%'
  AND (raw LIKE '%centralus%' OR raw LIKE '%france%')
ORDER BY dt DESC
LIMIT 100
```

## Test Region Switch Manually

1. **Connect to cloud-debug (centralus):**

   ```bash
   # In mobile app settings, select cloud-debug
   # Watch logs:
   kubectl logs cloud-debug-cloud-XXXXX -n default -f | grep "isaiah@mentra.glass"
   ```

2. **Verify LiveKit is working:**
   - Enable microphone
   - Check for "Bridge health" logs
   - Confirm audio is flowing

3. **Switch to cloud-livekit:**

   ```bash
   # In mobile app settings, select cloud-livekit
   # Watch new logs:
   kubectl logs cloud-livekit-cloud-XXXXX -n default -f | grep "isaiah@mentra.glass"
   ```

4. **Capture logs from OLD region:**
   ```bash
   # Check if old session disposed
   kubectl logs cloud-debug-cloud-XXXXX -n default --tail=200 | grep -A 20 "Disposing.*isaiah@mentra.glass"
   ```

## Mobile Debug (if needed)

```bash
# iOS logs (using Xcode or react-native)
npx react-native log-ios | grep -i livekit

# Android logs
adb logcat | grep -i livekit
```

## Quick Health Check

```bash
# Check all cloud services are running
kubectl get pods -n default | grep -E "cloud-debug|cloud-livekit|cloud-prod"

# Check if pods are healthy
kubectl get pods -n default -o wide | grep cloud

# Restart a pod if needed (rolling restart)
kubectl rollout restart deployment/cloud-debug-cloud -n default
```

## Useful Porter Commands

```bash
# List all apps
porter app list

# Get app details
porter app get cloud-debug

# View app logs through porter (if supported)
porter logs cloud-debug

# Check app status
porter app status cloud-debug
```
