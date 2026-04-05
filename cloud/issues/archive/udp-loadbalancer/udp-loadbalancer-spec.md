# UDP LoadBalancer Spec

## Overview

Expose UDP port 8000 from cloud pods to the internet via Kubernetes LoadBalancer, enabling mobile clients to send audio packets directly over UDP instead of WebSocket.

## Problem

Porter's `additionalPorts` config only creates HTTP Ingress rules. It does not create UDP LoadBalancer services.

Current architecture:

```
Mobile → Cloudflare → nginx Ingress (HTTP only) → Pod
```

We need:

```
Mobile → UDP LoadBalancer → Pod:8000
```

### Evidence

- Porter uses shared nginx Ingress LoadBalancer (`128.203.164.18`) for all HTTP
- `additionalPorts` in porter.yaml did not create UDP service
- UDP packets cannot traverse HTTP-only nginx Ingress

## Constraints

- **Porter limitation**: No native UDP support in Porter's app config
- **Cloudflare proxy**: Cannot proxy UDP (HTTP/WebSocket only) - must use DNS-only mode
- **Azure AKS**: Supports UDP LoadBalancer services natively
- **DNS**: Need separate subdomain for UDP (can't share with HTTP ingress)

## Goals

1. Expose UDP port 8000 externally via Kubernetes LoadBalancer
2. Automate UDP service creation in CI/CD (survives redeploys)
3. Provide DNS endpoint for mobile clients (`udp.debug.augmentos.cloud`)
4. Support dynamic endpoint discovery via HTTP API

## Non-Goals

- Geo-routed UDP load balancing (future work)
- Cloudflare Spectrum integration (paid, not needed yet)
- UDP for production environments (debug only for now)

## Solution

### Workaround

Apply a separate UDP LoadBalancer service via `kubectl` after Porter deploy:

```yaml
# cloud/udp-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: cloud-debug-udp
  namespace: default
spec:
  type: LoadBalancer
  selector:
    porter.run/app-name: cloud-debug
    porter.run/service-name: cloud
  ports:
    - name: udp-audio
      protocol: UDP
      port: 8000
      targetPort: 8000
```

### CI/CD Integration

Add kubectl step after Porter deploy:

1. Get kubeconfig via `porter kubeconfig`
2. Apply UDP service manifest
3. (Optional) Update Cloudflare DNS with LoadBalancer IP

### DNS Setup

| Record      | Type | Value             | Proxy       |
| ----------- | ---- | ----------------- | ----------- |
| `udp.debug` | A    | `172.168.226.103` | DNS only ⚪ |

**Important**: Must be DNS-only (gray cloud), not proxied (orange cloud).

## Current Status

- [x] UDP service created manually via `porter kubectl`
- [x] LoadBalancer IP assigned: `172.168.226.103:8000`
- [x] UDP packets reaching server (verified via health endpoint)
- [ ] CI/CD automation
- [ ] Cloudflare DNS record
- [ ] Mobile client integration

## Open Questions

1. **DNS automation?**
   - Manual: Add A record once, rarely changes
   - Automated: Cloudflare API in CI/CD
   - **Decision**: Start manual, automate if IP changes frequently

2. **Production environments?**
   - Separate UDP services per environment (debug/staging/prod)
   - Same workflow, different selectors
   - **TODO**: Implement for staging/prod when needed

3. **IP stability?**
   - Azure LoadBalancer IPs are stable unless service is deleted
   - CI/CD recreates service → same IP if service exists
   - **Risk**: IP changes if service deleted and recreated
