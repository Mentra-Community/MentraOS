---
status: active
owner: Philippe / testing framework coordination
---

# Shared test resources implementation

Spec: [Shared resources in the existing lane reservation system](../specs/2026-10-15-shared-test-resource-reservations.md).

Order: conference Google account across hosts, then Air 3's shared physical glasses. Keep this work separate from the existing capacity and quiet-room PRs. No live commissioning or false resource offers are authorized by source alone.

## In progress: source design and entry-path inventory

- [x] Verify canonical local resource allocation, cleanup dependency retention, stale-generation fences and two-connection exclusion.
- [x] Verify the cross-host account has no current exclusion authority and `account: 'lane'` does not supply it.
- [x] Select the existing Core host `resourceReservations`/version CAS as authority; no separate collection or lock store.
- [x] Record profile-publication shared-device rejection and single selected glasses provider assumptions.
- [x] Record exact release/cancellation/repair proof and no expiry-only reclamation.
- [ ] Review the exclusive dependency shape and claim union against merged PR4792 before code changes to its authority path.

## Implement Google account authority

- [ ] Add bounded typed exclusive dependency metadata on the current resource offer and selected request/grant. Bind opaque identity to the actual configured private account, not a file hash or routine-name special case.
- [ ] Extend the existing host claim union and CAS to acquire one owner across borrower hosts. Preserve unchanged recorder-byte claims and conservative orphan reconciliation.
- [ ] Freeze selected claim on the existing request; propagate it through Core delivery, controller local transaction and the current operation journal.
- [ ] Enforce claimed dependency at credential use and native setup. Cover automatic/manual/PR/linked requests, authoring completion candidates, held reservations, local/operator submissions and permission commissioning. Refuse fleet dependencies offline.
- [ ] Publish authenticated clean release proof from the normal local resource lifecycle; retain claims through cancellation, failed cleanup and fixer halt/restart. Close or restore the Google product session before releasing it, not only its browser.
- [ ] Add actual concurrency/CAS-loser/restart/cancel-before-acceptance/failed-teardown/stale-generation tests, including normal return while evidence upload continues.
- [ ] Independently review exact heads, deploy Core first and then safe idle Harness/API acceptance, drain previous shared account sessions, then commission the explicit account dependency on each host.
- [ ] Prove two-host contention and complete ordinary Google success/publication/cleanup/next-owner return.

## Implement Air 3 sharing after identity/provider inventory

- [ ] Root commissions real Air 3 host/lane/phone and discovers NIMO/G2 device/driver identities. Keep offers absent while unavailable.
- [ ] Allow an explicit same-host canonical shared physical binding in profile validation and a finite drained enrollment; accidental duplicates and conflicting identities remain refused.
- [ ] Preserve one local resource row for each pair across both lanes and exact provider selection by lane plus frozen resource ID.
- [ ] If both pairs must be simultaneously offered as alternatives, extend only inventory selection to bounded alternatives; retain one concrete execution provider and immutable selected software/build requirements.
- [ ] Prove one pair excludes the other lane while the second pair remains independently usable, with cancellation/repair/return and actual complete recorded passes.

## Related existing gap, separate owner

Captions PR1006's ordinary candidate failed before execution after its held selected-app microphone qualification was cleared/expired at normal return. The existing candidate path does not arrange a fresh qualification target before `acceptExecutable`. This must be fixed through the current selected-app qualification/journal flow, not by dropping microphone permission or fabricating a retained grant. It is independently required for the ordinary candidate path and should not be hidden inside a generic exclusive-account implementation.
