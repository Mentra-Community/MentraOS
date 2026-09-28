# Admin fix flows

Open **Fix flows** in Admin to see **Needs attention** first, followed by currently
leased workers, waiting work, unknown status and completed work. Each flow joins an exact
recorded routine failure to its incident, controller acknowledgement, case,
agent checkpoints, fix PRs, review iterations and verification results.

The failed step title in a test run opens its fix flow; **Watch recording**
remains a separate action. Links use `/?fixFlow=tfo_…`. A failed chapter without
an occurrence uses `/?fixFlowRun=<runId>&fixStep=<chapterId>` and explains that
structured failure publication is pending. Multiple failures on one chapter
are offered separately. No case is selected by error signature or routine name.

## Pipeline, status and related failures

The lifecycle track reuses the employee portal Dev Agent bot artwork and connected
stage design. Each node counts groups at that **current recorded stage**, rather
than all stages a failure has ever visited. Zero-count nodes remain available.
Click a lifecycle node or a worker-status filter to select it; a selection replaces
the previous filter and **All flows** resets it. Counts always cover all loaded
groups, while the list heading shows the selected groups and their occurrence count.

The page groups only an identical recorded case **and acknowledged execution owner**.
Released/replacement owners remain separate. Expand a related-failures row to open
every exact occurrence, including its own run, incident and recording links. Failures
without a case stay separate; neither an error signature nor a routine name groups
them. Summary counts distinguish case IDs, flow groups and failure occurrences.

Running requires the controller's structured, unexpired worker lease. It includes
worker preparation and is not a claim that a model subprocess is currently sampling.
Missing/expired custody is reconciliation work, not running. Older controller
responses without this evidence show unconfirmed execution. Pending intake and
review/build/routine waits remain Waiting; missing source/evidence, input requests
and recorded stops appear under Needs attention. These are read-only display
classifications and never modify a case, retry count or lease.

Lifecycle stages use controlled progress phases, turn states and checkpoints.
Unknown phases remain Unrecorded. A cancelled or no-fix outcome is Closed, not
Merged; a merged PR still does not prove a successful rerun.

## Deployment

Core's existing Admin authentication protects `/api/admin/fix-flows` and its
read-only detail routes. Set `CLOUD_REPORT_AGENT_ACTIVITY_TOKEN` to the existing
dev-agent `ACTIVITY_API_TOKEN` in the matching Core environment. The existing
`CLOUD_REPORT_AGENT_URL` selects the controller. Keep the token server-side; it
must never be a browser build variable. No queue write permission is added.

The companion controller (internal-tools PR #96) adds `workerLease` and, for linked
occurrences, `executionOwnerWorkerLease`, each `{state, expiresAt?}`. No lease token
or local process identity is exposed. Its optional `executionOwnerProgressPhase`
keeps a linked occurrence on its acknowledged owner's recorded phase.

The companion controller supports
`GET /internal/activity/runs?scope=routine-fixes&limit=100&cursor=…`, returning
active work first with `{runs, limited, nextCursor}`. It decorates actual
`record-pr` checkpoints with GitHub lifecycle state, including PRs published
before a final agent result. Core reads at most ten pages and labels truncated
history. Older controllers remain readable but the UI identifies their bounded
recent view. Exact occurrence links always use the direct activity detail route.

For a linked occurrence, the controller retains its own intake and status and
adds `acknowledgedAgentRunId` plus the recorded execution owner's identity,
status and timestamps. The owner must equal the Core acknowledgement. The
controller verifies the occurrence against its durable case observation list,
including released branch history, before projecting that owner's progress.
The direct lookup passes both `occurrenceId` and `testRunId`; it never substitutes
the anchor's first failure. Admin labels shared progress **Linked case** and
keeps the occurrence's status distinct from its execution owner's status.
The owner's existing triage state is projected separately as well. A recorded
pre-execution cancellation belongs in completed history even when the retained
run status remains `awaiting_executor`; it does not imply a fix or a passing test.

The join requires the Core acknowledgement's agent run ID, test run ID,
occurrence ID and environment to agree. Prompts, lease tokens, raw stderr,
local paths and credentials are excluded from the Admin projection. Recorded
review events retain their head and review link. Shared-case rerun results are
shown only when their dispatch checkpoint binds this occurrence (or its own
legacy anchor). PR approval never implies merge, and merge never implies a
passing routine.

The page refreshes every 15 seconds. A failed controller lookup leaves the
recorded failure and incident links available with **Status unavailable**;
an acknowledgement alone is not displayed as a running agent. Unconfigured
environments explicitly say that agent activity is not configured.
Historical admitted-triage instructions do not override a later execution
stage or blocker. When a stop record does not identify the recovery owner or
next action, the page says so rather than assuming action is required from
the person viewing Admin.

## Validation

Run the Core fix-flow service tests and the Admin fix-flow/test-run viewer tests,
then Core and Admin typechecks and the Admin production build. Browser previews
must use visibly synthetic fixtures; deployed verification must read a genuine
accepted occurrence and compare its case/PR identity with the controller.
This feature changes Admin observability; no registered device routine covers
the new Admin page, so it does not add a device-routine label.
