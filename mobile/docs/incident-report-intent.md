# Request an incident report from Android

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
`report_id` and `incident_id` are the same value. Android's “Broadcast completed”
only acknowledges delivery; it does not prove that a report was submitted.
The existing automatic-report throttle applies to duplicate request IDs; distinct
alert IDs use distinct keys. Send once per failure and bound how long the caller
waits for a receipt. A missing receipt is an unconfirmed submission and must not
replace the original test failure or prevent teardown.
