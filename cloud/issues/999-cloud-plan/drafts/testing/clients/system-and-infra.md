# System and Infrastructure Clients

This document covers the remaining cloud clients that are simpler in scope: system apps (MentraAI/Mira), coding agents, admin tooling, infrastructure probes, and smart glasses direct connections.

---

## MentraAI / Mira (System Apps)

### Overview

MentraAI and Mira are first-party system apps that ship with MentraOS. They interact with the cloud to manage user apps, start/stop apps on behalf of the user, and invoke tools exposed by SDK apps. Unlike third-party SDK apps, system apps are whitelisted by package name and use API key authentication rather than user JWT tokens.

The cloud also makes outbound requests to SDK app servers on behalf of system apps when invoking tools - this is the only client context where the cloud itself acts as an HTTP client calling external endpoints.

### Transport

| Transport | Endpoint Prefix         | Purpose                          |
| --------- | ----------------------- | -------------------------------- |
| REST      | `/api/sdk/system-app/*` | App lifecycle and tool discovery |
| REST      | `/api/tools/*`          | Tool invocation                  |

### Auth

Authentication uses API key query parameters. The cloud validates that the requesting package name is in a hardcoded whitelist of system app packages (MentraAI, Mira, and their variants). There is no JWT or session - each request is independently authenticated via the API key.

| Field            | Value                                      |
| ---------------- | ------------------------------------------ |
| Mechanism        | API key via query parameter                |
| Whitelisted apps | MentraAI, Mira (and variant package names) |
| Token storage    | Embedded in the system app at build time   |
| Rotation         | Requires app update to rotate keys         |

### Operations

| Method | Endpoint                                 | Purpose                                       | Auth Required |
| ------ | ---------------------------------------- | --------------------------------------------- | ------------- |
| GET    | `/api/sdk/system-app/apps`               | List user's apps with device compatibility    | Yes           |
| POST   | `/api/sdk/system-app/:packageName/start` | Start an app for the user                     | Yes           |
| POST   | `/api/sdk/system-app/:packageName/stop`  | Stop a running app for the user               | Yes           |
| GET    | `/api/sdk/system-app/tools`              | Get all available tools across installed apps | Yes           |
| GET    | `/api/tools/:toolId`                     | Get details for a specific tool               | Yes           |
| POST   | `/api/tools/:toolId/invoke`              | Invoke a tool on an SDK app                   | Yes           |

### Outbound Requests (Cloud as HTTP Client)

When a system app invokes a tool, the cloud makes an outbound HTTP request to the SDK app that owns that tool:

```
System app -[REST]-> Cloud -[REST POST {app.publicUrl}/tool]-> SDK app server
SDK app server -[response]-> Cloud -[response]-> System app
```

| Field    | Value                                         |
| -------- | --------------------------------------------- |
| Method   | POST                                          |
| Target   | `{app.publicUrl}/tool`                        |
| Timeout  | 20 - 30 seconds                               |
| Payload  | Tool invocation parameters as JSON            |
| Response | Tool result JSON forwarded back to system app |

### Failure Modes

| Failure                       | Current Behavior                       | Target Behavior                                           |
| ----------------------------- | -------------------------------------- | --------------------------------------------------------- |
| Invalid API key               | 401 response                           | 401 with clear error message                              |
| SDK app server unreachable    | Timeout after 20 - 30s, error returned | Bounded timeout with descriptive error to caller          |
| SDK app server slow response  | May exceed timeout window              | Enforce strict timeout; return partial or error           |
| Tool not found                | 404 response                           | 404 with tool ID in error body                            |
| App not installed             | Error returned                         | Clear error distinguishing "not installed" vs "not found" |
| Outbound request fails midway | Partial response or connection reset   | Retry once if idempotent; error with context if not       |

---

## Coding Agents

### Overview

Coding agents (such as Claude, Cursor, or similar AI-assisted development tools) connect to the cloud to inspect incidents and retrieve logs for debugging purposes. This is a read-only integration with a simple static API key authentication model.

### Transport

| Transport | Endpoint Prefix | Purpose             |
| --------- | --------------- | ------------------- |
| REST      | `/api/agent/*`  | Incident inspection |

### Auth

Authentication uses a static API key passed via the `X-Agent-Key` HTTP header. The key is configured on the cloud via the `MENTRA_AGENT_API_KEY` environment variable.

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| Mechanism      | Static API key via `X-Agent-Key` header |
| Server env var | `MENTRA_AGENT_API_KEY`                  |
| Token rotation | Requires cloud redeployment to rotate   |
| Permissions    | Read-only access to incidents and logs  |

### Operations

| Method | Endpoint                                | Purpose                  | Auth Required |
| ------ | --------------------------------------- | ------------------------ | ------------- |
| GET    | `/api/agent/incidents`                  | List all incidents       | Yes           |
| GET    | `/api/agent/incidents/:incidentId`      | Get a specific incident  | Yes           |
| GET    | `/api/agent/incidents/:incidentId/logs` | Get logs for an incident | Yes           |

### Failure Modes

| Failure                    | Current Behavior                     | Target Behavior                              |
| -------------------------- | ------------------------------------ | -------------------------------------------- |
| Invalid or missing API key | 401 response                         | 401 with clear error; no information leakage |
| Incident not found         | 404 response                         | 404 with incident ID in error body           |
| Large log payload          | Full response returned (may be slow) | Paginate or stream large log sets            |
| Key compromised            | Must redeploy cloud to rotate        | Support key rotation without downtime        |

---

## Admin

### Overview

The admin interface provides internal tooling for reviewing submitted apps, inspecting system state, and performing diagnostics. Access is restricted to a hardcoded email whitelist. Admin endpoints are split across two route prefixes - general admin and console-embedded admin views.

### Transport

| Transport | Endpoint Prefix        | Purpose                      |
| --------- | ---------------------- | ---------------------------- |
| REST      | `/api/admin/*`         | General admin operations     |
| REST      | `/api/console/admin/*` | Console-embedded admin views |

### Auth

Authentication uses a JWT where the email claim is checked against a server-side whitelist defined in the `ADMIN_EMAILS` environment variable.

| Field        | Value                                                  |
| ------------ | ------------------------------------------------------ |
| Mechanism    | Admin JWT (email in ADMIN_EMAILS env whitelist)        |
| Whitelist    | `ADMIN_EMAILS` environment variable (comma-separated)  |
| Token source | Same console JWT flow, admin status derived from email |
| Permissions  | Full read access; approve/reject for submitted apps    |

### Operations

| Method | Endpoint                                   | Purpose                            | Auth Required |
| ------ | ------------------------------------------ | ---------------------------------- | ------------- |
| GET    | `/api/admin/debug`                         | Debug info (server state overview) | Yes (admin)   |
| GET    | `/api/admin/apps/stats`                    | App statistics and counts          | Yes (admin)   |
| GET    | `/api/admin/apps/submitted`                | List apps pending review           | Yes (admin)   |
| POST   | `/api/admin/apps/:packageName/approve`     | Approve a submitted app            | Yes (admin)   |
| POST   | `/api/admin/apps/:packageName/reject`      | Reject a submitted app             | Yes (admin)   |
| GET    | `/api/admin/memory`                        | Memory diagnostics                 | Yes (admin)   |
| GET    | `/api/admin/heap-snapshot`                 | Trigger and download heap snapshot | Yes (admin)   |
| GET    | `/api/console/admin/incidents`             | List incidents (console view)      | Yes (admin)   |
| GET    | `/api/console/admin/incidents/:incidentId` | View specific incident (console)   | Yes (admin)   |

### Failure Modes

| Failure                       | Current Behavior               | Target Behavior                                   |
| ----------------------------- | ------------------------------ | ------------------------------------------------- |
| Non-admin JWT                 | 403 response                   | 403 with no detail (avoid revealing admin routes) |
| Heap snapshot on busy server  | May cause latency spike or OOM | Gate behind confirmation; limit frequency         |
| Approve/reject race condition | Last write wins                | Optimistic locking or status precondition check   |
| ADMIN_EMAILS misconfigured    | No one can access admin        | Startup validation; warn if whitelist is empty    |

---

## Infrastructure / Kubernetes

### Overview

Infrastructure endpoints serve Kubernetes probes, Prometheus metrics, and static file hosting. These endpoints have no authentication - they are expected to be called by cluster-internal components (kubelet, Prometheus scraper) or served behind CDN/ingress rules.

### Transport

| Transport | Endpoint     | Purpose                   |
| --------- | ------------ | ------------------------- |
| REST      | `/livez`     | Liveness probe            |
| REST      | `/health`    | Readiness probe           |
| REST      | `/metrics`   | Prometheus metrics export |
| REST      | `/uploads/*` | Static file serving       |

### Auth

None. These endpoints are unauthenticated by design.

| Field          | Value                                                  |
| -------------- | ------------------------------------------------------ |
| Mechanism      | None                                                   |
| Access control | Network-level only (cluster-internal or ingress rules) |
| Rate limiting  | None (trusted callers only)                            |

### Operations

| Method | Endpoint     | Purpose                                      | Auth Required | Notes                                      |
| ------ | ------------ | -------------------------------------------- | ------------- | ------------------------------------------ |
| GET    | `/livez`     | Liveness probe (is the process alive?)       | No            | Zero computation; 3-second timeout in k8s  |
| GET    | `/health`    | Readiness probe (is the server ready?)       | No            | Checks memory, active sessions, uptime     |
| GET    | `/metrics`   | Prometheus-format metrics export             | No            | Scraped by Prometheus at regular intervals |
| GET    | `/uploads/*` | Serve uploaded static files (images, assets) | No            | Served from local disk or object storage   |

### Liveness vs Readiness

- **`/livez` (liveness):** Returns 200 immediately with no computation. If this fails, Kubernetes restarts the pod. The 3-second timeout ensures the process is not completely hung.
- **`/health` (readiness):** Performs lightweight checks (memory usage, session count, process uptime). If this fails, Kubernetes removes the pod from the service load balancer but does not restart it. This allows the pod to recover from transient pressure without being killed.

### Failure Modes

| Failure                     | Current Behavior                      | Target Behavior                                       |
| --------------------------- | ------------------------------------- | ----------------------------------------------------- |
| `/livez` timeout (>3s)      | Kubernetes restarts pod               | Expected behavior; ensure handler is zero-cost        |
| `/health` reports unhealthy | Pod removed from LB; no new traffic   | Expected behavior; pod should self-recover            |
| `/metrics` scrape fails     | Gap in monitoring data                | Alert on repeated scrape failures                     |
| `/uploads/*` file not found | 404 response                          | 404 with no path traversal vulnerability              |
| Memory threshold exceeded   | `/health` returns unhealthy           | Trigger graceful degradation before OOM kill          |
| Metrics endpoint slow       | Prometheus scrape timeout; stale data | Keep metrics computation lightweight; cache if needed |

---

## Smart Glasses (Hardware Direct)

### Overview

Smart glasses can connect directly to the cloud for a small set of operations that bypass the phone relay. These are limited to button press events, photo request polling, and photo uploads. Most glasses-to-cloud communication still flows through the phone - these direct endpoints handle cases where the glasses have their own network connection (e.g., Wi-Fi) and need to interact with the cloud independently.

### Transport

| Transport | Endpoint Prefix   | Purpose                  |
| --------- | ----------------- | ------------------------ |
| REST      | `/api/hardware/*` | Hardware event reporting |
| REST      | `/api/photos/*`   | Photo upload             |

### Auth

Authentication uses a glasses-specific JWT core token. The token is provisioned to the glasses during the pairing/setup flow and identifies both the device and the associated user.

| Field        | Value                                    |
| ------------ | ---------------------------------------- |
| Mechanism    | Glasses JWT core token                   |
| Token source | Provisioned during glasses pairing/setup |
| Token scope  | Limited to hardware and photo endpoints  |
| Rotation     | Re-pairing required to rotate            |

### Operations

| Method | Endpoint                                        | Purpose                         | Auth Required |
| ------ | ----------------------------------------------- | ------------------------------- | ------------- |
| POST   | `/api/hardware/button-press`                    | Report a button press event     | Yes           |
| GET    | `/api/hardware/system-photo-request/:requestId` | Check status of a photo request | Yes           |
| POST   | `/api/photos/upload`                            | Upload a captured photo         | Yes           |

### Key Flows

**Button press:**

```
Glasses -[REST POST /api/hardware/button-press]-> Cloud -> triggers registered handler (e.g., app action)
```

**Photo capture (glasses-direct):**

```
Cloud creates photo request -> Glasses polls GET /api/hardware/system-photo-request/:requestId
Glasses captures photo -> POST /api/photos/upload -> Cloud associates photo with request
```

### Failure Modes

| Failure                      | Current Behavior                         | Target Behavior                                      |
| ---------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| Glasses JWT expired          | 401 response; glasses cannot interact    | Glasses should re-auth or signal phone to refresh    |
| Photo upload too large       | May timeout or fail with 413             | Enforce size limit; return clear error with max size |
| Button press during no Wi-Fi | Request fails silently on glasses        | Queue locally on glasses; retry when connected       |
| Photo request polling miss   | Glasses may miss a request between polls | Bounded polling interval; consider push via WS       |
| Network flap during upload   | Partial upload lost                      | Support resumable uploads or retry from start        |
| Glasses token revoked        | 401 on all requests                      | Glasses should fall back to phone relay path         |
