# `session.dashboard`

Dashboard widget surface for miniapps.

> **Deferred in v1.** The cloud `DashboardManager` owns
> widget rendering in OS-ranked rotation. The API shape is preserved so
> miniapps compile, but calls currently noop on the phone side. The first
> call from a given module logs a one-shot `console.warn` and the request
> is still forwarded so the host can log/ignore consistently.

Source: [mobile/modules/miniapp/src/modules/dashboard.ts](../../mobile/modules/miniapp/src/modules/dashboard.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

// Compiles and forwards — but is a noop on the phone in v1.
session.dashboard.setContent("main", "Hello dashboard")
```

---

## API

### `setContent(mode, content)` — `void`

**Deferred in v1.** Logs a `console.warn` on the first call per instance,
then forwards a `DASHBOARD_CONTENT_UPDATE` one-shot to the phone so it can
log/ignore consistently. No ack; no observable effect on the glasses
display today.

**Parameters:**
- `mode: DashboardMode` — which dashboard slot the content targets.
- `content: string` — the content payload (format is reserved for the
  eventual implementation).

```ts
type DashboardMode = "main" | "expanded" | "always_on"
```

---

## Errors

This module raises no errors in v1 — all calls are fire-and-forget noops
and the host does not respond.

---

## Wire-level reference

For host implementors — request/response message types this module emits:

| Method | Request type | Response |
| --- | --- | --- |
| `setContent` | `DASHBOARD_CONTENT_UPDATE` (`{mode, content}`, one-shot) | — |

This module subscribes to no streams.

---

## Tests

_no integration tests yet_
