---
status: draft
owner: Philippe / testing framework coordination
---

# Shared resources in the existing lane reservation system

## Result

A resource offered by several lanes has one canonical identity and can belong to only one active execution at a time. A lane is a place where a job runs; it is not evidence that every offered account or physical device is dedicated to that lane.

The immediate cases are the conference Google SSO account across the fleet and the NIMO and G2 glasses pairs shared by Air 3's Android and Mac lanes. Keep the existing typed requirements, offers, grants, owner generations, operation journal, cleanup and repair flow. Do not add a second resource registry, independent lock service, credential store or parallel scheduler.

This proposal is source design, not deployed qualification. No NIMO/G2 serial, model protocol, Bluetooth address, firmware manifest or tested capability has been discovered by this work. The examples below describe identity relationships; they are not commissioned device offers.

## What the current source already does

At Harness `2a4503ba` (capacity PR1007 and permissions PR1008 merged):

* `orchestration/storage/lanes.ts:242` allocates the lane and canonical resource rows in one SQLite transaction. `resources.resource_id` is a primary key. A second lane cannot allocate the same row while it has an owner; `orchestration/storage/store.test.ts:90` already exercises two SQLite connections against one host database.
* `lanes.ts:706` retains unresolved resources and their dependencies until executor cessation and successful cleanup. Fixer handoff changes authority generation without releasing the physical resource. This is the lifecycle to preserve.
* `storage/types.ts:30` accepts the same physical glasses identity across lanes when canonical resource ID, device ID and model agree. However, `host/provisioning/machine-profile.ts:91` rejects every repeated physical assignment, and additive inventory forbids adding a lane to an existing resource. Publication and controlled commissioning must be made consistent with the local allocator.
* Each lane currently exposes one provider per resource kind and at most one glasses alternative. Native provider selection also assumes one configured glasses binding per lane. Advertising two pairs requires explicit selection, not a fabricated duplicate provider.
* Google credentials are private pinned fixture data. `account: 'lane'` is a credential selection convention, not a fleet lease. Four separate host SQLite databases cannot exclude each other.
* Merged Core PR4792 (`251383270d19ca1d174dc3f724e8fd39cd001bd5`) extends the existing `test_host_state.resourceReservations` and `resourceReservationVersion` with a CAS-fenced capacity claim and records its receipt on the existing request. This supplies the authority mechanism to extend; the current claims are host byte reservations, not cross-host account exclusion.

The separate product audit proves Runtime currently supersedes a previous connection for the same account. Scheduling the shared conference account exclusively avoids test interference while that product behavior exists. It does not implement independent simultaneous product sessions.

## Identity and typed declarations

Retain existing kinds. Google is a dependency of `fixture-data` with `google-authentication`; glasses remain `glasses`. Introduce one typed **exclusive dependency reference** on existing offers, with a canonical opaque ID, authority host and the capability whose use requires it. This extends resource metadata, not the kind registry. Commissioning binds an account identity to that opaque ID privately; do not use passwords, token hashes or local file paths as public identities.

The account dependency applies only when the selected requirement uses Google authentication. A generic fixture-data consumer must not reserve the conference account merely because its provider also has that credential configured. Credential-file hashes still verify private bytes and do not establish reservation identity. All routines and authoring operations that actually enter this account must acquire the same dependency, including any retained session that remains active after a provider window closes.

For Air 3, the same real pair has the same resource ID, device identity and model in both lane offers. Do not duplicate its ID with a lane suffix. Each pair is independent of the other pair. Keep portable routine model alternatives; at binding select exactly one concrete pair that meets the requirements, then freeze its identity in the existing run input/grant. Routine context still receives one glasses provider. Admission must reject mismatched IDs, conflicting physical identities or multiple selected pairs.

The one-provider-per-kind rule remains for actual execution. Inventory may list bounded glasses alternatives. Native configuration lookup must select by **lane plus the frozen resource ID**, never first matching lane or a routine name. No NIMO/G2 provider capabilities may be advertised until its actual driver, identity, cleanup and build/software requirements are supported and qualified. Initial commissioning can safely enroll one proved pair per lane before the alternative-pool extension is ready.

## Authority and acquisition

For a shared resource within one host, the existing local `resources` row is the exclusion authority. Allow a canonical shared binding in the version-controlled profile only when every lane describes exactly the same physical device and provider identity; continue rejecting accidental duplicate phones, IDs and incompatible bindings.

For an exclusive dependency shared across hosts, designate one existing enrolled host's Core resource-reservation row as the stable authority in the version-controlled binding. For the conference account, this can be the already enrolled Mini's row. This is a CAS anchor; it is not a requirement that the account's file exists only on the Mini. No synthetic host row or separate collection is needed. Authority changes require a finite drained commissioning change, not automatic reassignment when a host is offline.

Extend the existing reservation union and request receipt with an exclusive claim containing: canonical resource ID, claim ID, authority host, borrower host/lane, immutable job or reservation identity, input digest, controller incarnation, owner generation and state. The Core row is authoritative; request and host-journal receipts are fenced evidence of that claim, not independently mutable owners. Preserve storage byte claims as a distinct typed union member, with their existing budget logic.

Acquire every required dependency before a job becomes executable or a held authoring operation begins native setup. A bare lane reservation carries no authority to use an undeclared shared capability; it must bind the operation’s requirements before that boundary. Automatic dispatch, linked reruns, PR checks, held authoring, local/operator submissions and permission commissioning must converge on this boundary. Matching an Actions label or seeing an idle lane is not acquisition. A local offline grant must refuse a fleet dependency if Core cannot confirm its claim. Jobs not using fleet dependencies retain the existing local flow.

The initial implementation admits dependencies belonging to one authority row per operation, so its existing CAS acquires all required keys atomically. Multiple keys on that authority are supported; cross-authority requirements fail before acquisition rather than leaving a partial set. CAS losers retain no executable authority. A crash between Core acquisition and local binding keeps the unchanged claim until a recorded reconciliation proves that it never became executable or completed normal cleanup. No lease expires an active account by wall clock.

The final controller admission transaction rechecks the cloud claim, owner generation and its exact selected resource binding. The portable claim retains its original input digest; a separate immutable receipt maps it to the later executable digest. Core commits the winning claim on the existing authority host row, then the existing staged request adopts it. This uses the existing single-record CAS mechanism rather than a cross-collection transaction, preserving the supported Cosmos Mongo RU constraint. A lost request-receipt write cannot create a second exclusive owner. Refreshes and retries return the same claim receipt. They must not issue a new owner for the same accepted input.

## Return, cancellation and repair

* **Successful routine or authoring return:** settle native operations, restore the requested baseline, stop/sign out the temporary Google session and close its owned browser, then commit the normal local release. Publish an authenticated release receipt fenced to the original claim and subsequent host observation. Release the fleet claim only then. Video/report upload may finish later if it no longer uses the shared resource.
* **Failure with clean teardown:** preserve the original outcome, perform the same return and release. A failed assertion alone does not make the account permanently unavailable.
* **Cancellation before local acceptance:** use the existing exact cancellation/rejection receipt plus a later scoped empty-custody observation to remove the never-executable claim. Request terminal state alone is insufficient.
* **Cancellation after acceptance or a crashed executor:** retain the claim while existing cleanup/fixer ownership runs. Moving the job to terminal does not prove the remote resource was returned.
* **Repair halt/out of service:** retain the affected shared claim and display the existing blocker. Other jobs that do not need this resource may proceed. Human consent or an idle lane alone is not release; the existing Retry recovery flow must verify cleanup and commit an accepted return.
* **Stopped fixer/restart:** recover the same journal and claim. Old generations cannot release or renew current authority. Never reclaim an in-use account or glasses pair merely because a heartbeat/TTL elapsed.

A resource-specific retained dependency prevents another machine from using an unresolved Google session without falsely taking every fleet lane out of service. Whole-lane reservations still reserve the selected lane and its current providers; shared dependencies are bound before its first provider use, and every later capability use rechecks the retained claim.

## Employee experience

Use the current pending reason and lane/resource status projections. Show, for example, “Waiting for Google test account; currently used by Testing Air 2 · Google SSO verification” only when that job actually uses the account, and “G2 glasses reserved by Air 3 · Android.” Show the owning job/reservation and its existing Details link. Do not imply that the available lane is broken when only a shared resource is busy.

Keep existing Reserve, Release, Pause, Resume scheduling and Retry recovery controls. Do not add an unsafe force-release action. A normal release enters cleanup; it does not immediately make borrowed hardware or sessions available.

## Verification and rollout

Required regression coverage:

1. Two concurrent local lanes request one canonical glasses pair: exactly one grant; the other pair remains independently grantable.
2. Two hosts request conference Google concurrently: one exclusive claim, including PR, manual, authoring and local/operator entry paths.
3. Account bytes/config availability without a claim cannot read/use the account; unrelated fixture consumers do not acquire it.
4. Multiple dependencies, lost CAS, request-winner race, cancellation before acceptance, host-source refusal and crash between cloud/local commits do not leak executable ownership or prematurely free a claim.
5. Clean teardown permits the next owner; unresolved native operations, failed logout/cleanup, stopped fixer, stale generations and restart retain/fence ownership.
6. Selected NIMO/G2 identity is preserved through provider creation, all cleanup and return; unsupported model/driver/software requirements refuse before native work.
7. Actual two-lane glasses qualification and two-host account contention with complete recording, publication and normal return. Source/CI alone does not establish physical transport or product behavior.

Roll out only after existing capacity admission is merged and activated. Coordinate the shared public contract/API increment, deploy Core authority first, then safe idle Harness acceptance, then qualified profiles and dependent declarations. Drain prior conference sessions before enabling exclusivity: otherwise an untracked existing session can still conflict with a correctly reserved new one. Do not rewrite frozen originals or alter catalog toggles. Keep capacity and quiet-room changes separate from this feature.

## Narrow implementation plan and estimate

| Work | Implementation scope | Initial estimate |
| --- | --- | --- |
| Same-host shared pair | Profile identity validation, controlled drained enrollment, existing local allocator regression, exact provider selection | 0.5–1 working day after real identity/provider inventory |
| Fleet-exclusive account | Extend existing typed resource dependency/claim, Core reservation CAS and release reconciliation, all dispatch/authoring paths, private credential-use guard | 1–2 working days plus independent review |
| Two glasses alternatives | Bounded inventory alternatives and exact selected provider lookup while retaining one execution provider | 1–2 additional days if existing NIMO/G2 drivers are complete; otherwise estimate after inventory |
| Actual qualification | Two-host contention, cancellation/repair, two-lane hardware selection and clean return | 0.5–1 day after software/device commissioning |

These are estimates for the mechanism, not a commitment that NIMO/G2 support already exists. No live devices, lanes, credentials or databases were changed while preparing this spec.
