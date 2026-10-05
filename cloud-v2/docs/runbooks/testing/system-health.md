# System health

Open **System health** in Admin, or the health link above **Test runs** and
**Fix flows**. The page answers two different questions:

- **Is the host reporting?** The independent monitor reports once a minute.
  After three minutes without a recent observation, service state becomes
  **No recent report**. This does not prove the computer is offline.
- **What can its services do?** The general worker handles fixes and shared
  triage. The dedicated triage worker adds separate capacity. Scheduled cleanup
  reports its own outcome; a later manual cleanup cannot make it healthy.

**Service running** means the expected service was observed alive. Follow the
job in Fix flows or the device lane in Test runs to see actual work. An
intentional stop requires an explicit disabled/drained disposition. An enabled
service whose expected process is absent is blocked; an unconfigured service
is unknown. Each card shows the reason and who can take the next action.

The disk chart shows actual available bytes on the Data volume in GiB. Choose
24 hours or seven days. Missing ticks and failed measurements leave gaps, not
zeroes. The dashed 5 GiB line marks the recorder minimum; capture requires at
least 5 GiB free on both the artifact volume and the macOS system Data volume.
Free space alone does not establish routine readiness. Cleanup has a separate
default trigger below 30 GiB and target of 35 GiB. Cleanup markers show attempts,
including refusals and dry runs. The
before/after difference includes other host activity and is not claimed as
space reclaimed by the cleanup itself.

## Reporting contract

The existing ingestion capability authenticates `POST
/api/internal/test-host-observations`. The strict v1 body is defined in
`packages/core/src/types/test-host-health.types.ts`: configured host ID, stable
sample UUID, actual sample timestamp, nullable available bytes, three
allowlisted service observations, and safe cleanup receipt summaries. No raw
paths, commands, logs, credentials or device ownership tokens are accepted.
The endpoint never starts workers, admits jobs or performs cleanup.

Retry the **same body and UUID** after an uncertain response. Exact retries
return the original receipt time; changed content conflicts. Core refuses
future samples beyond five seconds of clock tolerance and samples older than
seven days. A delayed old sample cannot replace a newer host observation.
The independent monitor must continue when the worker is paused and must not
reuse an old service inspection with a new sample timestamp.

Admin reads `GET /api/admin/test-runs/health` and
`GET /api/admin/test-runs/health/:hostId?days=1|7` through the existing Admin
session gate. History uses an indexed host/time range and retains seven days;
the latest host row is kept so a missing host does not vanish when history
expires. Both reads are bounded and disclose truncation. Startup creates the
unique/history/TTL indexes before ingestion is available.

Deploying the page and API does not install the passive monitor. Until the
host companion publishes its first actual sample, the page says no monitor
has reported. There is no synthetic backfill. Older cleanup receipts without
a timestamp for their after-value remain event context, not invented chart
measurements. The monitor/cleanup installations stay under their existing
host owners.


## Lane restoration

Open **Lane restoration attempts & resume decisions** from System health. The
page reads the controller's durable repair records, separately from passive
worker monitoring. An accepted scheduling resume receipt establishes success;
a repair report saying resume, a clean agent exit, a halt or a question does not.
Agent elapsed time starts at its actual recorded invocation. Lane handoff time
and the ten-minute delay alert are separate. Missing historical timestamps and
receipts are **Unknown**; stale controller observations cannot establish current
readiness.

The existing authenticated `POST /api/internal/test-host-state` accepts an
optional strict `restoration` v1 projection. It carries at most 100 sanitized
attempts from existing interruption, launch, report, resume and exit records,
with explicit `truncated` and action truncation flags. No raw model output,
command arguments, private paths or credentials belong in this projection.
Larger diagnostics retain their existing incident/attachment custody. Core
persists this bounded history with the existing latest host snapshot and its
restart/sequence fence. `GET /api/admin/test-runs/restoration/list` reads at most
32 controllers through the existing Admin session gate; it never grants a
resource, starts an agent, submits a question or changes scheduling.

Deploy Core before the updated controller producer: older controllers remain
accepted and show restoration records unknown. The producer begins recording
future resume refusals as scoped operation receipts; it does not manufacture
missing past calls or freeze a failed readiness check into an accepted decision.
This is retained controller history, not a complete lifetime audit log.
