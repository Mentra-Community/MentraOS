# Independent return observation

The pure helpers in `return-observer.ts` compare caller-captured evidence. They
do not connect to hardware, start updates, clear logs, read protected preferences
or change permissions. The controller retains the existing fixture lease and
records exact command argv, timestamps, stdout/stderr and exit status in new
evidence files.

Use `assertFirmwareState` for the selected profile's full CID, serial, Bluetooth
MAC, MTK version, active ASG APK SHA-256 and fresh same-boot BES version. Record
the actual boot slot too. Derive `updateIdle` only when **every**
`checkRuntimeOtaIdle` check passes; use fresh paired-home evidence for
`appConnected`. Require a stopped stream snapshot separately. An idle updater
does not turn a failed test into a pass.

## Capture order

Use the already selected and independently verified ADB transport; never choose
a pair by a nonunique legacy serial alone.

1. Capture a before bracket: boot ID, the single ASG PID, its process start ticks,
   clock frequency and uptime. The commands after `adb -t T shell` are:

   ```text
   cat /proc/sys/kernel/random/boot_id
   pidof com.mentra.asg_client
   cat /proc/PID/stat
   getconf CLK_TCK
   cat /proc/uptime
   ```

   `processStartTicks` parses field 22 without splitting a spaced process name.
   Every later read includes its own capture time and uptime. Do not invent a
   clock frequency if the read fails.

2. Read independent Android update engine state using the existing, hash-verified
   status probe. Require exactly one `CURRENT_OP=UPDATE_STATUS_IDLE` and one
   `STATUS_CODE=0`. Status 6 or a staged payload is not idle. This observer
   does not stage a probe; its actual on-device SHA-256 must match the pinned
   helper before the controller runs it.

3. Query the existing Intent command receiver for a fresh version response and
   stream snapshot, followed by the opt-in activity snapshot. Use unique,
   nonreused request IDs and preserve each matching response:

   ```text
   am broadcast -n com.mentra.asg_client/.receiver.IntentCommandReceiver -a com.mentra.asg_client.ACTION_SEND_COMMAND --es json '{"type":"request_version","request_id":"return-version-UNIQUE"}'
   am broadcast -n com.mentra.asg_client/.receiver.IntentCommandReceiver -a com.mentra.asg_client.ACTION_SEND_COMMAND --es json '{"type":"get_stream_status"}'
   am broadcast -n com.mentra.asg_client/.receiver.IntentCommandReceiver -a com.mentra.asg_client.ACTION_SEND_COMMAND --es json '{"type":"ota_query_status","include_activity":true,"request_id":"return-activity-UNIQUE"}'
   ```

   Pass each as one correctly quoted remote command: a Python caller can combine
   `json.dumps` with `shlex.quote`. Local shell quotes alone can be lost
   when ADB reconstructs its remote command line. Do not register a second BLE
   listener.

   Read `AsgClientService`'s matching version response, `MediaManager`'s
   stream response and `OtaCommandHandler: OTA activity snapshot: {...}`
   from a fresh log dump. The shared process SID is eight hexadecimal
   characters. Require the exact activity nonce, current SID and captured
   elapsed realtime. The local diagnostic is authoritative for this query:
   normal terminal BLE messages intentionally retain their small compact form.
   The process-local `admission_generation` is a nonnegative integer sampled at
   entry; `consistent: true` means it remained unchanged during the owner reads.
   Comparing generations across an interval is valid only with the same boot,
   PID, start ticks and process SID; the counter does not survive an ASG restart.

4. Capture the after bracket with the same boot/PID/start-ticks/uptime reads.
   All reads must lie inside this bracket and be no more than 30 seconds old by
   default. The activity query must close the update-engine observation. Its
   elapsed realtime must fall between the before bracket and its actual capture
   uptime. A stale diagnostic, unknown field or process change fails closed.

5. Capture Device Info and the unobstructed home of the selected Mentra App.
   Independently bind both fresh captures to the expected executable and same
   app PID. Require the full paired MAC, current ASG build, and the connected,
   fully booted Mentra Live battery card. An OTA overlay, open miniapp, dialog,
   disconnected/searching state or cached Device Info alone cannot qualify.

## Independent firmware and stream evidence

Use the actual active APK path from `pm path com.mentra.asg_client` and hash
that file with a validated absolute path. Check the CID, both observed serial
sources, MAC, boot-completed property, slot and MTK version using the existing
firmware observer. A release package hash is not an installed partition hash;
do not substitute the factory APK when a data APK is active.

The version response contains a **cached** BES version. JSON `cs_syvr` follows
the same cached handler. Use a fresh actual `hs_syvr`/`sr_syvr` or
`BES_OTA_DIAG version_proof` for the same current boot, with its capture time.
Never inject an inbound MCU event as a substitute for observing it.

`checkStoppedStream` requires a current-process `kind=snapshot`, the exact
SID, nonnegative revision, `status=stopped`, `terminal=true`,
`streaming=false` and `reconnecting=false`. The caller also enforces
freshness and source process identity; an old status event is not sufficient.

## Source contract and qualification boundary

The opt-in query reads the existing admission semaphore, volatile APK/MTK busy
flags, BES controller activity and synchronized raw session/restart state.
Admission and volatile flags are sampled on both sides of the other owner reads.
A diagnostic admission sequence also rejects a start-and-release handoff between
those reads: `consistent` must be true. It does not control update admission.
Unknown owners are null, never idle. The diagnostic does not acquire admission,
start a worker, consume a restart guard or expire a session. It is captured
before the existing status projection, which retains its previous behavior.
Activity is an instantaneous observation, not a reservation against future work.

Source: `OtaHelper.getOtaActivitySnapshot`,
`OtaSessionManager.getActivitySnapshot`, `OtaCommandHandler`,
`ProcessSessionId` and `StreamStatusSnapshot` in ASG; the paired-home
branch is `mobile/src/components/home/DeviceStatus.tsx`.

The September 22 discovery reached the expected firmware but its main log ring
had already lost the ASG startup interval. Logs remain useful diagnostics; they
are not a fallback idle acceptance path. The direct activity query requires the
new ASG build and its own physical verification. This code does not retroactively
qualify the earlier run or mark its fixture ready.
