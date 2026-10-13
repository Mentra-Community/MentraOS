---
status: active
owner: Philippe
---

# Finish incident collection before routine cleanup

## Demonstrated failure

Incident `rep_01M4TB2F4RH6JJSKRC2QBWSNGT` was created at 09:56:33 UTC. The framework stopped observing its result at 09:57:00. The app awaited a phone-log HTTP request, which timed out at 09:57:37, before dispatching the glasses request at 09:57:45. Glasses cleanup was already running, and app uninstall began five seconds later. Phone and cloud artifacts arrived; glasses and firmware artifacts did not. This proves premature cleanup of an ongoing report, although the glasses relay's internal failure is not available in the retained evidence.

## Contract

1. The existing engine `submitIncidentReport` entrypoint owns one 120-second deadline from invocation through required log collection. Each later stage uses the remaining time; deadlines do not restart after HTTP calls.
2. After report creation, start the glasses notification and phone-log upload independently. A slow phone request cannot postpone the glasses request. Notification still checks the actual paired Live identity and native connection.
3. Pass the same AbortSignal through Core's existing report HTTP methods. Check it after unabortable context, settings, token and native-status reads so expiry cannot cause a late report upload or glasses dispatch. Abort uses the existing native HTTP cancellation.
4. Success requires the report's required device sources to have stored artifact receipts. Paired Live requires phone, glasses and firmware; other identities require phone. A failed source does not abandon another source still collecting: wait until all selected sources settle or the one deadline expires, then reject with the created report ID and available partial receipts. Submission or auxiliary attachment/finalization failure also rejects.
5. Normal feedback submission remains independent of strict device collection. Its UI can return without waiting for glasses uploads. No worker gains report-reading credentials or another collector.
6. Android and Mac framework adapters observe this same contract before cleanup. Preserve their original process/window ownership checks and single-attempt correlation. Reserve only the existing fixed native delivery/read/dismissal allowance around the app deadline; this is not a per-step timeout increase.
7. Reporting rejection never changes the original failed verdict and never stops the remaining resource cleanup or next independent test.

The app constant belongs to the existing report-automation protocol module. The harness has no dependency on that package; its named adapter budget explicitly references this contract rather than introducing a package deployment mechanism solely for a number. The harness observes for 128 seconds (120-second app budget + 8 seconds native trigger delivery). Its existing 13-second post-observation allowance covers 4 seconds native read cessation, 8 seconds modal dismissal and 1 second settlement, giving a 141-second reporter cap. The enclosing incident action is 142 seconds, including its existing one-second platform admission margin. Both sides have regression coverage for their timing relationship.

## Verification

- Hold the phone upload pending and verify glasses dispatch already occurs.
- Expire context/token/native-status/HTTP stages and verify no delayed dispatch or writes after expiry.
- Keep firmware pending after phone failure and verify the operation stays pending; after firmware settles, reject and retain successful receipts.
- Verify abort reaches report create/upload/status/finalization calls and clears timers/listeners.
- Verify no paired Live requires only phone receipts; strict failure reaches the existing presentation boundary.
- Framework tests prove a delayed correlated result beyond the previous 45-second bound is accepted before cleanup, while expiry still permits all teardown steps.
- After normal publication, one held intentional report with slow phone delivery must retain glasses connection through actual collection and produce stored phone/glasses/firmware receipts or an accurately rejected bounded receipt. Source tests are not device qualification.

## Rollout

Normally publish and verify acceptance of the enlarged harness budget before selecting the new app build for tests. A new 120-second app with the former 45-second observer would recreate the demonstrated premature teardown. An older app with the longer observer is safe, but does not establish complete artifact collection. Device qualification must record exact app/framework versions and inspect stored required artifacts; fake timers and source tests do not prove delivery.
