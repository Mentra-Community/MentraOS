# G2 partial-connection validation

The September 28, 2026 iPhone investigation found right-arm BLE traffic while the
Mentra App reported the entire pair ready. The display repeatedly emitted
`system_exit` and was rebuilt about every 18.5 seconds, without periodic heartbeat
writes. iOS Bluetooth Settings independently showed right connected / left
disconnected. Restarting the app cleared the false readiness but exposed a
right-only cached reconnect that could not reclaim the system-connected arm.

## Automated regression coverage

Run `swift test --package-path mobile/modules/bluetooth-sdk`. The G2 connection
tests cover either arm alone, both auth response/setup orderings, rejected auth,
retired setup and timeout generations, partial serial-scoped caches, refusal of
unrelated nearby arms, and the captured system-exit payload in the actual driver.
They also cover the three-second grace period in both directions, peer arrival,
reset, and status serialization. Mobile tests cover Home notices and preservation
of side-specific timeout messages on the failure screen.
The Apple SDK export check also compiles the changed code for native macOS and iOS.

## Physical iPhone path (requires a G2 fixture)

No registered device routine currently covers G2 pairing on a physical iPhone.
The following is a proposed finite validation path, not a new dispatch ID or a
claim of completed hardware qualification.

Setup: record the installed app build, selected pair identity, both iOS Bluetooth
entries and return state. Use a build containing this change and an identified
pair; keep other nearby G2s out of the selection. Preserve bonds and app data.

1. On a fixture with only the right arm available, connect through the Mentra App.
   The app must stay connecting and must not show the connected greeting. Inject
   no artificial success state; record incoming system-exit/gesture packets if
   the firmware sends them. Within 15 seconds of powered-on discovery, incomplete
   initialization must produce a pairing failure and retry, with no display
   rebuild loop. Repeat with only the left arm available. During the first three
   seconds with just one arm connected, show no arm warning. After three seconds,
   both the pairing screen and Home card must identify the connected and waiting
   arms. The timeout explanation must name the missing arm.
2. Relaunch with only one arm's serial-scoped UUID cached and that arm still
   system-connected. Confirm the SDK reacquires that arm without needing its
   advertisement, and continues scanning for the other arm. An unrelated G2 with
   the same `G2_32` name fragment must never complete the pair.
3. Verify normal sequential pairing with the second arm arriving within three
   seconds never flashes the missing-arm message. On a delayed connection, making
   the selected peer available must immediately clear that message. Both arms must complete service discovery,
   notification subscription and authentication before the ready event/greeting.
   Verify periodic EvenHub and base heartbeat writes to both arms. Run text display
   for two minutes in the foreground and two minutes with the phone screen off.
4. Lose either arm during initialization and again after readiness. Confirm the
   SDK clears readiness, retires the old attempt, and reconnects both selected
   arms. Cancel from the app during a retry; no later callback or timer may
   resurrect the connection. Retry once from the app and verify normal recovery.
5. Open and close the native glasses dashboard. A normal page lifecycle event
   must still recover the current display after a healthy authenticated connection.

Evidence: retain app build/commit, native ready/disconnected and auth logs, both
arm identifiers, heartbeat timestamps, and phone/on-glasses observations. An SDK
build or local test pass alone does not qualify this physical path.

Teardown: stop test miniapps and restore the recorded app/connection state. Stop
after one attempt per failure direction and one recovery attempt; retain logs if
recovery fails instead of resetting bonds or switching to an unidentified pair.
