# Catalog nightly selection

The catalog contains routine/platform pairs with a complete, recorded passing
example on the native foundation. A later failure or definition revision keeps
the pair in the catalog and preserves the earlier example's real revision and
build. The current enrolled definition is used for new requests.

Each catalog tile has **Run in nightly**, enabled by default. Admin saves the
preference with `PATCH /api/admin/routines/:routineId/platforms/:platform/preferences`
and `{ "nightlyEnabled": false }` (or `true`). Preferences are keyed by routine
and platform, so enrollment changes do not reset them. Changes affect future
occurrences; already selected requests and results retain their original plan.

Scheduled and manual nightly callers use the same authenticated Core endpoint:
`POST /api/internal/nightly-routines` with an `occurrenceId`, `startedAt` and
`trigger` (`nightly` or `manual`). The existing `TEST_RUN_INGEST_TOKEN` authorizes
this internal route. Core selects the entire enabled catalog, resolves immutable
one immutable dev publication and resolves every required platform from that
same source, then freezes definition revisions, artifact references, assigned
lanes and request identities before queue admission. Retries must repeat the
same occurrence identity and boundary. They resume frozen requests without
selecting the catalog or current preferences again.

Core requires `NIGHTLY_ROUTINE_LANES`, a JSON object keyed only by platform, whose
values have `hostId` and `laneId`. Set those identities to the intended enrolled
Mini lanes; routine names are not configuration keys. Core validates current
host observations, automatic lane mode, and exactly one resource of each kind
declared by the current definition. Host controllers retain execution and
resource allocation authority. No fleet discovery or fallback device selection
occurs.

Missing platform artifacts, lane bindings or definition capability remain
expected members with an unavailable reason. They cannot disappear from an
occurrence or count as a pass. Other members can admit and execute independently.
The endpoint returns each member admission; a temporary queue-write failure can
be retried with the same occurrence and immutable input.

Other exact-source callers discover runnable enrollment metadata with
`GET /api/internal/routine-catalog`. They submit
`POST /api/internal/routine-dispatches` with a stable `requestId`, `routineId`,
`platform`, and exact `source` (`channel`, `buildRunId`, `publicationAttempt`,
and `prNumber` for a PR). Core resolves the artifact and constructs the same
native input and platform binding as nightly selection. A retry retains the
original admitted definition and build; changed identity or source is refused.
`GET /api/internal/routine-dispatches/:requestId` returns the queued request and
its published framework result when available. These routes use the same
internal capability and existing request/result collections.

`routine-catalog` includes all current executable enrollments, including
never-passed definitions for PR selection. Nightly selection alone requires a
recorded passing example and applies the Admin preference.

An impossible host delivery uses authenticated
`POST /api/internal/test-requests/:requestId/reject` with its original host/input
digest and immutable rejection receipt. The existing request becomes `not-run`,
retaining its reason and input; no run, steps or recording are fabricated. Request,
nightly and suite details keep that reason visible.

`GET /api/internal/nightly-routines/:occurrenceId` reads progress.
`POST /api/internal/nightly-routines/:occurrenceId/complete` retains a terminal
receipt when all members finish or the three-hour boundary expires. A complete
pass requires exact request, routine, platform, definition revision, host, lane,
artifact source and publication evidence. Missing evidence reports incomplete.
At the boundary, Core cancels unaccepted cloud requests and records cooperative
cancellation intents for host-owned requests in the same collection. The host
polls `/api/internal/test-requests/cancellations`, uses its ordinary controller
cancellation path and acknowledges the original intent with
`POST /api/internal/test-requests/:requestId/cancel-ack`. The acknowledgment does
not claim active writers or cleanup have settled. Cancellation delivery includes
cloud-cancelled rows until acknowledged to reconcile local admission before a
lost Core acceptance response.

The receipt is frozen against late result arrivals. An empty enabled catalog
records a skipped occurrence; one selected member uses its normal run link.
Two or more expected members use the existing suite and request/result stores.

Deploying source is not hardware qualification. Verify the Mini bindings,
enrollment and configured internal capability before enabling the schedule.
