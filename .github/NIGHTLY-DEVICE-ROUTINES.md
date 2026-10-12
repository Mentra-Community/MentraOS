# Dev nightly routines

`nightly-device-routines.yml` is a thin scheduler. `DEVICE_ROUTINE_NIGHTLY_ENABLED=true` enables its existing `routine-nightly-dev` environment. The two UTC schedules cover 04:00 Pacific through daylight saving time; only the matching trigger creates that day's occurrence. Manual runs use the original GitHub run ID and creation time. Rerun attempts reuse both occurrence identity and start boundary.

The execution deadline is three hours after that original start boundary. A delayed schedule or old manual rerun arriving after it reconciles the expired occurrence; it does not restart the deadline or request a fresh run. Missing evidence remains incomplete. Start a new manual workflow run when fresh coverage is wanted.

Core selects the passing routine catalog for dev, applies each routine/platform's Admin nightly preference, and freezes the selected definitions, source builds, host/lane bindings and independent requests. The scheduler sends no routine IDs:

- `POST /api/internal/nightly-routines` with `{occurrenceId, startedAt, trigger: "nightly" | "manual"}`.
- `GET /api/internal/nightly-routines/:occurrenceId` to inspect the frozen occurrence.
- `POST /api/internal/nightly-routines/:occurrenceId/complete` to finalize complete evidence or the three-hour deadline.

These endpoints use `TEST_RUN_INGEST_TOKEN_DEV`. Core's `NIGHTLY_ROUTINE_LANES` maps execution platforms to enrolled host/lane bindings. A missing build, capability or binding appears as an unavailable member rather than disappearing from the expected set. Failed admission retries retain the same request and build identity. One member's failure does not cancel the others.

The final receipt supplies the expected members, individual status and publication completeness, aggregate verdict and recorded-results URL. The scheduler retains it as an Actions artifact and posts the generic verdict to `SLACK_WEBHOOK_DEV_BUILDS`. Only the original scheduler attempt may send the webhook; reruns reconcile Core without replaying an uncertain Slack send. Inspect the retained send intent and acknowledgement before manually reconciling a notification.

Nightly preferences are controlled in Admin's routine catalog. Turning a preference off affects future occurrences; it does not rewrite an existing occurrence. PR label dispatch remains separately disabled by default.

PR and explicit release result callbacks launch one publication workflow per authenticated Core request. A rejected or cancelled terminal request gets its receipt link and reason immediately; it does not acquire a fabricated framework result. Each request can publish while another waits for evidence or an API recovery. Automatic retries use the same accepted request IDs. If GitHub does not acknowledge a dispatch, it can be retried: duplicate notification runs reconcile the same request through the existing PR/Slack locks and durable post receipts. Workflow display titles do not suppress publication. Explicit publication retries use `notify-release-routine.yml` with the same request ID; they never start another device run.

Explicit and enabled PR requests attempt selected routine/platform members independently. Their `routine-dispatches` artifact retains accepted request IDs plus each member's accepted, pending or failed outcome before admission failures are reported. Result callbacks can therefore publish accepted neighbors even when the request workflow fails. Slack catalog and result sections show a bounded selection with an Admin link for overflow; retained result state keeps every row.
