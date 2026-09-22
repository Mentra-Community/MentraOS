---
status: active
owner: mentra
---

# ACS uplink collapse — ceiling A/B

## The finding this is built on

An 8-minute Join (`outputs/acs-quality/join-6818e596.log`) shows the actual fault, and it is not
where the earlier work looked:

```
    t(s)   ACS bps  ACS size sentFps   glasses bps  inFps
    21.7   1332086   960x540    15.0       1563336   14.4
   159.9     95659   320x180    14.0       2202676   14.5
   340.0     33076   320x180    15.0       2155046   14.5
   440.1    612177   960x540    15.0       2002308   14.5
   500.2   1282704   960x540    15.0       2080667   15.0
```

The glasses hop held ~2 Mbps at 14.5 fps for the entire call and the phone kept handing ACS 15 fps.
ACS chose to spend 33 kbps and dropped to 320x180 for ~90 s, then took ~170 s to climb back. The
same call type at 3 Mbps stayed clean for 89 s (`join-8251a9b7`), so short calls cannot see this.

Three consequences:

1. The camera, the hotspot, and our WHIP ingest are all exonerated. They were nominal throughout.
2. Origin is a red herring. The long Start call (`start-78e849b8`) also bottomed out at 42 kbps.
3. There is no minimum-bitrate API on the ACS leg — `maxBitrateBps` is the only knob
   (`mobile/modules/acs-meeting/src/AcsMeeting.types.ts`). A floor cannot be the fix here, which is
   why Mentra-Call#27's approach does not address this failure.

## Hypothesis

ACS ramps aggressively toward whatever ceiling it is granted, concludes the network is congested,
craters its bandwidth estimate, and then recovers very conservatively. If that is right, a **lower,
steadier** ceiling produces a better call than a higher one, because the objective is minimum
quality over the whole call rather than peak bitrate during the good periods.

Falsifiable: if every ceiling collapses the same way, this is an ACS/WebRTC sender-stack problem
that cannot be fixed from Mentra Call, and the next step is an Azure support case.

## Prerequisite: the analyzer had to be fixed first

`scripts/acs-quality-compare.mjs` sampled at +10/+30/+60 s after `connected` and reported a
"settled" bitrate. Every collapse observed so far begins after that window, so the old output would
score a configuration as healthy purely because it failed late. It now reports whole-call
statistics and, critically, how much of the call it actually observed.

Do not judge any arm on the ramp table.

## Running one arm

The bitrate picker is already a clean ACS-ceiling knob on SoftAP at 540p, and this is worth
understanding before trusting a run. Picking an explicit bitrate sets
`toAcsVideo().maxBitrateBps` directly, while the glasses hop is sized by the host's
`softapVideoPolicy`, which pins ≤540p to `GLASSES_PHONE_BITRATE_BPS` (2.5 Mbps) regardless of the
ACS number. So the first hop is held constant and only the ACS grant moves. At 720p that is no
longer true — `softapVideoPolicy` starts following the profile ceiling — so **run the A/B at
540p15 only**.

1. Mentra Call → settings → 540p15, and set the bitrate to the arm under test.
2. Start `adb logcat` capture filtered to `SOFTAP-TRACE`, into `outputs/acs-quality/<arm>-<n>.log`.
3. Run a **10–15 minute** call with a remote participant present. Anything shorter can miss the
   failure entirely; the two clean calls in the current data were 82 s and 89 s.
4. Repeat for each arm, ideally alternating so drifting network conditions do not land on one arm.

Arms: 1.0, 1.5, 2.0, 3.0 Mbps. 3.0 is the current default and the control.

## The throttled arm (closes the Mentra-Call#27 review gate)

Mentra-Call#27 was held on one condition that is still unmet: a pass on a genuinely degraded link
before an encoder floor ships. The floor no longer applies to Auto, so the population the review
worried about is out of range — but an explicitly selected cap still seeds
`minBitrateBps: min(1 Mbps, cap)`, and on a congested link a floor tells the encoder to keep
sending anyway. That converts graceful degradation into loss and freezes. Nobody has watched it
happen.

**Do not run this arm on SoftAP.** The floor lives in the miniapp's `toWhipVideo`, and SoftAP never
calls it — the host `softapVideoPolicy` owns that hop. A throttled SoftAP session exercises none of
the code under review and would close the gate on evidence that does not touch it. This arm has to
run on **cloud WHIP with an explicit bitrate cap**, which is the only configuration where
`minBitrateBps` reaches the encoder.

1. Cloud WHIP path, 540p15, bitrate set explicitly (not Auto) — 1.0 Mbps makes the floor and the
   cap coincide, which is the harshest case.
2. Degrade the uplink below the floor, so the estimator and the floor genuinely disagree. Real LTE
   at the edge of coverage is the honest test; a shaped uplink is the repeatable one.
3. Capture as above and run a full 10–15 minutes.
4. Repeat on Auto as the control. Auto is unfloored, so it is the graceful-degradation baseline the
   floored run is judged against.

The question is not which run has the higher bitrate — the floored one will. It is **which failure
mode the wearer gets**. Read `acs_wire_episode` for episode count and duration, and compare the
glasses hop (`inboundBitrateBps`) against the floor: a hop pinned at ~1 Mbps while the link cannot
carry it is the floor overriding the estimator, and the freezes are the cost. Ship the floor only
if the floored run is *not* worse than the Auto control on episode duration and continuity.

## Reading the result

```bash
node scripts/acs-quality-compare.mjs outputs/acs-quality/*.log
```

The verdict is the `WHOLE-CALL STABILITY` block and the `ACS CEILING A/B` block, which ranks arms
by time under 500 kbps per minute of call. Ignore the ramp table.

Two guards to respect rather than work around:

- **`seen` is the coverage column.** Below ~75% the analyzer prints `THIN COVERAGE` and the numbers
  are a floor, not a measurement. Rerun instead of ranking.
- **`in@low`** is the glasses hop during the low episodes. If it is at full rate, the collapse was
  ACS's choice. If it is also low, something upstream broke and that run is not testing the
  hypothesis.

A result that supports capping lower looks like: 1.5M with zero time under 500 kbps and a minimum
near its ceiling, against 3.0M with minutes under 500 kbps and a 320x180 floor. A result that
refutes it looks like every arm collapsing to tens of kbps with similar dwell.

## Instrumentation added for this

| Trace | What it answers |
|---|---|
| `acs_bwe_sample` | Both hops on one line, including `inboundBitrateBps` and `budgetBps` (the arm) |
| `acs_wire_adaptation` | Every resolution change, with `percentOfAsked` and `ceilingBps` |
| `acs_wire_episode` | `begin`/`end`/`recovered` per outage, with floor, duration, recovery, glasses hop |
| `acs_media_stats` | Raw per-report ACS truth, including the empty ones |
| `acs_media_stats_interval` | Whether ACS accepted the 1 Hz cadence |

Sampling cadence now follows `CallDiagnostics.wireHealth` rather than the clock: 2 s during a dip,
a recovery ramp, a fresh downscale, or an ACS silence, and 10 s only for an established full-rate
call. The old cadence went sparse at 90 s, which is before every collapse in the data.

## Known open items

- **`sendQuality` is always `na`.** ACS's own network-quality diagnostic never fired in any
  capture, so there is no independent read on whether the uplink or the estimator is at fault.
- **`interval=no` in every capture so far.** The 1 Hz request was refused on every call; the retry
  budget was six attempts over ten seconds and is now a backoff spanning ~11 minutes. If arms still
  come back thin, this is the first thing to check.
- **`framesGated=84 pacerDrops=51`** on the long Start call: our own pacer discarding frames. Small
  next to a 40x collapse, but it is on our side of the line.
- **Throttled-uplink validation** of the explicit-cap floor is still untested on device. This is the
  outstanding Mentra-Call#27 review gate, and it now has a procedure above rather than a note here.

## If all ceilings collapse

Open an Azure Communication Services support case. The capture isolates the failure to their sender
stack, which makes it a strong report:

```
WHIP incoming:            ~2 Mbps / 15 fps continuously
frames supplied to ACS:   ~15 fps continuously
ACS outgoing:             1.3 Mbps -> 32 kbps
resolution:               960x540 -> 320x180
recovery:                 ~170 seconds
```
