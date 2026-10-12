# Livestream startup after a stalled BLE transfer

Report: `rep_01M3DCTH2RS275XAVZ7M360QQA` ([Slack](https://mentra-labs.slack.com/archives/C0A8015JBPT/p1790377281629669)).

## Evidence

The staging report contains one phone log artifact, with no glasses or BES log
bundle. The Mentra App is `3.2.1-beta.379`, source `3d35477`; Livestreamer is
`1.0.32`; ASG is `3.2.1`, build `302010043`; MTK is
`MentraLive_20260921.0`; BES is `26.9.25.0`. The relevant relay/coordinator code
is unchanged between the reported commit, the investigated staging base
`d3a14210c7`, and `origin/dev` at `2763761a9c`.

Phone receive times below are UTC on 2026-09-25:

| Time | Observation |
| --- | --- |
| 22:58:34 | A photo request is acknowledged and accepted by ASG. |
| 22:58:36–39 | Its BLE file transfer starts, then stops progressing. |
| 22:59:08–12 | An incident-log upload command exhausts its acknowledgement retries. |
| 22:59:26 | The phone receives the photo's `transfer_failed`, reason `ble_tx_stuck_consecutive_failures`, and a late incident-command acknowledgement. |
| 22:59:29 | More late acknowledgements arrive, plus `packet_timeout` for the incident-log transfer. |
| 23:00:28 | Livestreamer requests a managed WHIP stream. |
| 23:00:29 | Cloud provisioning succeeds in 901 ms; the phone sends hotspot enable (`mId:47`). |
| 23:00:30–33 | Hotspot enable exhausts three acknowledgement retries. |
| 23:00:44 | After the 15-second hotspot response timeout, cleanup sends hotspot disable; this also exhausts its retries. |
| 23:01:00–15 | Further stop/cleanup attempts send hotspot disable without confirmation. Livestreamer unmounts at 23:01:06. |

The report snapshot still owns a managed stream, with zero subscribers and no
playback readiness. Bluetooth signal measurements and BES audio responses
continue. The logs contain no native relay preparation or glasses stream-start
command for this attempt. The failure therefore precedes WebRTC media startup;
successful provisioning does not establish a working glasses command path.

The hotspot command already sets `wakeUp: true`. There is insufficient evidence
to identify the underlying BES/MTK/BLE failure from this phone-only bundle.
The linked earlier incident `rep_01M3DCPFDE7QRS49AD6J51R1S4` also contains only
phone logs. No firmware change or successful hardware reproduction is claimed.

## App recovery defect and change

`startManaged` installs the link observer only after publisher startup. When
hotspot enable fails and hotspot disable also fails, the coordinator retains
its entry and the relay's resource ownership but has no observer to recover
that cleanup on disconnect/reconnect. Cleanup's error also replaces the initial
startup error, and remote teardown can keep the transition lock pending.

The failure path now observes link changes before cleanup, returns the original
startup error, reports cleanup failures separately, and sends remote teardown
without holding the local lock. A retained stopping entry retries cleanup on a
connection change instead of resuming as a live stream. Ownership remains held
until cleanup succeeds or BLE work is deferred while disconnected; reconnect
must confirm deferred cleanup before a new publisher starts. Diagnostics expose
the stopping state.

## Validation and remaining checks

- Coordinator and relay suites: 76 tests pass. The new startup regression fails
  against unmodified staging because cleanup masks the hotspot-enable error.
- Regression coverage includes failed enable plus repeated failed disable,
  zero subscribers, disconnect/reconnect cleanup, starting a new stream after
  recovery, pending cloud teardown, and failed native-stop recovery.
- The routine catalog and pinned Call definition at
  `90a70edfe2fa17fd766dda3d98977555d6608a05` have no managed-livestream recovery
  test. Call's direct-link routine does not exercise this managed relay path.
  No routine label is selected.
- Physical iPhone/Mentra Live validation remains: reproduce the stalled BLE
  transfer, capture glasses/BES logs, verify the original error is returned,
  reconnect, confirm hotspot/native cleanup, and start/stop a fresh livestream.
  This PR repairs app recovery; it does not establish that the initial BLE
  transport stall is fixed.
