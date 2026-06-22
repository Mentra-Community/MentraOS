# Testing: UDP liveness and reversible WebSocket audio fallback

**Status:** Partially implemented.

Implemented local coverage:

```bash
bun test packages/cloud-client/src/modules/runtime/runtime.reconnect.test.ts \
  -t "falls back to WS"

bun test tests/audio.integration.test.ts \
  -t "UDP liveness probe"
```

The first test proves the shared cloud-client policy with fake transports:
UDP timeout switches to WS, and one UDP ack switches back to UDP. The second
boots local core + runtime + test-oem, sends an encrypted UDP liveness probe,
receives `audio.udp_liveness_ack` over WS, and verifies the probe did not enter
the Redis audio stream.

This feature must be tested at four layers: pure cloud-client unit tests,
runtime integration tests, headless Node/Bun E2E, and real phone E2E against both
local dev and Porter dev.

## Cloud-client unit tests

Add tests around the audio transport manager:

- starts on UDP when WS is alive and a UDP ack is received;
- switches to WS when WS is alive and UDP liveness times out;
- does not switch to WS when WS is dead;
- while on WS, one UDP ack switches back to UDP;
- reconnect clears old UDP liveness and starts probing the new sessionTag;
- `onStatusChanged` emits `audioTransport` changes exactly once per transition;
- `sendAudioFrame` routes to only one real transport at a time.

These tests should use fake WS and UDP transports and run under Bun.

## Runtime integration tests

Add tests in `@mentra/cloud-runtime`:

- UDP liveness probe validates and emits WS ack;
- probe packets are not written to Redis audio stream;
- invalid/forged probe packets do not ack;
- WS binary audio writes the same Redis stream entry shape as UDP audio;
- worker/provider path is transport-agnostic after Redis.

## Headless Node/Bun E2E

Use the Node cloud-client build against local runtime services:

1. normal UDP path receives ack and sends audio over UDP;
2. block/drop UDP packets in the test UDP socket, keep WS alive, verify WS audio;
3. unblock UDP, verify first ack switches back to UDP;
4. kill WS, verify audio transport becomes `none` and not `ws`;
5. reconnect WS with a new sessionTag, verify stale UDP ack is ignored.

This must run in CI without React Native.

## Real phone E2E: local dev

Extend `cloud-v2/scripts/audio-fault-e2e.ts` with default scenarios:

- `udp-blocked-ws-fallback`: runtime WS alive, UDP ingress blocked. Expected:
  status pill shows `Cloud V2: WS`, cloud captions continue, local/offline STT
  does not start solely because UDP is blocked.
- `udp-restored-switchback`: start with UDP blocked and WS fallback active, then
  restore UDP. Expected: first UDP ack switches pill to `Cloud V2: UDP`, captions
  continue, no duplicate transcript cards.
- `ws-down-udp-down`: block both WS and UDP. Expected: cloud transport is `none`
  or disconnected, local/offline fallback takes over if subscribed.
- `session-reconnect-resets-probes`: restart runtime while Local Captions is
  active. Expected: new sessionTag, probes restart, subscriptions recover.

Local fault injection can be implemented with harness-level packet dropping,
runtime flags that ignore UDP probes/audio, or OS firewall rules. The test must
capture logcat, screenshots, and cloud logs.

## Real phone E2E: Porter dev

Add Porter-safe fault hooks:

- disable UDP ingress or UDP service route while leaving runtime WebSocket up;
- restore UDP ingress;
- restart runtime/audio worker while the phone is on WS fallback.

The harness should accept `--down-command`/`--up-command` hooks for these cases,
but the default scenario list should include UDP-specific names so they are not
forgotten during regression runs.

## Pass criteria

- No silent "WS connected but no audio reaches cloud" state.
- No permanent WS fallback after UDP becomes reachable.
- No duplicate real audio frame delivery during probing.
- No offline/local fallback when cloud WS fallback is successfully carrying audio.
- Status pill and logs agree with the active cloud audio transport.
