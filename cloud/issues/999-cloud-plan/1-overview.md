# Cloud Plan — Overview

**Last updated:** April 2, 2026

The cloud is the backend that connects smart glasses, phones, and third-party mini apps. It handles WebSocket connections, UDP audio streaming, speech-to-text transcription (via Soniox), photo capture, app lifecycle, and the SDK that developers build against. Every live captions user on G1, G2, or Mentra Live depends on the cloud being stable and fast.

## Regions

- **US Central** — active, handling all US production traffic (~60-75 sessions)
- **France** — active (~16-18 sessions)
- **East Asia** — active (~3-4 sessions)
- **US West** — deployed, not receiving traffic (client still points to old load balancer)
- **US East** — deployed, not receiving traffic (same reason)
- **China** — WIP

## Stability

Crashes down significantly from ~6-7/day peak in March. Major root causes found and fixed:

- ✅ Timer leaks pinning disposed sessions in memory (OOM root cause)
- ✅ Hot-path allocation causing JSC heap fragmentation
- ✅ @logtail/pino transport causing heap growth — replaced with Vector
- ✅ Unhandled promise rejections crashing the process
- ✅ ResourceTracker throw on disposed session

Still happening:

- ⚠️ ~3 crashes/day on US Central from residual heap growth
- ⚠️ `disposedSessionsPendingGC` creeping back to 7-10 — more timer/closure leaks remain
- ⚠️ Heap objects grow ~1M/hr, eventually triggering GC death spiral → SIGKILL

## SDK

- v3 runtime built on branch `cloud/issues-048` (PR #2326)
- v2 published as `@mentra/sdk@latest`
- v3 prerelease at `3.0.0-hono.8`
- v3 fixes critical transcription bugs — needs to ship ASAP

## Load

- 1,000 Mentra Live units shipped
- Cloud is under real production load
- All US traffic hitting a single region (US Central)

## Cost Alert

BetterStack log ingestion spiked to **449 GB/day** on April 2:

- Dashboard MiniApp stdout: 241 GB (54%)
- Captions MiniApp stdout: 83 GB (19%)
- Cloud itself: 20 GB (5%) — normal
- Cause: BetterStack default collector on US Central collecting all container stdout without filtering. Our custom Vector Helm chart only collects cloud containers but the default collector is also running alongside it.

## Sections

- **[Recently Shipped](./2-shipped.md)** What landed in the last 2 weeks
- **[Tickets](./3-tickets.md)** Who's working on what right now
- **[Backlog](./4-backlog.md)** Unassigned future work, big projects link to their own plans

---

[Next: Recently Shipped →](./2-shipped.md)
