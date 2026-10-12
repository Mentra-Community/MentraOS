# iOS cloud-audio UDP CPU investigation (OS-2012)

## Observed problem

September 29, 2026, physical iPhone 15 / iOS 27.0, G2 connected, Mentra 3.2.1
(302019005). Time Profiler captured the Mentra App in the background over USB.
These are separate conversation windows, not identical audio replays:

| Running miniapps | Wall time | Sampled app CPU | Average, one CPU core | CPU in `getaddrinfo` |
| --- | ---: | ---: | ---: | ---: |
| Captions and Notes | 31.036 s | 28.480 s | 91.8% | 3.899 s |
| Captions | 30.971 s | 11.313 s | 36.5% | 3.776 s |
| Notes | 30.961 s | 8.351 s | 27.0% | 3.561 s |
| Neither, G2 still connected | 31.010 s | 0.949 s | 3.1% | 0.184 s |

The phone also recorded two CPU resource terminations while on battery that
morning (80% and 90% average CPU). A similar report predates the earlier OS-2012
idle speech/location fixes. The speech-time JavaScript hotspot remains a
separate investigation; resolver work does not explain all of that load.

## Change

The `react-native-udp` iOS sender called
`GCDAsyncUdpSocket.sendData:toHost:port:withTimeout:tag:` for every audio frame.
That method resolves the address for each packet, including numeric hosts.
The observed resolver stacks include interface enumeration, NAT64 checks and
network path evaluation.

The Bun patch adds the library's previously unimplemented `connect` operation
on iOS. Cloud audio connects once and queues sends behind that initial lookup.
Subsequent sends use the connected peer. Other UDP callers and Android retain
the unconnected send path. Encryption, nonces and packet format are unchanged.

Cloud liveness recreates a UDP socket after a missed three-second ack window,
while sending audio through the existing WebSocket fallback. This refreshes a
stale peer/route even if the WebSocket remains alive. Session tag, key and packet
sequence survive this socket replacement. Only a recent, pending probe from the
replacement socket can restore UDP audio; delayed old acknowledgments are ignored.
Initial connections and reconnects also send audio over WebSocket until a valid
UDP acknowledgment arrives, so failed DNS/connect does not drop startup audio.
Ordinary cloud reconnects still create a fresh session and socket.

## Repeatable validation

- `cd mobile && bash scripts/test-audio-udp.sh`: compiles the installed native
  client and real CocoaAsyncSocket on macOS. A resolver hook counts calls and
  simulates delayed/failed DNS; datagrams and replies use real loopback sockets.
  Covers one lookup for 100 packets, exact binary payloads, sends queued during
  DNS, unconnected behavior, a replacement peer, DNS failure and close during DNS.
- `cd mobile && bun run test --runInBand test/RnUdpAdapter.test.ts`: uses the real
  patched JavaScript socket with a mocked native bridge; covers iOS ordering,
  unchanged Android calls and replacement/close behavior.
- `cd cloud-v2 && bun test packages/cloud-client`: covers encrypted payload and
  sequence preservation, timed socket replacement, WebSocket fallback and UDP
  recovery without reconnecting the WebSocket.

No current registered device routine covers physical-iPhone cloud transcription
or its CPU cost. The pinned no-glasses routine only opens the glasses-required
guard; Call uses a different media transport; OTA does not exercise cloud audio.
Do not label any of those as coverage for this change.

Proposed device routine: record build identity and existing running miniapps;
connect G2 and start cloud Captions or Notes; verify actual transcript delivery;
background the app and capture CPU during a fixed audio replay. Interrupt and
restore connectivity, require continued WebSocket fallback where available and
recovered UDP acknowledgments/transcripts, then repeat CPU capture. Stop the
last transcription consumer and verify microphone shutdown. Restore the initial
miniapp/mode/network state. On failure retain timestamps, transport state and
profile summaries without uploading user speech or credentials.

Short CPU captures and native lookup counts do not establish battery-life
improvement. Quantification still needs longer alternating runs with controlled
audio, comparable network conditions and direct energy measurements.
