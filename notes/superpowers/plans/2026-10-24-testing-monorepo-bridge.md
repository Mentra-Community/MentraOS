---
status: active
owner: Philippe
---

# Testing migration code plan

Spec: [Testing monorepo bridge](../specs/2026-10-24-testing-monorepo-bridge.md).

- [x] Implement the old-default repository selector and compatible stored schemas.
- [x] Preserve original Actions, source, workspace and dependency identities.
- [x] Implement monotonic publication versions and the committed lineage edge.
- [x] Validate legacy and monorepo source, enrollment and workspace paths locally.
- [ ] Complete required CI and independent review; correct known defects.
- [ ] Deploy compatibility code while the selector remains on the legacy target.
- [ ] Publish and install the coordinated bridge before the final import.
- [ ] Retain frozen legacy Git history in the monorepo and new checkouts.
- [ ] Verify the first normal monorepo publication and installed acceptance.
- [ ] Activate the new repository and trusted workflow together.
- [ ] Verify resource readiness, same-job fallback and full device rehearsals.
- [ ] Archive the legacy repository after the new path is verified.

Code validation, CI, publication, installation and device qualification are
separate milestones. One publisher is active at each stage. Original jobs,
deadlines and unknown resource custody remain unchanged throughout the move.
