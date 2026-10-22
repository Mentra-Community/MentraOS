---
status: completed
owner: Philippe
---

# Consolidate Core admission predicates

This bounded mechanical refactor implements the authorized all-resource lifecycle
plan in `2026-10-20-all-resource-lifecycle.md` on approved Core4898 `c3cdf842`.
It introduces no API, schema, scheduling policy, claim or state-machine changes.

1. Keep the existing readiness checks in their original order, expose their first
   structured blocker, and retain boolean wrappers for current callers.
2. Share the required-resource traversal used by routing and ordinary reservation;
   keep their different explicit candidate exceptions at the existing callers.
3. Move exact platform/capability/backend/permission/storage/glasses compatibility
   into a pure helper, preserving its boolean compatibility entry point.
4. Preserve every await, clock sample, deadline, host/request CAS, cancellation,
   preparation and return sequence in the two service implementations.
5. Run existing admission, candidate, offline, freshness, cancellation and resource
   control suites with pinned Bun1.3.14 plus the existing source-mapped Core types.
6. Commit for independent integration/review. Publication and device validation
   remain separate and owned by the coordinating chat.

Validation: 483 existing tests / 3504 assertions across nine files passed with
pinned Bun1.3.14. The full source-mapped Core TypeScript5.9.3 envelope passed.
No admission effect/await/CAS/return ordering changed; no device work performed.
