---
status: completed
owner: philippe
---

# Public coordinated routine adapter

Spec: [Coordinated dev/staging device requests](../../specs/2026-09-23-coordinated-routine-requests.md).

- [x] Agree schema2 source and unchanged PR schema with the private worker owner.
- [x] Resolve exact successful coordinated run/attempt, ancestry and published files.
- [x] Reuse the trusted callback and per-source automatic generation fence.
- [x] Add pending-state and exact-build links to existing dev/staging Slack posts.
- [x] Test metadata mismatches, trust boundaries, historical selection and reruns.
- [x] Validate affected workflow YAML; retain private/admin integration gates in spec.

Completion here covers local public implementation and offline validation only.
Deployment, private adapter enablement, hardware qualification and staging
verification are outside this completed implementation plan.
