---
status: active
owner: Philippe Ferreira de Sousa
---

# Resource controls in the existing reservable lifecycle

System Health controls address the canonical resource and its authority host. A resource may belong to one lane, several lanes, or an authority-owned independent catalog. Lane memberships describe placement; they do not create another resource or confer authority.

Reuse the existing LaneControls authenticated exchange and host-row CAS for `reserve`, `release`, `check`, and `mark-out-of-service`. Preserve legacy lane commands. Every resource command includes its immutable operation ID, signed-in operator identity, canonical host, resource ID, expected subject generation, and finite delivery expiry. Delivery is pending until the installed controller accepts an exact receipt. A waiting reservation prevents conflicting new assignment but never takes an existing or unknown owner. Release remains returning until the existing owned cleanup and fresh baseline settle. Only the reservation's operator can request release.

New command CAS binds the exact current authenticated host observation and resource-claim version. New canonical dependency claims bind the control version on the same host row, including after the installed capability disappears. Retained operator reservations and unfinished checks continue to prevent conflicting claims after rollback or delivery expiry; a missing capability cannot erase custody. A competing claim or controller report forces a fresh read before acceptance. Retained original operation lookup and controller acknowledgement remain observable after expiry; they cannot create another effect.

Marking out of service withdraws future allocation and retains current custody. The canonical reason is `resource-operator-out-of-service`. An explicit operator Check against that exact marked subject generation retains the original marker identity in the installed lifecycle journal. It may clear only that manual marker after a passed baseline and authentic raw-work settlement. Background refresh, unrelated checks, failed or unknown checks, and repair do not re-enable the resource. The UI labels this explicit action **Check and return to service** only for that canonical reason.

The existing resource provider owns prepare, baseline check, cleanup, and reconciliation. Missing commissioning or provider support remains unavailable. A whole-resource baseline is separate from app-specific phone connectivity proof; neither can refresh the other's observation. New assignment requires current readiness and unchanged custody, with failed checks using existing repair.

Independent resources are optional bounded ResourceRefs on the authenticated host snapshot, with no invented lane ID and no duplicate lane membership. The Google account catalog has one canonical authority. Its installed checker must verify the private credential pin, account binding hash, original provider identity, no retained canonical claim, and raw-work return. This credential/custody baseline does not prove a Google login or remote service availability. An unenrolled or unsupported checker remains unqualified.

The Resources page loads controls only for the expanded resource card. Buttons require current supported actions and subject generation; release requires the signed-in operator's exact active reservation. The browser preserves the immutable input after a lost response and reconciles that operation, rather than creating a replacement. Nightly member text uses validated original assignment and resource requirements, with explicit unassigned/unknown evidence.

Source tests and reviews do not establish installed provider acceptance or hardware readiness. Normal paired publication and authentic host acceptance precede any live controls.
