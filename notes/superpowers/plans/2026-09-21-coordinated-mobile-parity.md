---
status: active
owner: PhilippeFerreiraDeSousa
---

# Coordinated mobile parity implementation

Spec: ../specs/2026-09-21-coordinated-mobile-parity.md

- [x] Inspect current dev/staging workflows and PR artifacts.
- [ ] PR 1: native compilation reuse, signing preflight/retry, concurrent Cloud scheduling.
- [ ] Qualify cold/warm builds and measure actual avoided compiler work.
- [ ] PR 2: registered-device iPhone/Mac exports, immutable receipts, installation pages and Slack rows.
- [ ] Verify both release channels and final downloadable artifacts.

Baseline: staging run 35674563963 Android 17m50s, iOS 28m38s; dev run 35673545946 Android 18m15s, iOS 39m55s. These include build-job setup; TestFlight processing is additional.

The primary checkout contains unrelated untracked account key files and is untouched. Work is isolated under coordinated-mobile-parity.
