# Framework requests and results

Core stores immutable routine definitions, host-bound requests, results and asset
receipts. The testing host controller owns resource grants, execution and cleanup;
Core delivery or an upload acknowledgement never grants hardware access.

Canonical payloads are in `src/types/routine-definition.types.ts`,
`src/types/framework-request.types.ts` and `src/types/framework-run.types.ts`.
There is one canonical result in `test_runs` per request, not a parallel legacy
result or claim system.

## Controller authentication and enrollment

Provision `TEST_HOST_TOKENS` as a JSON object mapping stable host IDs to distinct,
random credentials of at least 32 characters. Controllers send their credential
with `Authorization: Bearer …`; server authentication supplies host identity.
Do not put credentials in source, logs, result payloads or routine definitions.
Missing or malformed host configuration disables these endpoints.

- `POST /api/internal/routine-definitions`: enroll the immutable routine/platform/
  source revision, definition digest and English requirements/steps. Portable
  execution metadata declares resource kinds and policy; it does not name a host's
  physical resources. Repeating identical enrollment returns the same identity;
  changing a frozen definition conflicts.
- `POST /api/internal/test-host-state`: publish the authenticated host's current
  lane/resource bindings, controller incarnation and increasing observation
  sequence. This is a projection, not resource ownership authority.
- `GET /api/internal/test-requests?limit=100&after=…`: page requests assigned to
  this authenticated host. Preserve complete pagination.
- `POST /api/internal/test-requests/:requestId/accept`: acknowledge durable local
  acceptance with `{requestId, hostId, inputSha256, acceptedAt}`. Lost replies are
  reconciled by the same request identity; they do not justify another execution.
- `POST /api/internal/test-requests/local`: register a controller's already durable
  local acceptance and immutable input for later publication.

A submitted request is `{requestId, hostId, input}`. Its input freezes routine
revision, platform, selected lane/resources, policy and exact build provenance.
Requests stay bound to that host. The controller validates its installed resource
bindings before allocation and persists acceptance before acknowledgement.

## Result publication

1. `POST /api/internal/framework-results` submits the frozen complete result and
   required asset manifest. The result names authenticated host, request/run,
   routine revision, lane, exact build, every declared step, phase outcomes and
   actual timings. Identical replay is idempotent; altered identity/content
   conflicts. Preserve setup/test/teardown failures and unexecuted steps.
2. `PUT /api/internal/framework-results/:requestId/assets/:assetId` uploads each
   declared file with its declared MIME type and bytes. The server verifies exact
   size/hash and media type before acknowledging custody. Use bounded streaming;
   recordings are limited to 2 GiB and other assets to 128 MiB.
3. `POST /api/internal/framework-results/:requestId/complete` verifies all required
   asset acknowledgements. The receipt binds `entityId`, `payloadSha256` and
   `manifestSha256`. Retrying publication never reruns a routine.

Keep local evidence until its exact cloud acknowledgement and local readers have
settled, then dispose owned files. Publication status is separate from execution:
a product pass with missing evidence is not a usable catalog example or a complete
suite. Upload failures do not hold a lane or overwrite the original test failure.
Step recording locations reference the declared asset and measured millisecond
offsets; unexecuted steps have no invented timestamps or recording locations.

## Admin dispatch and reading

Admin endpoints need an organization capability: `organization.testing.read` for
reads and `organization.testing.manage` for anything that writes (dispatches,
reruns, routine preferences). An Organization Admin's console session or WorkOS
token holds both; an operator key (`mak_`) holds the scopes it was created with.


- `GET /api/admin/test-routines`: current enrolled executable definitions.
- `GET /api/admin/test-builds`: published build inventory for the requested source
  channel/platform. A listed build is not proof that it was executed.
- `POST /api/admin/test-dispatches/picker`: submit the chosen routine, host/lane,
  source publication and archive digest. Core resolves trusted definition policy
  and authenticated host resource bindings before freezing the request.
- `POST /api/admin/test-dispatches`: submit the same immutable host-bound request;
  Core validates its selected published build, enrolled definition, resource
  bindings and policy. Neither endpoint starts a separate GitHub runner.
- `GET /api/admin/test-runs`, `GET /api/admin/test-runs/:runId` and
  `GET /api/admin/test-runs/:runId/assets/:assetId`: canonical history, detail and
  authenticated playable media. Static activity/suite routes precede `:runId`.
- `GET /api/admin/routine-catalog` and
  `GET /api/admin/routine-catalog/:routineId/:platform`: routine catalog/detail.
  A tile requires an acknowledged passing example; current enrollment alone is
  not qualification. An older example stays labeled with its actual revision.

Installing this code does not itself enroll a host, publish a passing recording,
enable a routine or establish a successful nightly run.
