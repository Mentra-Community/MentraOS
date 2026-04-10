# Cloud Plan — Overview

**Last updated:** April 8, 2026

The cloud is the backend that connects smart glasses, phones, and third-party mini apps. It handles WebSocket connections, UDP audio streaming, speech-to-text transcription (via Soniox), photo capture, app lifecycle, and the SDK that developers build against. Every live captions user on G1, G2, or Mentra Live depends on the cloud being stable and fast.

## Regions

- **US Central** — active, handling all US production traffic
- **France** — active
- **East Asia** — active
- **US West** — deployed, not yet receiving traffic
- **US East** — deployed, not yet receiving traffic
- **China** — WIP

New load balancer (`api.mentraglass.com`) is set up but had property issues in Porter. Still using the old load balancer. Need to verify the new LB is fully working before the next mobile client release.

## Stability

Cloud is significantly more stable. Crashes went from ~6-7/day in March to rare/occasional. Major root causes found and fixed:

- ✅ Timer leaks pinning disposed sessions in memory (OOM root cause)
- ✅ Hot-path allocation causing JSC heap fragmentation
- ✅ @logtail/pino transport causing heap growth — replaced with Vector
- ✅ Unhandled promise rejections crashing the process
- ✅ ResourceTracker throw on disposed session
- ✅ BetterStack log volume spike (significant daily cost) — duplicate collector fixed
- ✅ Dashboard and captions excessive log output cleaned up

Still happening:

- ⚠️ Occasional crashes on US Central — needs investigation
- ⚠️ Heap objects still grow over time, root cause not fully pinned down
- ⚠️ Memory leak investigation (077, 078) on hold until signal quality is tightened

## SDK

- v3 alpha.2 published to npm
- Cloud v3 branch merged (PR #2326)
- v3 fixes critical transcription/reconnection bugs
- Next step: thoroughly test every v3 API before promoting to stable

## Load

- Mentra Live units actively shipping
- Cloud is under real production load
- All US traffic hitting a single region (US Central)

## Sections

- **[Recently Shipped](./shipped.md)** — what landed recently
- **[Work](./work.md)** — who's working on what, planned work, and backlog
- **[OKRs](./okrs.md)** — Q2 2026 department objectives and key results
- **[Scaling Plan](./plans/cloud-scaling.md)** — multi-region, stateless cloud, horizontal scaling
- **[Testing](./testing/testing-plan.md)** — E2E testing, test harness, CI, client coverage
- **[Puddle Architecture](./plans/puddle-architecture.md)** — local mobile mini-app SDK proposal

---

[Next: Recently Shipped →](./shipped.md)
