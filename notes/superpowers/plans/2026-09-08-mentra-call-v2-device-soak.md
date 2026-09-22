---
status: active
owner: mentra
---

# Mentra Call V2 device soak

Acceptance testing for the V2 increment (End, mute, Android SoftAP). No LC3 in this pass, and no V1
comparison — the bar is that every control and media path works every time.

Every finding goes onto Linear **Mentra Call V2** under To Do as a checklist item the same day.
Slack holds the videos and log dumps; Linear holds the work.

## Rig

- Glasses on `MentraLive_20260816` or newer.
- Phone Wi-Fi **on** (the radio is what `WifiNetworkSpecifier` needs), internet on cellular.
- VPN off, or the Mentra App split-tunnelled out of it. A VPN that captures the app UID makes the
  glasses unreachable and the join refuses up front with `SOFTAP_VPN_ACTIVE`.
- Forget any saved `MentraLive_*` network on the phone, so each run exercises a real scoped join
  rather than a remembered one.
- A laptop signed into Teams as the second participant.

Log capture, one terminal per device:

```bash
# Phone: orchestrator, scoped network, ACS, ICE path
adb -s <phone> logcat -c && adb -s <phone> logcat | rg 'SOFTAP_TRACE|AcsMeeting|LocalWhipIngest|mentra-call'

# Glasses: hotspot and WHIP publish
adb -s <glasses> logcat -c && adb -s <glasses> logcat | rg 'SOFTAP_TRACE|WhipStreaming|StreamCommand'
```

Save the phone capture to a file and let the analyzer grade it rather than reading it by eye. It
settles the mechanical proofs per call — sequence order, no Cloudflare, host-only ICE, the selected
ICE pair and its byte flow, reverse teardown, and no teardown-caused hotspot loss — and prints the
proofs that need ears on the Teams call instead of quietly passing them:

```bash
node scripts/softap-call-proof.mjs analyze phone.log            # one call, or a whole soak
node scripts/softap-call-proof.mjs analyze phone.log --cycles 12  # fails if a cycle is missing
```

A per-call verdict is the point: a run where cycle 1 was clean and cycle 7 leaked has to fail, and
an aggregate check would miss it.

## Reading the trace

`SOFTAP_TRACE` lines carry a `traceId` shared by phone and glasses, so one id greps a whole call
across both devices. The lines that decide a pass:

| Line | What it proves |
|---|---|
| `phase=softap_call_live` | The orchestrator finished all five steps. |
| `ingest_selected_pair local=… bytesFlowing=true` | Media is on the hotspot interface and packets are arriving. This is the real SoftAP proof; the SDP guard only checks what was offered. |
| `ingest_selected_pair_off_hotspot` | **Fail.** ICE picked an interface that is not the network we joined. The call is killed with `ice_off_hotspot`. |
| `ingest_selected_pair_idle` | Pair is right, nothing arriving yet. Not terminal on its own — the first-frame gate owns that verdict — but two in a row on a call with no picture is worth a ticket. |
| `webrtc_network_inventory` | Which interfaces libwebrtc can see. During a SoftAP call it should list the hotspot interface. |
| `whip_config_resolved hostOnlyIce=true` (glasses) | The glasses are gathering host candidates only. `false` means an old ASG build. |
| `phase=scoped-lost` | The hotspot went away while we still wanted it. |
| `phase=scoped-lost-expected` | The hotspot went away because we released it. Never an error. |

## Controls loop

Repeat until it stops flaking. Each iteration:

1. Create a meeting, copy the link, laptop joins.
2. Mute → laptop hears silence, wearer still hears the laptop. Unmute → talk both ways.
3. **Leave** → wearer lands on "You left the call", laptop stays in the meeting → wearer rejoins.
4. **End** → laptop is dropped, and the same link does not re-enter a live meeting → create a new
   meeting → join.

Pass requires all of:

- Leave and End are visibly different outcomes on the glasses and for the laptop.
- End is disabled (not hidden, not enabled) on a meeting this session did not create.
- A failed End lands on "Meeting may still be active" — never a clean home transition.
- A double-tapped End does not produce an error the second time.

## SoftAP loop (Android)

Per call: no Cloudflare session on the ACS path, `ingest_selected_pair` local address inside the
scoped prefix with bytes increasing, Teams picture stable from join through exit.

Then exercise every exit and check for a leftover AP each time. `adb shell dumpsys wifi | rg -i
softap`, or simply look for `MentraLive_*` in the phone's Wi-Fi list:

| Exit | Expected |
|---|---|
| Leave | No `MentraLive_*` AP, no `scoped-lost` error |
| End | No AP, laptop dropped |
| Remote hangup (laptop ends) | No AP — the host still owns the hotspot even though the meeting is gone |
| Fatal join failure | No AP, error names the step that broke |
| Mid-call hotspot loss | No AP, honest `softap-lost` error |

Mid-call drop, run both ways:

- Turn the glasses hotspot off during a call → terminal error naming the hotspot, **not** a
  reconnecting spinner. Leave and End still work from that screen and leave nothing behind.
- Walk out of range until the phone drops the network → same.
- Then a normal Leave and a normal End, checking that neither produces a `softap-lost` error. A
  false positive here is the bug the terminal-intent flag exists to prevent, and it will show as
  `phase=scoped-lost` where `phase=scoped-lost-expected` belongs.

## Phone-in-pocket soak (high priority)

The one the open-screen soak cannot catch: a scoped `requestNetwork` callback, the foreground
liveness probe, the WHIP listener and ACS media all behave differently once the app is not on
screen, and a field worker's phone is in a pocket for the whole call.

1. Establish a SoftAP call, confirm the Teams picture.
2. Lock the phone, or background the Mentra App.
3. Leave it several minutes. Keep talking; have the laptop talk back.
4. Verify Teams video and audio continue throughout — watch the laptop, not the phone.
5. Unlock, Leave, then rejoin.

Fail if the video stalls, the audio drops, the miniapp is killed, or the hotspot is left behind
after the Leave.

## Rejoin soak

Leave → rejoin and End → create → join, back to back, a dozen times each. This is what exercises
the generation tagging in the terminal machine: a stale callback from the previous call must be
dropped rather than tearing down the current one. Watch for `terminal callback dropped` in the
miniapp log — seeing it is healthy; a call ending on its own right after a rejoin is not.

## Done when

Create → copy → expert joins. Leave exits the wearer only. End terminates the group call for
everyone and retires the meeting, or says honestly that it could not. Mute works. Android SoftAP
video reaches Teams every time on the proven hotspot interface: no Cloudflare, no orphan hotspot,
rejoin works, and the call survives the phone going in a pocket. The iOS spike is logged pass or
fail.
