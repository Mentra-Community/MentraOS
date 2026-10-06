# Request an incident report from an automated test

The Mentra App exposes a shared report deep link in **every Android and iOS build**, including
iOS apps running on macOS. Use the existing signed-in app after a failure. The
script entry point requires the existing **Super Mode** setting. In normal mode it
returns a failed receipt without uploading; normal user feedback is unaffected. The
normal incident pipeline creates the report in the selected deployment, uploads
recent phone console logs (including the Bluetooth SDK's forwarded native log
events), and requests logs from connected glasses. This is the app's recent
in-memory log buffer, not a complete Android logcat or iOS system-log capture.

| Platform | Trigger | Receipt |
| --- | --- | --- |
| Android | `com.mentra://test/submit-incident-report?...` | `INCIDENT_REPORT_RESULT` in logcat |
| iPhone / iOS on Mac | `com.mentra://test/submit-incident-report?...` | JSON in the incident modal |

These commands request real reports using the app's current account. No credentials
are passed in the request. Capture the failed screen first, send once, and continue
normal teardown even when reporting is unavailable or times out. Do not restart
the app to file a failure report: doing so loses the state under investigation.

The trigger is intentionally available to any local Android app, or any app/site
that opens the iOS URL, while Mentra is signed in with Super Mode enabled. Reports upload only to the
currently configured Mentra backend; callers cannot choose another upload
destination or read logs back through the trigger.

## iPhone and iOS on Mac

Use the registered `com.mentra` scheme. URL-encode each query value (for example,
with `URLSearchParams`) rather than hand-escaping failure text. Required fields:
`alert_id`, `failure_code`, and `failure_message`. Other documented fields are
optional. Use a fresh `alert_id` for each failure, and include `test_run_id` for
automated runs.

```bash
INCIDENT_URL='com.mentra://test/submit-incident-report?alert_id=run-1-call-failure&test_run_id=run-1&source=mentra_automated_testing&failure_code=call_failed&failure_message=Call%20ended&scenario_name=mentra-call'
```

On a USB-connected iPhone, deliver the URL to the installed, running app. Set the
bundle ID to the selected CI artifact's identity if it differs from this default:

```bash
xcrun devicectl device process launch \
  --device "$UDID" --payload-url "$INCIDENT_URL" com.mentra.mentra
```

For iOS on Mac, target the installed app explicitly when multiple builds exist:

```bash
open -a '/Applications/Mentra.app' "$INCIDENT_URL"
```

Both OS commands can launch a stopped app. The automated worker must verify that
its intended app process is already running before delivery. Do not pass
`--terminate-existing`. Cold launch and sign-in recovery are outside the failure
hook: this trigger uses the current engine and does not initialize or reset it.
If no report service is available, the receipt reports that failure.
If the current app session is unavailable, the modal returns a correlated failed
receipt immediately without uploading or navigating to sign-in.

A native modal appears **above the current screen, including Mentra Call**. It
does not close the miniapp or change navigation. The UI automation contract is:

| Accessibility `testID` | Value / action |
| --- | --- |
| `incident-report-state` | JSON with `alert_id`, `test_run_id`, and `status`: `submitting` or `finished`. |
| `incident-report-result` | Final JSON using the result format below. Only present after completion. |
| `incident-report-done` | Dismiss the modal and expose the unchanged prior screen. Available while pending too. |

Match `alert_id` **and** `test_run_id` before accepting a receipt or dismissing a
modal. Press **Done in a finally block**, including on timeout, then execute the
routine's normal cleanup. Dismissal does not cancel an upload already in progress.
Opening a URL successfully does not prove that a report was filed.

The URL accepts the fields in the table below. Repeated fields, blank values, and
oversized values are rejected. `alert_id` uses letters, digits, `.`, `_`, `:`, and
`-`, beginning with a letter or digit. Limits are 160 characters for IDs, source,
and failure code; 256 for scenario; 2,048 for dashboard URL; and 8,192 for failure
and expected-behavior text. Unknown fields are ignored. Do not include credentials.

React remounts and duplicate URL delivery reuse the same in-process result for
the most recent 32 requests. That cache is scoped to account and deployment;
reusing an ID with changed details is rejected. Use a new ID for an intentional
retry. This does not claim durable idempotency across app restarts.

## Android

Use the shared sender, which preserves the complete URL through the device shell:

```bash
bun scripts/submit-test-incident.mjs --android PHONE_SERIAL \
  alert_id=authoring-1 failure_code=search_failed \
  'failure_message=Search did not filter the notes'
```

The modal exposes the same three test IDs on both platforms. Android also logs
`INCIDENT_REPORT_RESULT` JSON. Match both request IDs, dismiss the matching modal
in a finally block, and continue normal teardown. A filed receipt confirms report
creation; individual phone and glasses log attachments remain best effort.

The old incident broadcast action and receiver have been removed. No legacy
input is accepted.
