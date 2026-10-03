# Dev nightly routines

`nightly-device-routines.yml` is a thin scheduler. `DEVICE_ROUTINE_NIGHTLY_ENABLED=true` enables its existing `routine-nightly-dev` environment. The two UTC schedules cover 04:00 Pacific through daylight saving time; only the matching trigger creates that day's occurrence. Manual runs use the original GitHub run ID and creation time. Rerun attempts reuse both occurrence identity and start boundary.

Core selects the passing routine catalog for dev, applies each routine/platform's Admin nightly preference, and freezes the selected definitions, source builds, host/lane bindings and independent requests. The scheduler sends no routine IDs:

- `POST /api/internal/nightly-routines` with `{occurrenceId, startedAt, trigger: "nightly" | "manual"}`.
- `GET /api/internal/nightly-routines/:occurrenceId` to inspect the frozen occurrence.
- `POST /api/internal/nightly-routines/:occurrenceId/complete` to finalize complete evidence or the three-hour deadline.

These endpoints use `TEST_RUN_INGEST_TOKEN_DEV`. Core's `NIGHTLY_ROUTINE_LANES` maps execution platforms to enrolled host/lane bindings. A missing build, capability or binding appears as an unavailable member rather than disappearing from the expected set. Failed admission retries retain the same request and build identity. One member's failure does not cancel the others.

The final receipt supplies the expected members, individual status and publication completeness, aggregate verdict and recorded-results URL. The scheduler retains it as an Actions artifact and posts the generic verdict to `SLACK_WEBHOOK_DEV_BUILDS`. Only the original scheduler attempt may send the webhook; reruns reconcile Core without replaying an uncertain Slack send. Inspect the retained send intent and acknowledgement before manually reconciling a notification.

Nightly preferences are controlled in Admin's routine catalog. Turning a preference off affects future occurrences; it does not rewrite an existing occurrence. PR label dispatch remains separately disabled by default.
