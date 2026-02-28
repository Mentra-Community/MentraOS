# RTMP Streaming Convergence Plan

## Goals

- Deliver a single streaming lifecycle that powers both managed (Cloudflare-backed) and unmanaged (direct RTMP) sessions without altering the SDK/API surface.
- Preserve existing managed-stream robustness while eliminating drift and state inconsistencies in unmanaged streams.
- Reduce duplicated logic across `UnmanagedStreamingExtension`, `ManagedStreamingExtension`, and `StreamRegistry` by introducing shared core components.
- Ensure the phone ↔ glasses protocol remains unchanged; all convergence happens inside the cloud stack.

## Architectural Tenets

- **Single Source of Truth**: Stream metadata, lifecycle state, timers, and ownership live in one per-session registry.
- **Composable Lifecycle**: Keep-alive scheduling, ACK tracking, websocket grace handling, and timeout resolution sit in a reusable controller invoked by both managed and unmanaged flows.
- **Adapters, Not Forks**: Managed-specific behavior (Cloudflare provisioning, multi-viewer fan-out) and unmanaged behavior (single viewer, raw RTMP URL) plug into the shared core via thin adapters.
- **Event-Driven Updates**: Lifecycle emits events consumed by adapters to notify apps, broadcast statuses, and execute cleanup.
- **Testability**: Unit-testable lifecycle/controller with fakes for websocket and timer surfaces, plus integration tests for regression scenarios (e.g. socket loss mid-stream).

## Target Components

| Component                     | Responsibility                                                                                                                           | Notes                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `StreamRegistry`              | Track per-stream records (managed/unmanaged) and expose CRUD, status updates, socket state transitions, metrics                          | Replaces the current `StreamStateManager` (managed) _and_ the legacy unmanaged stream map   |
| `StreamLifecycleController`   | Encapsulate keep-alive scheduling, ACK bookkeeping, timeout/grace-period logic, and event emission                                       | Accepts config (ACK timeout, retry budget) so managed/unmanaged differences are data-driven |
| `UnmanagedStreamingExtension` | Validate app requests, talk to registry, orchestrate cloud→glasses commands, deliver app/websocket notifications                         | Replaces the legacy VideoManager implementation                                             |
| `ManagedStreamAdapter`        | Provision Cloudflare (via existing service), manage viewers/restream outputs, consume lifecycle events                                   | Evolution of `ManagedStreamingExtension`; inherits registry/lifecycle dependencies          |
| `StreamEvents`                | Typed event bus or callback hooks (e.g. `onStatusChange`, `onTimeout`, `onAckMissed`, `onCleanup`) propagated from lifecycle to adapters | Enables adapters to remain stateless where possible                                         |

## Migration Phases

### Phase 0 – Baseline & Safeguards

- Capture current behaviors for regression guardrails:
  - Enumerate expected status transitions (initializing → streaming → stopped/error) for managed/unmanaged.
- Log when unmanaged streams currently leak (to validate fix later).
  - Add lightweight integration tests (or harness scripts) for: successful start/stop, keep-alive timeout, websocket disconnect.
- Freeze SDK message schema; confirm no client changes required.

### Phase 1 – Registry Extraction

- Move `StreamStateManager` into `UserSession` as `StreamRegistry` (rename + tighten API).
- Update `ManagedStreamingExtension` to accept the shared registry instance instead of creating its own.
- Introduce `StreamRegistry` while leaving the legacy unmanaged implementation in place for initial wiring.
- Deliver unit tests covering registry core operations (create/remove/update, conflict detection).

### Phase 2 – Lifecycle Controller (Managed First)

- Extract current managed keep-alive logic into `StreamLifecycleController` while leaving public behavior untouched.
  - Support start/stop, send keep-alive, handle ack, mark websocket down, trigger timeout.
  - Inject timers via abstractions to enable tests.
- Wire managed adapter to construct a lifecycle per active stream through the registry.
- Ensure existing Cloudflare cleanup + viewer notifications hook into lifecycle events (e.g. `onTimeout`, `onStopped`).
- Validate with managed streaming regression tests.

### Phase 3 – Unmanaged Adoption

- Replace the legacy unmanaged streaming code with registry-backed lifecycle controllers.
  - On `RTMP_STREAM_REQUEST`, create record, start lifecycle, send `START_RTMP_STREAM`.
  - On status updates, delegate to lifecycle and drive `StreamEvents` to notify apps.
  - On `STOP` or fatal error, stop lifecycle and remove record.
- Implement websocket disconnect grace handling using lifecycle (configurable timeouts consistent with managed behavior).
- Remove legacy keep-alive code from the unmanaged adapter once parity is verified.

### Phase 4 – Unified Message Routing

- Update `websocket-glasses.service` to route `RTMP_STREAM_STATUS` and `KEEP_ALIVE_ACK` through registry/lifecycle first, falling back only if no matching stream.
- Ensure adapters respond to lifecycle events instead of parsing messages directly.
- Harmonize keep-alive interval/ACK timeout constants across managed/unmanaged via configuration.

### Phase 5 – Cleanup & Observability

- Delete deprecated state containers (`activeSessionStreams`, standalone managed keep-alive maps).
- Consolidate metrics APIs (e.g. `getStats`, `getManagedStreamViewers`) under registry.
- Instrument lifecycle with structured logs and counters (missed ACKs, socket-down recoveries).
- Document architecture in `docs/cloud-architecture`.

## Detailed Task Breakdown

### Registry & Lifecycle Foundations

1. Define `StreamRecord` type union (managed/unmanaged fields).
2. Implement `StreamRegistry` with CRUD, conflict detection, socket state tracking.
3. Implement `StreamLifecycleController` with pluggable config and event callbacks.
4. Provide fakeable timer interface to enable deterministic tests.
5. Write comprehensive unit tests (lifecycle transitions, ack handling, timeout).

### Managed Adapter Refactor

1. Inject registry + lifecycle into `ManagedStreamingExtension`.
2. Replace inline keep-alive maps with lifecycle instances.
3. Adapt Cloudflare cleanup to registry removal events.
4. Ensure viewer-add/remove still works via registry state.
5. Regression test managed flows (including restream destinations).

### Unmanaged Adapter Refactor

1. Finalize the renamed `UnmanagedStreamingExtension` using registry + lifecycle.
2. Migrate start/stop logic to operate on registry records.
3. Rewire status broadcasts to respond to lifecycle events.
4. Implement socket-down grace timer (config via lifecycle config).
5. Validate no change to app-facing messages.

### Message Routing & Cleanup

1. Update websocket service to look up stream records before dispatching.
2. Remove duplicated ACK handling from the unmanaged adapter.
3. Delete legacy managed keep-alive structures.
4. Re-run integration scenarios (socket loss, reconnection, managed/unmanaged concurrency).

## Risks & Mitigations

- **Regression in Managed Streams**: Introduce lifecycle controller behind feature flag for managed path first; keep existing logic until tests pass.
- **Timer Drift / Resource Leaks**: Centralize timer creation with cleanup on lifecycle stop; monitor with metrics after rollout.
- **State Desync During Migration**: Until the unmanaged adapter fully migrates, guard shared registry access with type-specific namespaces or feature flags.
- **Grace Period Behavior**: Document desired timeout semantics and add integration tests covering disconnect/reconnect windows.

## Success Criteria

- A glasses disconnect no longer leaves unmanaged streams stuck in `active` state; registry reports zero active streams after lifecycle timeout.
- Managed streaming behavior (Cloudflare provisioning, viewer notifications) is unchanged per regression tests.
- Unified code paths reduce duplication and clarify ownership (one registry, one lifecycle controller).
- Documentation reflects the new architecture and engineers can add features without touching two diverging systems.

## Decisions & Assumptions

- **Grace Period**: Mirror current managed semantics—timeout is driven by missed ACK thresholds; no additional grace delay beyond what managed uses today. If we revise managed behavior later, the lifecycle controller should inherit that change.
- **Analytics**: Lifecycle events will be logged through the existing logger infrastructure; no Posthog integration in this iteration.
- **Single Stream Constraint**: The registry enforces exactly one active stream per user (either managed or unmanaged). Cloudflare restreaming still originates from the single glasses stream, so multi-stream scenarios are out of scope.
