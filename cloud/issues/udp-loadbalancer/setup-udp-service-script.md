# UDP Service Setup Script

Documentation for `cloud/scripts/setup-udp-service.sh` and planned enhancements.

## Current Behavior

The script creates a Kubernetes LoadBalancer service to expose UDP port 8000 for audio streaming.

### Usage

```bash
# Create UDP service for an app
./cloud/scripts/setup-udp-service.sh --app cloud-debug --cluster 4689

# Check status of all UDP services
./cloud/scripts/setup-udp-service.sh --status
```

### What It Does

1. Switches Porter CLI to the specified cluster
2. Validates the app exists (checks for pods with `porter.run/app-name` label)
3. Generates and applies a LoadBalancer service manifest
4. Waits for Azure to assign a public IP (30-60 seconds)
5. Displays the UDP endpoint

### Service Manifest

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ${app_name}-udp
  namespace: default
  labels:
    porter.run/app-name: ${app_name}
spec:
  type: LoadBalancer
  selector:
    porter.run/app-name: ${app_name}
    porter.run/service-name: cloud
  ports:
    - name: udp-audio
      protocol: UDP
      port: 8000
      targetPort: 8000
```

---

## Planned Enhancements

### Problem

After creating the UDP LoadBalancer, you must manually set `UDP_HOST` and `UDP_PORT` env vars in:

- Porter (for immediate use)
- Doppler (for future Doppler-managed deployments)

This is error-prone and tedious.

### Solution

Add flags to automatically set env vars after creating the UDP service.

### New Flags

| Flag                | Description                                        |
| ------------------- | -------------------------------------------------- |
| `--set-porter-env`  | Set UDP_HOST/UDP_PORT in Porter app env vars       |
| `--set-doppler-env` | Set UDP_HOST/UDP_PORT in Doppler config            |
| `--set-env`         | Set both Porter AND Doppler (convenience)          |
| `--skip-redeploys`  | Don't trigger app redeploy when setting Porter env |
| `--dry-run`         | Show what would be done without doing it           |

### App-to-Doppler Config Mapping

| Porter App    | Cluster | Region     | Doppler Config        |
| ------------- | ------- | ---------- | --------------------- |
| cloud-debug   | 4689    | US Central | _(skip - no Doppler)_ |
| cloud-dev     | 4689    | US Central | `dev`                 |
| cloud-staging | 4689    | US Central | `staging`             |
| cloud-prod    | 4689    | US Central | `prod_central-us`     |
| cloud-prod    | 4696    | France     | `prod_france`         |
| cloud-prod    | 4754    | East Asia  | `prod_east-asia`      |
| cloud-prod    | 4977    | US East    | `prod_us-east`        |
| cloud-prod    | 4965    | US West    | `prod_us-west`        |
| cloud-prod    | 4753    | Canada     | `prod_canada`         |
| cloud-prod    | 4978    | Australia  | `prod_australia`      |

### Enhanced Flow

```
1. Parse arguments
2. Switch to cluster (existing)
3. Create/apply LoadBalancer service (existing)
4. Wait for IP assignment (existing)
5. NEW: If --set-porter-env or --set-env:
   └─ porter env set --app $APP -v UDP_HOST=$IP -v UDP_PORT=8000 [--skip-redeploys]
6. NEW: If --set-doppler-env or --set-env:
   └─ Map app+cluster → Doppler config
   └─ doppler secrets set UDP_HOST=$IP UDP_PORT=8000 --project mentraos-cloud --config $CONFIG
7. Display summary
```

### Example Usage

```bash
# Create UDP service + set env vars in both Porter and Doppler
./setup-udp-service.sh --app cloud-dev --cluster 4689 --set-env

# Create UDP service + only set in Porter (e.g., for debug)
./setup-udp-service.sh --app cloud-debug --cluster 4689 --set-porter-env

# Create UDP service + set in Doppler only (preparing for migration)
./setup-udp-service.sh --app cloud-prod --cluster 4696 --set-doppler-env

# Dry run to preview actions
./setup-udp-service.sh --app cloud-prod --cluster 4689 --set-env --dry-run

# Set env vars but don't trigger redeploy
./setup-udp-service.sh --app cloud-dev --cluster 4689 --set-porter-env --skip-redeploys
```

### Enhanced Status Output

```
═══════════════════════════════════════════════════════════════════════════════════
APP             CLUSTER  REGION               UDP ENDPOINT             ENV STATUS
───────────────────────────────────────────────────────────────────────────────────
cloud-debug     4689     US Central           172.168.226.103:8000     Porter ✓
cloud-dev       4689     US Central           (not created)            -
cloud-staging   4689     US Central           172.168.226.105:8000     Porter ✓ Doppler ✓
cloud-prod      4689     US Central           172.168.226.110:8000     Porter ✓ Doppler ✓
cloud-prod      4696     France               10.20.30.40:8000         Porter ✓ Doppler ✓
═══════════════════════════════════════════════════════════════════════════════════
```

---

## Implementation Details

### Porter Env Set Command

```bash
porter env set \
  --app cloud-dev \
  --cluster 4689 \
  -v UDP_HOST=172.168.226.103 \
  -v UDP_PORT=8000 \
  --skip-redeploys  # optional
```

### Doppler Secrets Set Command

```bash
doppler secrets set \
  UDP_HOST=172.168.226.103 \
  UDP_PORT=8000 \
  --project mentraos-cloud \
  --config dev
```

### Mapping Function (Bash)

```bash
get_doppler_config() {
    local app=$1
    local cluster=$2

    case "${app}:${cluster}" in
        "cloud-dev:4689")      echo "dev" ;;
        "cloud-staging:4689")  echo "staging" ;;
        "cloud-prod:4689")     echo "prod_central-us" ;;
        "cloud-prod:4696")     echo "prod_france" ;;
        "cloud-prod:4754")     echo "prod_east-asia" ;;
        "cloud-prod:4977")     echo "prod_us-east" ;;
        "cloud-prod:4965")     echo "prod_us-west" ;;
        "cloud-prod:4753")     echo "prod_canada" ;;
        "cloud-prod:4978")     echo "prod_australia" ;;
        *)                     echo "" ;;  # No Doppler config (e.g., cloud-debug)
    esac
}
```

---

## Status

- [x] Document current script behavior
- [x] Design enhanced flags and flow
- [x] Implement `--set-porter-env` flag
- [x] Implement `--set-doppler-env` flag
- [x] Implement `--set-env` convenience flag
- [x] Implement `--dry-run` flag
- [x] Implement `--skip-redeploys` flag
- [x] Update `--status` to show env var status
- [ ] Test with cloud-dev (run without --dry-run)
- [ ] Test with cloud-prod multi-region
