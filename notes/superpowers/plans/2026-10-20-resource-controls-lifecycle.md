---
status: active
owner: Philippe Ferreira de Sousa
---

# Resource controls implementation plan

Spec: [Resource controls lifecycle](../specs/2026-10-20-resource-controls-lifecycle.md).

- [x] Add resource-subject command/view schemas through the existing exchange and preserve legacy lane consumers.
- [x] Validate current canonical authority, local subject generation, runtime support, operator reservation ownership, bounded history and immutable acknowledgements.
- [x] Fence new controls against exact authenticated report/claim versions and new shared claims against the same control version.
- [x] Accept independent canonical ResourceRefs without lane fiction; preserve claim timestamps and unknown custody.
- [x] Add lazy resource-card controls, immutable browser intent recovery, and explicit manual restoration wording.
- [x] Add nightly original machine/lane/resource context with unknown/corrupt evidence handled explicitly.
- [x] Add source regressions for shared Google identity, canonical unknown ownership overriding local idle flags, competing controls/claims, lost responses and unchanged lane compatibility.
- [ ] Complete paired installed ResourceProvider commissioning and raw cleanup/check integration under the existing lifecycle.
- [ ] Finish independent source challenge, canonical exact-head review, and normal CI for the Core/UI descendant.
- [ ] Integrate the actual containing Core/Harness bases and renew changed-head gates where necessary.
- [ ] Publish normally and verify authentic installed source/contracts/provider support before operator controls.
- [ ] Qualify real resource setup/check/return on its owner machine; preserve every unknown or failed outcome.

The separate pre-binding phone fallback PR remains independently gated. No source preparation pauses healthy lanes or changes live custody.
