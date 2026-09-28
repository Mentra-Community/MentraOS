# Admin fix flows

Open **Fix flows** in Admin to see active investigations and outstanding actions
first. Completed history is collapsed below them. Each flow joins an exact
recorded routine failure to its incident, controller acknowledgement, case,
agent checkpoints, fix PRs, review iterations and verification results.

The failed step title in a test run opens its fix flow; **Watch recording**
remains a separate action. Links use `/?fixFlow=tfo_…`. A failed chapter without
an occurrence uses `/?fixFlowRun=<runId>&fixStep=<chapterId>` and explains that
structured failure publication is pending. Multiple failures on one chapter
are offered separately. No case is selected by error signature or routine name.

## Deployment

Core's existing Admin authentication protects `/api/admin/fix-flows` and its
read-only detail routes. Set `CLOUD_REPORT_AGENT_ACTIVITY_TOKEN` to the existing
dev-agent `ACTIVITY_API_TOKEN` in the matching Core environment. The existing
`CLOUD_REPORT_AGENT_URL` selects the controller. Keep the token server-side; it
must never be a browser build variable. No queue write permission is added.

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
