# Request an incident report from an automated test

The Mentra App exposes a report trigger in **every Android and iOS build**, including
iOS apps running on macOS. Use the existing signed-in app after a failure. The
normal incident pipeline creates the report in the selected deployment, uploads
recent phone console logs (including the Bluetooth SDK's forwarded native log
events), and requests logs from connected glasses. This is the app's recent
in-memory log buffer, not a complete Android logcat or iOS system-log capture.

| Platform | Trigger | Receipt |
| --- | --- | --- |
| Android | `com.mentra.SUBMIT_INCIDENT_REPORT` broadcast | `INCIDENT_REPORT_RESULT` in logcat |
| iPhone / iOS on Mac | `com.mentra://test/submit-incident-report?...` | JSON in the incident modal |

These commands request real reports using the app's current account. No credentials
are passed in the request. Capture the failed screen first, send once, and continue
normal teardown even when reporting is unavailable or times out. Do not restart
the app to file a failure report: doing so loses the state under investigation.

The trigger is intentionally available to any local Android app, or any app/site
that opens the iOS URL, while Mentra is signed in. Reports upload only to the
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

`com.mentra.SUBMIT_INCIDENT_REPORT` is available in **all Android builds**.
Keep the Mentra App running and signed in. The request uses its normal report
pipeline: authenticated submission, phone logs, diagnostic context, and a request
for logs from connected glasses. It does not start a stopped app's report engine.

```bash
adb -s PHONE_SERIAL shell am broadcast \
  -a com.mentra.SUBMIT_INCIDENT_REPORT \
  -n com.mentra.mentra/com.mentra.crust.receivers.SubmitIncidentReportReceiver \
  --es alert_id request-unique-id \
  --es test_run_id routine-run-id \
  --es source mentra_automated_testing \
  --es failure_code update_failed \
  --es failure_message 'Update did not finish' \
  --es expected_behavior 'Versions match the selected OTA manifest' \
  --es scenario_name day1-ota
```

| Extra | Purpose |
| --- | --- |
| `alert_id` | Unique request ID, echoed in the result; use it to correlate one submission. |
| `test_run_id` | Owning test run; also the correlation fallback when `alert_id` is absent. |
| `source` | Calling tool or workflow; defaults to `external_trigger`. |
| `failure_code`, `failure_message` | Short failure identifier and explanation. |
| `scenario_name` | Routine or workflow name. |
| `expected_behavior` | Expected outcome. |
| `dashboard_url` | Evidence/dashboard link used in default expected-outcome text. |

All extras are optional. Additional primitive extras are preserved as report
metadata; Android's action and reception timestamp cannot be overridden. The old
`com.mentra.CAPTIONS_TESTER_INCIDENT` action/component is replaced by this API.

Read the result from `adb -s PHONE_SERIAL logcat -T 1 ReactNativeJS:I '*:S'`.
Start observation before sending the request and match `alert_id` and
`test_run_id`:

```text
INCIDENT_REPORT_RESULT {"alert_id":"request-unique-id","test_run_id":"routine-run-id","failure_code":"update_failed","scenario_name":"day1-ota","status":"filed","report_id":"rep_...","incident_id":"rep_..."}
```

`status` is `filed`, `skipped` with `reason`, or `failed` with `error`.
`report_id` and `incident_id` are the same value. `filed` confirms the report was
created; phone and glasses log uploads are best effort, so this receipt alone
does not prove every artifact was uploaded. Android's “Broadcast completed”
only acknowledges delivery; it does not prove that a report was submitted.
The existing automatic-report throttle applies to duplicate request IDs; distinct
alert IDs use distinct keys. Send once per failure and bound how long the caller
waits for a receipt. A missing receipt is an unconfirmed submission and must not
replace the original test failure or prevent teardown.
