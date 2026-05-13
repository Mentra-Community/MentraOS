# SF Team — Flash Recovery Failure: "Unable to detect CTRL-AP at 2"

**Date observed:** Reported 2026-05-13 (date of the SF-team session itself not recorded)
**Reporter:** SF team, while flashing glasses using a new flashing script provided by Yash
**Status:** Glasses non-functional since the event. Root cause unknown. No further investigation done yet.

## What Happened

The SF team attempted to flash a unit using a **new flashing script** provided by Yash. The script's first step is to recover the network core via `nrfutil`. That step failed with:

```
[1/5] Recovering network core...
❌ Failed to recover 609010923, Device error: Unable to detect CTRL-AP at 2
Error: One or more recover tasks failed:
 * 609010923: Device error: Unable to detect CTRL-AP at 2 (Generic)
```

`609010923` is the J-Link probe serial number. The error fired immediately on the first step of the flashing sequence.

### Before the event

Glasses were operating normally — display was visible / functional.

### After the event

- The unit has not worked since.
- Subsequent attempts via **other flashing methods** also fail (specifics not captured).
- It's not yet known whether the chip is dead, the debug interface is permanently blocked, or there is some other persistent fault.

### Positive control — script works elsewhere

Yash has independently verified the **same script runs successfully on a brand-new Mac in Shenzhen** against a healthy unit. So:

- The script itself is not categorically broken.
- This significantly weakens "script bug" as the root cause.
- The failure is specific to **either** the SF team's environment (host machine, J-Link probe, drivers, cable, `nrfutil` version on their box) **or** to the affected unit (pre-existing damage, latent fault that surfaced during recover).

### Two units affected — strongly points at SF setup

The SF team tried the script on **two separate pairs of glasses** and got the same failure on both. Combined with the positive control above, this is decisive evidence:

- "Pre-existing hardware damage on a single unit" is no longer a sufficient explanation — two independent units failing identically with the same operation is implausible as coincident damage.
- **Something on the SF side is the problem.** Most likely the J-Link probe (firmware version, hardware fault) or the host-side toolchain / USB path. Less likely but still possible: a shared physical issue across both units (same bad cable being used on SF's side that previously damaged both — see [[2026-05-13-usb-cable-misalignment-net-core-damage]]).
- Hardware damage on the units cannot be fully ruled out (the cable-misalignment incident describes a path where physical damage can happen during the SF team's own cable handling — they could plausibly be the agent of their own units' damage if their cable habits are causing it).

## What "CTRL-AP at 2" Means

CTRL-AP is the Control Access Port — an ARM debug component used to perform privileged operations on the SoC, including `recover` (mass-erase + APPROTECT clear). On nRF5340 the debug interface exposes multiple APs at different indices; CTRL-AP for the network core sits at a specific AP index that `nrfutil` walks for during a recover.

"Unable to detect CTRL-AP at 2" means the tool tried to enumerate the network-core CTRL-AP and got no response from the chip. This can happen because:

- The chip is genuinely damaged at the silicon level and the network-core debug subsystem is gone.
- The chip is healthy but the debug interface is being held in a state where it can't respond (power, reset, or APPROTECT-level lock variants the tool can't bypass).
- The J-Link probe itself has an issue talking to that AP (wiring, firmware, version mismatch).
- A version mismatch between `nrfutil` and the chip / J-Link firmware (we have prior history of `nrfutil` version sensitivity on this hardware — font flash specifically requires `nrfutil device 2.12.8`).

We do not currently know which of these applies.

## What We Don't Know

This is mostly an "unknowns list" — almost nothing about the failure mode is confirmed.

- **What `nrfutil` version** the new flashing script pins or invokes. If it differs from the version Yash tested with, that alone could be the cause.
- **What J-Link probe and firmware** the SF team is using. The recover dance on nRF5340 is sensitive to probe firmware.
- **What USB cable / hardware setup** they used. A bad cable mate during a prior session could have caused latent damage that only surfaced on this recover attempt — see `2026-05-13-usb-cable-misalignment-net-core-damage.md` for the working hypothesis there; the network-core-targeted failure mode is a notable overlap.
- **What the script does between "start" and the network-core recover** — environment setup, power sequencing, any device wake / reset commands before the recover call.
- Whether they ran the recover **in the correct order** (Network-then-Application — on nRF5340 you must do Network first; recovering Network also wipes App, so reversing the order leaves the App core's debug stub broken). The script claims to do this as step 1, but we haven't audited it independently.
- Whether the unit had been through any prior unusual events (drop, ESD, cable misalignment) before the SF team got to it.
- Why "other flashing methods also fail" — what specifically fails, what error.

## Possible Causes (Ranked By Cheap-To-Check First)

The positive control plus the two-unit data point have shifted the picture decisively toward the SF side:

- Script works on Shenzhen's setup → script is fine in isolation.
- `nrfutil` version is pinned by the script → version mismatch is essentially ruled out.
- Two SF units failed identically → single-unit hardware damage is no longer a sufficient explanation.

What's left is something **shared** across the SF environment that's bad.

1. **J-Link probe issue on SF side.** Top candidate. The script can pin `nrfutil` but it cannot pin the probe firmware, model, or hardware. A probe with outdated firmware, a wrong model selected, or a hardware fault could fail to enumerate the network-core CTRL-AP on otherwise healthy units. **Cheapest to confirm:** have SF team report the J-Link model + firmware version; ideally also try a different probe if they have one.
2. **SF team's USB cable / power path to the J-Link.** Bad cable, USB-3 hub flakiness, marginal power delivery. Can produce intermittent SWD comms that look like "AP not detected." Cheap to try: direct USB port + different cable.
3. **Both SF units were physically damaged before the flash attempt (same root cause across both).** Plausible if the SF team is using a misaligned cable when handling units — see [[2026-05-13-usb-cable-misalignment-net-core-damage]]. Their cable habits could be damaging units consistently, and the flash attempts only surfaced the existing damage. Worth asking what cable they use for power / charging the units.
4. **Host-side macOS / driver issue on SF machine.** Conflicting nRF Connect / J-Link installs, missing dylibs, stale drivers. Lower probability given the script's environment setup, but a system-wide issue can affect tools the script doesn't isolate.
5. **Coincident damage across two units from unrelated causes.** Lowest probability — essentially impossible without a shared root cause, but listed for completeness.

## What's Worth Doing Next

The two-unit signal is the clearest direction: focus on what's shared across the SF setup, not on the units themselves. The cheapest checks rule out / confirm the J-Link path first.

- [ ] **Ask SF team to capture and report:**
  - J-Link probe model + firmware version (the script can't pin this — it's the most likely culprit).
  - The full console transcript of the failed flash + each subsequent attempt on both units.
  - macOS version + any nRF Connect / J-Link installations they have.
  - Their USB cable / hub setup (direct port vs. hub, what cable they're using from host → J-Link, and from J-Link → glasses).
  - What cable they're using to **power / charge** the glasses themselves (separate from the flash setup) — if it's misaligned, this is the prime suspect for physical damage. See [[2026-05-13-usb-cable-misalignment-net-core-damage]].
- [ ] **Have SF team try a different J-Link probe** if they have one available. Cheapest way to confirm / rule out probe hardware/firmware.
- [ ] **Have SF team update their J-Link probe firmware** to the latest Segger release and retry. If a stale probe firmware was the issue, this fixes it without further investigation.
- [ ] **Have SF team try a third pair of glasses if available** to confirm the failure rate (2/2 vs. 3/3 is much stronger evidence of an environment issue than 2/2 alone).
- [ ] **Ship one of the affected units back to Shenzhen** for testing on Yash's working setup. If it works there → confirms SF environment problem and likely lets SF use the unit again once their setup is fixed. If it also fails → both units genuinely damaged, focus shifts back to physical-damage hypothesis.
- [ ] **If SF setup is confirmed faulty (probe, USB, etc.):** document the fix for the team, and check whether other future flashing attempts will hit the same issue. Update the script's README with environment requirements that _can't_ be pinned (probe firmware, cabling).
- [ ] **If hardware damage on both units is confirmed:** quarantine, label, and link to the cable-misalignment incident. Investigate whether SF team's handling habits caused it.

## References / Related

- See `2026-05-13-usb-cable-misalignment-net-core-damage.md` — network-core debug interface failure has a known plausible physical cause on this hardware; if the SF unit had any prior cable mishap, that's the leading candidate.
- nRF5340 recover order on dual-core (Network-then-App) is a known sharp edge — recovering Network also wipes App, so the order matters.
- `nrfutil device` version sensitivity on this hardware: font flash specifically requires `nrfutil device 2.12.8`. Other operations have not been audited for similar pinning.
