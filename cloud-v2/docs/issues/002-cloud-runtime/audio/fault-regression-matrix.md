# Audio fault regression matrix

**Status:** Living QA checklist. Update this whenever E2E testing finds a new
edge case, even if the fix is not implemented yet.

## Purpose

Cloud-v2 audio is a live system: the phone, local runtime, cloud-client,
cloud-runtime, Soniox, and the Local Captions miniapp all carry state. Bugs often
appear only when one part fails and later recovers. This matrix records the
failure modes we have seen or expect, the desired behavior, and the regression
coverage needed so the same class of bug does not return.

## Core invariants

- If a local miniapp is subscribed to transcription and cloud transcription is
  unavailable, local STT must start and keep producing captions.
- If cloud transcription becomes available again, local STT must stop and cloud
  transcription must resume without app restart.
- Offline and online transcript sources must never both publish the same
  utterance to the miniapp.
- Interim transcript updates may replace an in-progress card, but a final
  utterance must not replace an older final utterance from another speech segment.
- Cloud reconnect must preserve active subscriptions and audio configuration.
- Provider/session restarts must not reuse transcript identities in a way that
  mutates old transcript history.

## Faults and edge cases

| ID | Fault / trigger | Desired behavior | Failure signature | Regression coverage |
| --- | --- | --- | --- | --- |
| AUD-F01 | Cloud unavailable when Local Captions subscribes | Client retries indefinitely; local STT starts within a short delay; captions appear offline | App stays in "cloud down" with no offline captions, or reconnect loop stops | Phone E2E: start Local Captions with cloud down, speak marker, verify offline card and retry logs |
| AUD-F02 | Cloud goes down while online captions are active | Runtime disconnect event fires; local STT starts; offline captions continue | Captions freeze after cloud kill / laptop sleep | Phone E2E: online marker, kill cloud, offline marker |
| AUD-F03 | Cloud comes back after offline fallback | Runtime reconnects; active subscription is resent; local STT stops; next online utterance appends as a new card | Fallback stays active, no cloud transcript, or online + offline both publish | Phone E2E: kill cloud, offline marker, restart cloud, recovery marker |
| AUD-F04 | Cloud unavailable on first connect, then later available | Same as AUD-F03; failure on the first attempt must not permanently poison the session | Client never connects because the first failed socket captured stale state | Cloud-client unit reconnect test plus phone E2E with cloud started late |
| AUD-F05 | Laptop sleep / dev server closed / USB unplug-replug during local dev | Phone falls back offline while cloud is unreachable, then recovers when laptop/cloud returns | After laptop wakes, neither offline nor online captions work | Phone E2E: simulate laptop sleep by killing cloud and Metro separately, then restore |
| AUD-F06 | Local dev host/IP changes while the app is running | Runtime repairs or rebuilds config so future connects use the reachable host | Reconnect loop keeps dialing stale LAN IP forever | Mobile unit coverage for dev host fallback/stale local miniapp URL repair; manual Wi-Fi/IP change test |
| AUD-F07 | Access token expires or reconnect receives 401 | Refresh token and retry; user should not be logged out | User unexpectedly logged out, or reconnect dies after 401 | Cloud-client unit test: 401 on reconnect causes refresh and successful next connection |
| AUD-F08 | Active subscription lost across reconnect | Initial subscriptions are included in handshake and latest set is resent after reconnect | WS connected but provider is never created; audio flows with no transcripts | Cloud-client runtime reconnect test; phone E2E recovery marker |
| AUD-F09 | Stale subscription write races with live session | Server ignores stale `sessionId` or older `version` writes | Empty/stale subscription clears live transcription after reconnect | Runtime REST subscription tests for session/version ordering |
| AUD-F10 | UDP audio ingress works but no transcript output | Correct codec/frame-size is negotiated and decoder matches phone LC3 frame size | UDP packets append to Redis/cloud logs, Soniox connected, but no useful transcript | Protocol/cloud-client tests for `audio.frameSizeBytes`; phone E2E with phone mic LC3 frame size |
| AUD-F11 | LC3 frame-size mismatch, especially 60-byte phone frames decoded as 20-byte frames | Phone sends LC3 frame size in `connection.init.audio`; worker recreates decoder when size changes | Garbled PCM / silence / Soniox never produces transcripts | Unit tests for handshake validation and worker codec set; phone E2E marker |
| AUD-F12 | Soniox rolling token window re-diarizes speaker mid-utterance | Keep one utterance id until a real endpoint/finalized boundary | One sentence creates a pile of growing final cards | Soniox provider unit: speaker flip does not churn finals/utterance IDs |
| AUD-F13 | Soniox session unexpectedly disconnects while provider remains in worker map | Provider self-heals by creating a new upstream session and resumes transcripts | Captions freeze until app/cloud restart | Soniox provider unit: disconnect creates replacement session and resumes |
| AUD-F14 | Audio stops briefly without provider endpoint | Provider auto-pauses/finalizes after audio gap, then resumes with fresh state on new audio | Interim card hangs forever or next utterance appends into old interim | Soniox provider audio-gap pause/resume unit tests |
| AUD-F15 | Provider/process restarts with same user/subscription scope | New provider instance mints globally unique utterance IDs; old final cards are not mutated | First online utterance after cloud restart overwrites the first online card before outage | Soniox provider unit for same-scope provider IDs; phone E2E online-offline-online history check |
| AUD-F16 | Local STT emits interim then final for one utterance | Final replaces the interim/in-progress card once; only one final card remains | Offline utterance appears twice, once interim and once final | Mantle listener-count unit test; phone E2E offline marker |
| AUD-F17 | Duplicate native `local_transcription` listeners | Exactly one JS handler processes each native event | Every local transcription event logs/forwards twice | Mantle unit: one `local_transcription` listener after init; phone log check |
| AUD-F18 | Offline fallback remains active after cloud reconnect | `local_stt_fallback_active=false`; local STT stops before cloud transcripts resume | Both offline and online transcription run at the same time | LocalSttFallbackCoordinator tests plus phone E2E cloud down/up |
| AUD-F19 | Online recovery transcript ordering | New final online result appends after the offline result, preserving history order | Recovery result edits an older row or appears above the offline row | Phone E2E: online A, offline B, online C; verify A, B, C all visible in order |
| AUD-F20 | Cloud badge/status while fallback is active | UI exposes cloud-client connection state and the active audio/fallback transport accurately | UI shows "Cloud" green while offline fallback is generating captions | Mobile debug pill backed by `cloud.runtime.getStatus()`; Local Captions indicator backed by `session.cloud`; E2E screenshot assertion |
| AUD-F21 | Local miniapp dev bridge reconnect after app reload | Dev bridge reconnects, subscriptions re-register, mic starts | Local Captions stays on "Starting..." or no subscription after reload | Dev E2E: force-stop app, relaunch deep link, verify `CONNECT`/`SUBSCRIBE` and marker |
| AUD-F22 | Metro not running in dev build | Dev build shows Metro error; release build has packaged JS bundle | "Unable to load script" blocks E2E until Metro starts | Dev setup check: Metro on 8081, adb reverse/host reachable before phone E2E |
| AUD-F23 | UDP audio transport blocked while WebSocket runtime stays connected | Client detects no UDP liveness failure and falls back to WS binary audio as the last-resort cloud transport, then switches back on the first UDP ack | Phone shows WS connected/PCM active, but cloud receives no audio and no fallback starts because the client thinks it is connected; or WS fallback never returns to UDP | Dedicated issue: [`004-cloud-client/udp-liveness-fallback`](../../004-cloud-client/udp-liveness-fallback/). Add network tests with UDP blocked/restored and WS binary fallback enabled |
| AUD-F24 | Worker/provider duplicate creation for one user/subscription | Worker reconciles idempotently; exactly one provider per user/subscription | Two providers publish duplicate transcripts or fight over state | Worker unit/integration test for repeated attach/subscription updates |
| AUD-F25 | Worker crash or provider map loss mid-session | Worker reattaches user, restores codec/subscriptions, resumes from stream | Connected phone has no provider after worker replacement | Runtime worker-pool fault injection test |
| AUD-F26 | Redis transient or stream replay after failover | Audio that reached Redis is replayed in order; captions may delay but not gap | Words missing after pod/worker failover | Runtime integration with Redis pause/worker restart and marker audio |
| AUD-F27 | Phone app foreground/background during active captions | Foreground reconnect does not clear live subscriptions; background does not wedge mic/fallback | Returning to app leaves captions frozen | Phone E2E: background app during online and offline states |
| AUD-F28 | Local SDK session status unavailable to miniapp | Miniapp can show whether transcripts are cloud or offline/fallback | Miniapp cannot tell users it is offline; misleading UX | `session.cloud.status` + `session.cloud.onStatusChanged`; SDK unit test; Local Captions indicator |
| AUD-F29 | Foreground WebView reuses a stale local-miniapp background JSContext | Opening/resuming the WebView probes background liveness and respawns quickly if the context is wedged | Local Captions WebView opens, shows cloud offline/no transcripts for ~30s, then watchdog respawns it; logs show missed pings or `QuickJSJni: Cannot get jni env because the vm is not cached` | Mobile host unit for foreground probe; phone E2E: open Captions after stale context, verify recovery within probe timeout and marker transcript |

## Manual phone E2E script

Prefer the repeatable harness in [`e2e-fault-harness.md`](./e2e-fault-harness.md)
for local and Porter runs. The manual script below is the underlying phase order
and the visual pass criteria.

Use distinct spoken markers so screenshots prove ordering:

1. Start Metro, local cloud, and Local Captions dev server.
2. Launch the app and Local Captions; verify `LOCAL_MINIAPP: SUBSCRIBE` and
   `cloudClient: runtime connected`.
3. Speak online marker A.
4. Kill local cloud.
5. Wait for `[LocalSttFallback] cloud connection -> down` and
   `local_stt_fallback_active = true`.
6. Speak offline marker B.
7. Restart local cloud.
8. Wait for `cloudClient: runtime connected`,
   `[LocalSttFallback] cloud connection -> up`, and
   `local_stt_fallback_active = false`.
9. Speak online marker C.
10. Screenshot Local Captions. Pass if A, B, and C are all present as separate
    rows, in order, and B appears only once.

## Current evidence from 2026-06-09 phone session

- Happy path online transcription worked with cloud-v2 and Soniox.
- Cloud-down fallback produced offline transcripts.
- Cloud-up recovery resumed online transcripts without app restart.
- Duplicate offline final card was reproduced and fixed by removing a duplicate
  native `local_transcription` listener in `MantleManager`.
- Online recovery overwriting the first online card was reproduced and fixed by
  making Soniox provider utterance IDs unique across provider instances.
- Cloud-client runtime status is now exposed to mobile debug UI; the existing
  core/cloud-v1 pill is no longer the source of truth for cloud-v2 audio health.
- Local miniapps now receive cloud-client status through `session.cloud`. Local
  Captions shows an explicit transport indicator (`UDP`, `WS`, `Offline`,
  `Connecting`, or `Retrying`) so fallback mode is visible to users and E2E
  screenshots can assert the active path.
- Pixel 8 USB E2E with Doppler-backed local cloud verified:
  - phone subject-token exchange succeeds only when the local core has
    `MENTRA_CORE_JWT_SECRET` / `SUPABASE_JWT_SECRET`;
  - killing local cloud transitions Local Captions from `Cloud captions` to
    `Offline captions`, starts `LocalSttFallback`, and keeps retrying;
  - restarting local cloud reconnects without phone app restart, refreshes auth,
    re-applies the transcription subscription, stops local STT, and returns to
    `Cloud captions`;
  - real Soniox provider produced a cloud transcript after recovery.
- Local cloud without Doppler auth env failed exchange with
  `500 server_error` (`MENTRA_CORE_JWT_SECRET` missing). Treat that as a setup
  fault, not a reconnect-loop failure.
- `scripts/dev-stack.ts` now defaults the test-OEM to port `3102` so it does not
  collide with the Local Captions dev server on `3100`, and auto-advertises a
  LAN IPv4 for UDP when `DEV_UDP_ADVERTISE_HOST` is not set. Override with
  `DEV_UDP_ADVERTISE_HOST=<host>` if the detected interface is not reachable
  from the phone.
- Mock provider mode is useful for transport smoke tests but floods the Local
  Captions history because it emits one final transcript per audio write. UI
  ordering tests should use real Soniox or a less chatty mock fixture.
- Remaining known transport gap: UDP-blocked networks still need client-side WS
  binary audio fallback. The runtime/cloud side accepts WS binary audio, but the
  cloud-client mobile path currently sends only UDP. See
  [`004-cloud-client/udp-liveness-fallback`](../../004-cloud-client/udp-liveness-fallback/).
- 2026-06-14 Pixel 8 run reproduced AUD-F29: after closing Local Merge and
  opening Local Captions, the WebView connected but captions appeared offline for
  about 30 seconds. Logs showed repeated `QuickJSJni: Cannot get jni env because
  the vm is not cached`, then `com.mentra.local-captions missed 6 pings`,
  followed by crash-recovery respawn, `SUBSCRIBE transcription:auto`, PCM
  restart, and healthy `Cloud captions / UDP audio`. The mitigation is the
  foreground liveness probe documented in
  [`006-dev-toolkit/local-sdk/mobile-local-runtime-liveness.md`](../../006-dev-toolkit/local-sdk/mobile-local-runtime-liveness.md).
