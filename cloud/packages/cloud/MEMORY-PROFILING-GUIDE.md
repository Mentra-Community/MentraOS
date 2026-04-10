# Cloud-Prod Memory Leak Investigation Guide

## The Problem

cloud-prod OOM-crashes every ~3-4 hours. RSS grows at ~2 MB/min regardless of session count. Pod has 4GB RAM limit, 1 instance, so every crash = full downtime (46 incidents in 7 days).

### What we know so far

- Memory grows linearly even with stable session count (~60-100 sessions)
- GC can't reclaim: probes show "freed 0MB" after 178ms GC runs
- `disposedSessionsPendingGC` always 4-7 (disposed sessions not getting collected)
- Audio buffers are NOT the leak (confirmed 0 bytes in live profiling)
- Transcript segments grow but plateau (30-min retention)
- 33% of RSS is "unaccounted" (JIT, GC metadata, fragmentation)
- Slow MongoDB queries in logs are NOT actually slow — Atlas confirms <1ms. The measured time includes event loop stall from GC pressure.

## Profiling Tools (already built)

All tools are in `cloud/packages/cloud/src/scripts/analyze-heap.ts`. Requires `MENTRA_ADMIN_JWT` env var (any Mentra admin's JWT from the auth flow, signed with `AUGMENTOS_AUTH_JWT_SECRET`).

### 1. Live Memory Tracker (best starting point)

Polls `/api/admin/memory/now` every N seconds, shows per-session memory breakdown:

```bash
cd cloud
export MENTRA_ADMIN_JWT="eyJ..."

# Track for 30 minutes, poll every 30s
bun ./packages/cloud/src/scripts/analyze-heap.ts live --host=uscentralapi.mentra.glass --interval=30 --duration=1800

# Track other regions
bun ./packages/cloud/src/scripts/analyze-heap.ts live --host=franceapi.mentra.glass
```

Shows: RSS, heap, external, ArrayBuffers, session count, audio buffers, VAD buffers, transcript segments, mic count, per-session deltas. Estimates time-to-crash.

### 2. Heap Snapshot (for object-level analysis)

```bash
# Fetch Bun/JSC heap snapshot
curl -s -H "Authorization: Bearer $MENTRA_ADMIN_JWT" \
  https://uscentralapi.mentra.glass/api/admin/memory/heap-snapshot-bun \
  -o snapshot.heapsnapshot
```

**Open in Safari** (not Chrome) — Safari Web Inspector understands JSC format natively:

- Safari → Develop → Import Recording → select the .heapsnapshot file
- Shows retained sizes, dominator tree, allocation details

For a diff, take two snapshots 10+ minutes apart and compare in Safari.

You can also analyze via CLI:

```bash
bun ./packages/cloud/src/scripts/analyze-heap.ts snapshot --file=snapshot.heapsnapshot
```

### 3. Compare Mode (session-level diff)

Takes two `/api/admin/memory/now` snapshots N seconds apart, diffs per-session stats:

```bash
# 5 minute gap between snapshots
bun ./packages/cloud/src/scripts/analyze-heap.ts compare --host=uscentralapi.mentra.glass --delay=300
```

Shows which sessions grew in audio/VAD/segments/apps between snapshots.

### 4. Admin Endpoints (manual)

```bash
# Quick memory snapshot with per-session breakdown
curl -s -H "Authorization: Bearer $MENTRA_ADMIN_JWT" \
  https://uscentralapi.mentra.glass/api/admin/memory/now | jq .

# Health check (memory stats, event loop lag, session count)
curl -s https://uscentralapi.mentra.glass/health | jq .
```

## Key Files

| File                                           | What it does                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/services/session/UserSession.ts`          | Session lifecycle, static `sessions` Map, `dispose()` at line 764             |
| `src/services/debug/MemoryLeakDetector.ts`     | FinalizationRegistry-based leak detection, tracks `disposedSessionsPendingGC` |
| `src/services/debug/MemoryTelemetryService.ts` | Per-session memory stats (enable with `MEMORY_TELEMETRY_ENABLED=true`)        |
| `src/services/metrics/SystemVitalsLogger.ts`   | 30s vitals (heap, RSS, sessions, mongo stats, GC probes)                      |
| `src/connections/mongodb.connection.ts`        | Slow query plugin (`MONGOOSE_SLOW_QUERY_MS` env var, default 0 = disabled)    |
| `src/scripts/analyze-heap.ts`                  | All the profiling tools above                                                 |

## What to investigate

1. **Take heap snapshots in Safari** — two snapshots 10-15 min apart, compare what object types grew. Sort by retained size delta.

2. **Check what holds references to disposed sessions** — `disposedSessionsPendingGC` never reaches 0. Something is preventing GC from collecting disposed UserSession objects. Look for:
   - Closures in WebSocket handlers referencing the session
   - Pino child logger chains (each session creates many)
   - Mongoose document caches
   - ResourceTracker holding stale references after `dispose()`

3. **Enable memory telemetry** — set `MEMORY_TELEMETRY_ENABLED=true` in the pod env to get per-session memory breakdowns in logs every 10 minutes.

4. **Profile Bun runtime overhead** — 33% of RSS is unaccounted for (JIT, GC metadata). This may be Bun-specific fragmentation that grows with session create/destroy cycles. Compare with a long-running session that doesn't churn.

## Quick Wins (can deploy now)

- **Scale to 2+ instances** — eliminates full downtime during crashes (rolling restart)
- **Add memory-based readiness check** — `/health` currently doesn't 503 on high memory. Add a threshold (e.g., RSS > 3.5GB → 503) so Kubernetes stops routing traffic before OOM
- **Raise `MONGOOSE_SLOW_QUERY_MS`** — if set low in prod env group, it generates 1.5M warn logs/day that waste memory. Set to 500+ or 0 to disable.
