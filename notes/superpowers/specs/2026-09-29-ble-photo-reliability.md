---
status: active
owner: aisraelov
---

# Reliable BLE photo delivery

The [reported failure](https://mentra-labs.slack.com/archives/C0BGPT3G86B/p1790712532902499)
is a recovery-state error, not a special meaning attached to packet 120. With a
successful checkpoint of 111, packets 112–119 fill the eight-packet window. A NAK
requesting 120 moves the old sender's cursor beyond that window without freeing
it. Older pending packets then time out. The same state can occur at other batch
boundaries. The sender is unchanged in the inspected dev and staging revisions.
This was rechecked against staging release source
`e09a07ee7b71972e75a5051003ec561c12e6cb9b` during physical-iPhone testing: the
sender blob still matches the unpatched workspace HEAD (`b027051ad153…`).

## Contract

Treat capture, delivery to the phone, and internet upload as separate outcomes.
The phone's confirmed receipt ends the BLE attempt; an upload failure must not
cause another camera capture or radio retransmission. Existing direct Wi-Fi and
background gallery transports remain part of the design.

Each logical photo should have an immutable ID, real length, content checksum,
and an attempt ID. One state owner should serialize sending, progress, retries,
cancellation, and completion. Every delayed callback belongs to that attempt.
An ACK is a verified checkpoint; a NAK is a request to recover from a cursor.
The two must not share one variable. All queues, retries, and no-progress waits
need finite bounds, with a terminal error delivered to the original caller.

CoC is a faster bearer for the same logical transfer. Keep GATT available when
opening fails. A future opening policy can retry explicit errors a bounded
number of times. CoreBluetooth offers no API to cancel only an unresolved open,
so overlapping retries are unsafe and fallback requires agreement with BES.
A bearer change during a transfer must either preserve the negotiated frame
contract or explicitly end that attempt and restart with new metadata.

## First repair in this branch

- Serialize ASG transfer mutations; invalidate old packet and confirmation timers.
- Give NAK recovery a bounded window without inventing successful ACKs; stop the
  pump during backoff and skip already acknowledged bytes when success overtakes it.
- Reject impossible ACK indices and unrelated phone confirmations. Snapshot the
  dynamic-payload flag with the transfer metadata.
- Use the dynamic-payload flag to interpret real sizes on iOS and Android. Preserve
  the legacy inflated-size format, validate dynamic packet lengths, and reject
  out-of-range packets.
- Reject queued frames from an iOS CoC channel that has already been replaced.

These changes retain the existing wire protocol. Its ACKs still lack attempt IDs,
so a delayed *wire* ACK from a prior attempt cannot always be distinguished from a
current one. Local callback isolation does not solve that protocol limitation.

## Coordinated follow-up

1. Version the transfer header with attempt identity, real length, negotiated chunk
   size, and checksum. Require metadata acceptance before data. Make every BES NAK
   consistently report the next required UART packet; currently checksum failures
   and unexpected-index failures have different index semantics.
2. Surface terminal BES queue/CoC send failures to ASG. Validate packet zero before
   resetting firmware state. Bind firmware channel callbacks to connection/channel
   identity, and reject a second channel while the first owns the transfer.
3. Retain bounded completion receipts on both ends so losing the final confirmation
   cannot create a duplicate photo or an unrelated generic-file transfer.
4. Measure capture, UART acceptance, last phone byte, phone confirmation, and upload
   separately. Keep throughput tuning behind successful recovery and integrity tests.

## Qualification

Use a fixed physical pair and record app/ASG/BES identities. Compare cold and warm
photos, microphone on/off, several photo sizes, and both bearers. Inject NAKs,
invalid ACKs, delayed callbacks, missing packets, lost completion, and disconnects.
Success requires a decodable image with the expected bytes, one final caller
outcome, released transfer ownership, and a successful next request.

The local evidence is under `.context/ble-photo-hardware/`; deterministic regression
coverage lives beside the sender and receiver sources. iOS-on-Mac exercises real
CoreBluetooth and the physical glasses. It does not qualify iPhone-specific radio,
lock-screen, or background behavior. The user reported that CoC may never have
worked on iPhone. The initial Mac-only investigation could not resolve that;
the subsequent physical-iPhone results below demonstrate a working combination.

## Compatibility and rollout risk

The current patch retains packet layouts, opcodes, ACK index semantics, and
capability negotiation. It consumes the existing dynamic-payload flag rather
than introducing a new protocol version. Legacy inflated-size headers remain
supported. No BES firmware change or coordinated all-device upgrade is required
by the protocol. An old phone still retains its old receiver bugs when paired
with the repaired ASG sender.

| Combination | Evidence |
| --- | --- |
| Patched ASG + baseline app + BES 26.9.27.0 | Two successful real Mac/glasses photo transfers, including injected NAK |
| Patched app + older ASG/BES formats | Receiver unit coverage for legacy inflated sizes and unflagged large payloads; no physical mixed-version qualification |
| Patched app + patched ASG + BES 26.9.27.0 | Nine successful real Mac/glasses photo transfers |

Rate the combined patch **medium risk**, pending broader qualification. Sender
locking, recovery, and ACK validation change a shared file-transfer path used by
photos and incident logs. Receiver validation becomes stricter; format examples
do not establish compatibility with every shipped firmware revision. The iOS
receiver also now rejects indices outside its computed packet count instead of
extending the count on arrival, including for legacy transfers.

The exploratory five-second CoC deadline and explicit-error retries were removed
before preparing the PR. Opening policy remains unchanged. Timeout/error handling
has not been qualified on iPhone. GATT-only photo delivery passed the controlled
comparison below; that does not exercise a failed or unresolved CoC open. A local
deadline cannot prove that BES has switched back to GATT while an open remains
unresolved. Do not describe this work as a demonstrated iPhone CoC opening fix. Qualify
physical iPhone and Android, old/new pairings, GATT-only transfer, and incident
logs before broad rollout.

## 2026-09-29 local results

The hardware results below used the sender/receiver candidate with the exploratory
CoC opening policy still present. The successful data paths are covered; these
results are not qualification of its error/timeout branches. The PR omits that
policy. Source/binary identities are retained with the local evidence.

Built and installed the iOS-on-Mac Release app from this workspace and the locally
signed ASG debug app (303003028-dev) on the selected physical Mentra Live.
BES remained 26.9.27.0; no MCU firmware was flashed.

- Six production-sender regression tests, three Android receiver tests, and three
  Swift receiver tests passed. Swift receiver tests ran in an isolated SwiftPM
  target using the actual source/tests and logging/protocol-constant stubs.
- iOS Release, ASG debug APK, and Android Bluetooth SDK builds passed.
- Five baseline photos, two photos with only the sender patched, and nine with
  both apps patched completed. All 16 downloaded JPEGs decoded successfully and
  matched the sender's byte count. SHA-256 values are recorded for the downloaded
  files; this is not an independent source-versus-destination checksum proof.
- The five patched microphone-concurrent medium photos took 5.887–6.734 seconds
  end to end and delivered 116–134 audio callbacks during each capture.
- In one injected-NAK comparison, the baseline logged 59 NAK handling events;
  the patched sender logged one. Both delivered the image. This is a fault
  recovery observation, not a general throughput benchmark.
- The exact packet-120 deadlock is covered by the deterministic production-sender
  test; the hardware injection targeted packet 8.
- Three patched CoC opens succeeded on Mac (about 649, 317, and 341 ms).
  Physical-iPhone testing followed below. Open-timeout/error retry branches
  still need targeted hardware qualification.
- A photo finished before the manual disconnect took effect; that case does not
  prove mid-transfer recovery. A subsequent scripted app termination did interrupt
  a transfer: ASG ended it with coc_closed, and a new photo succeeded after relaunch.
  There is no caller result for the terminated process.

Temporary log collectors and the diagnostic miniapp runner were stopped after
verification. The patched iOS/ASG apps remain installed. No changes were pushed
or promoted to staging.

## Physical iPhone follow-up

On the same day, the user connected an iPhone 15 (iOS 26.6.2, 23G90), enabled UI
Automation, and paired E7FA after the Mac app was terminated and its Bluetooth
connection disconnected. The glasses still ran the repaired ASG 303003028-dev
and unchanged BES 26.9.27.0. This is not a test with the original ASG restored.

The existing iPhone app was 3.2.1 / 302010062, displaying 3.2.1-beta.481 and using
staging services. Before installing any iOS patch, CoreBluetooth opened PSM
0xC9: bluetoothd logged the request at 16:30:49.792 and channel connection at
16:30:49.842; the app logged its attached channel at 16:30:50.171. BES reported
CoC, peer MTU/MPS 1251, 2M PHY, and a 15 ms connection interval. The initial
400-byte payload report changed to 800 bytes once phone capability negotiation
completed; it was not a persistent iPhone throughput limit.

Four existing-app photo requests succeeded: one idle (9.652 s), then three with
microphone traffic (9.845, 7.379, and 8.075 s, with 197, 148, and 160 audio
callbacks). Every downloaded JPEG decoded and matched ASG's original byte count.
These timings include capture and the staging photo-URL path, not just CoC.
Evidence: `.context/ble-photo-iphone/phone-runtime.log`, `glasses-runtime.log`,
`baseline-transfer-summary.json`, and `image-verification.json`.

The local iOS build initially targeted dev, which prompted a fresh sign-in on
this staging phone. It was rebuilt with staging configuration and reinstalled
without uninstalling the app. The native build number remains 303003028; the
exact artifact identity is in `staging-build-manifest.json`. Its CoC open at
16:48:07.578 completed at 16:48:07.633. The user completed account sign-in and
patched physical-phone testing resumed. No BES firmware was flashed.

Phone UI setup uses an isolated XCTest runner under `.context/ble-photo-iphone/`
and direct devicectl/ADB logging. Its idle-wait adaptation is test-runner-only:
continuous app Bluetooth activity otherwise stalls XCTest before taps. It does
not alter the app's transport. The diagnostic miniapp uses the Mac's LAN server;
initial reachability attempts timed out, then a retry succeeded. Neither setup
issue is evidence of a CoC opening failure.

Extended legacy receiver checks passed on Swift and Android: complete byte-for-byte
reassembly with 221-, 400-, and 800-byte packs, short final packets, reversed
arrival order, and the legacy batched-ACK flag.

After sign-in, four patched foreground photos succeeded (9.439 s idle;
10.176, 7.577, and 7.382 s with microphone). All four downloaded JPEGs decoded
and matched the sender's byte count. A background photo with microphone also
succeeded (11.245 s, 225 audio callbacks). A background NAK-8 injection returned
success (11.227 s, 224 callbacks); ASG handled one NAK and forward progress
overtook the delayed retry. These are not controlled throughput comparisons.

Terminating the app after a high-size transfer started interrupted the file at
17:02:31. ASG reported `coc_closed` and released the transfer. After relaunch,
CoC opened at 17:02:43.878–.933 and the next photo succeeded in 9.951 s, with
decoded bytes matching ASG. The terminated process cannot return a caller result.
A repeated background/microphone case succeeded in 10.780 s, with 215 audio
callbacks and an immediately downloaded, decoded, byte-count-matched JPEG.
These tests backgrounded the app using Home; they did not test a locked phone.

### Controlled iPhone bearer comparison

A local test-only build added an environment guard at `openL2capFileChannel()`.
Launching with `MENTRA_TEST_FORCE_GATT=1` skipped CoC opening while retaining
the normal GATT data path. After three GATT photos, the original patched app
was restored and three CoC photos were taken. The source was restored exactly
after the test build; the guard is not in the branch diff. No BES change was
needed. Artifact identities and the temporary source are saved under
`.context/ble-photo-iphone/`; `comparison.json` records individual measurements.

Both groups used the same physical pair, foreground app, microphone off, medium
photos, and no additional image compression. Each group included its first
photo after launch. Image sizes varied (about 251–274 kB); this is an exploratory
three-per-bearer comparison, not a randomized benchmark or identical-byte replay.
All six downloaded JPEGs decoded and matched ASG's byte count.

| Median measurement | GATT | CoC |
| --- | ---: | ---: |
| Negotiated payload | 474 bytes | 800 bytes |
| ASG UART send through final MCU ACK | 5.419 s | 3.405 s |
| Phone-observed file delivery | 6.648 s | 5.098 s |
| Byte-normalized file delivery rate | 40.26 KiB/s | 49.48 KiB/s |
| Full camera request through returned URL | 10.612 s | 6.888 s |

CoC delivered about **23% more bytes per second**, with approximately **1.55 s
less median file-delivery time**. Phone-observed delivery is measured from the
photo-ready notification to reassembly, not a radio-layer throughput counter.
The larger end-to-end difference also includes capture variability and must not
be attributed wholly to CoC. Both bearers worked. This compares the bearers in
the patched flow; it is not evidence that this patch made CoC faster than the
existing iPhone app, which already opened and used CoC successfully.

The final repeated NAK-8 case succeeded in 9.691 s with a decoded,
byte-count-matched image. In total, the physical iPhone returned 19 successful
photo results: four existing-app/CoC, twelve patched-app/CoC, and three
patched-app/GATT. Seventeen images were downloaded and verified; the two
pre-deployment URL losses described below remain unverified. One additional
capture was intentionally interrupted by terminating the phone app.

At completion, the original patched staging-configured app was restored on the
iPhone, CoC was enabled, the diagnostic miniapp was stopped, the temporary
XCTest runner was uninstalled, and log collectors/server were stopped. The
inactive diagnostic miniapp entry remains available for later local testing.
E7FA remains paired to the iPhone; the Mac remains disconnected. The normal
local build product and manifest were restored and their executable hash
matched the pre-comparison artifact. No source, app, or firmware was published.

## Staging photo URL durability observation

The staging cloud was independently redeployed during phone testing:
[deployment job](https://github.com/Mentra-Community/MentraOS/actions/runs/36642468429/job/109675600179)
ran 00:00:04–00:02:43 UTC on September 30. URLs for earlier successful photos
subsequently returned HTTP 404, while the post-relaunch URL and later background
photo were readable. The first eight JPEGs had already been downloaded and
verified. The first background and NAK-injection images had not been downloaded
before the 404s, so those two results establish phone/ASG completion, not verified
end-to-end image integrity. The repeated background case was verified.

The returned `/api/camera/blob/photos/…` URLs correspond to the runtime's local
storage provider. Its files live in a process host's temporary directory; this
provider has no shared or durable storage guarantee across pod replacement.
The timing is consistent with files disappearing during deployment, but the
live pod/filesystem configuration was not inspected: the local Porter session
was expired. This is separate from CoC and must not be counted as a radio failure.
Staging should use durable shared object storage (the existing R2/S3 provider
plus its completion integration), with a test that reads an issued photo URL
after runtime replacement. No cloud configuration or deployment was changed.
