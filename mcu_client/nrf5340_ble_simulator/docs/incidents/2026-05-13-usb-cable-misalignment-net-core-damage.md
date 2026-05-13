# USB Cable Misalignment → Network-Core Damage on nRF5340 Glasses

**Date observed:** 2026-05-13
**Hardware:** nRF5340-based glasses, 4-pad connector (cable side has matching 4 pins)
**Severity:** Suspected hardware damage path — needs lab confirmation before guidance can be tightened.

## Trigger

The connector is a **4-pad** interface on the glasses with a matching 4-pin cable. The misalignment happens because the connector tolerates partial / off-axis insertion.

### Variant 1 — full 1-pad offset (confirmed)

Cable pins 1–3 land on glasses pads 2–4 (instead of the correct 1–4 alignment); cable pin 4 overhangs with no contact. Glasses immediately enter reset state. This is the reliably reproducible case.

### Variant 2 — single-pin partial contact (reported, unverified)

Yash reports occasionally observing a reset when seating the cable with **only cable pin 1 making contact, landing on glasses pad 2** (no other cable pin connected to any glasses pad). **Not yet independently reproduced and not confirmed as a real distinct mechanism** — logged here for completeness and to keep on the list of things to check during the lab investigation. Could equally be a misobservation (e.g., the cable was actually momentarily in variant 1 alignment and pin 1 was the last visible point of contact when the user noticed the reset).

### Common factor (if both are real)

Both variants would share the same electrical fault: cable pin 1 (VBUS / 5V) touching glasses pad 2 (not rated for 5V).

## Observed Symptoms After a Misaligned Connection

Symptoms appear **on the next normal reset** after the misalignment event — not always immediately:

- **Network core misbehavior** — Bluetooth driver init failures, BT stack errors, or radio not coming up.
- **Memory access failures** on the network chip during JLink / `nrfutil` operations.
- **APPROTECT engaged on the network core** — debug access refused, requires the dual-core recover dance (Network-then-App) to clear.
- Intermittent: device sometimes recovers on its own after a full power cycle; sometimes does not.

The app core is **not** observed to fail with the same pattern, which suggests the damage path is selective to the network domain.

## Working Hypothesis

Based on the confirmed Variant 1: **5V VBUS (cable pin 1) lands on glasses pad 2, which is rated for ≤3.3V signal levels**. Whatever signal pad 2 routes to internally (likely a pin on the SoC or PMIC, possibly tied to the network-core power domain or its debug interface) receives an over-voltage event. This causes:

1. An out-of-spec voltage event on a non-power pin → "bad reset."
2. Latent damage to whatever circuitry received the over-voltage. Network-core peripherals (radio, debug AP, RAM) appear to be downstream of the affected node, which is why symptoms cluster on the network core.
3. Subsequent normal resets surface the latent damage as BT driver failures, memory access errors, or a relocked APPROTECT (possibly via UICR corruption putting the device back into a secured state).

If Variant 2 turns out to be real, it would fit the same hypothesis (single-pin transient on pad 2 → smaller-energy event → smaller damage probability per occurrence, hence intermittent symptoms). But Variant 2 itself is not yet confirmed.

This is a hypothesis — not confirmed. See "Open Questions" below.

## Open Questions

- **Exact pin-to-pad mapping during a 1-pad-offset event** — which glasses pad (pad 2, 3, or 4) actually receives 5V VBUS, and which SoC pin does that pad route to? Need a multimeter trace on a misaligned mate to confirm.
- **Is the damage cumulative or single-event?** Does every misalignment cause damage, or only some? A statistical sample over N misalignments would tell us.
- **Is the damage reversible?** Some units recover after power cycles — is that because the over-voltage event was sub-threshold, or because some flip-flop self-corrects?
- **Are the BT driver failures consistent with damaged silicon, or could they be UICR/flash corruption from the bad reset?** A unit that shows BT failures but successfully reflashes (and persists fine afterwards) points at flash; one that keeps failing post-reflash points at silicon.
- **Is APPROTECT re-engagement happening at UICR level (persistent) or just CTRL-AP level (clears on real reset)?** Determines whether mass-erase is needed to recover.
- Does this happen on **all hardware revisions**, or only specific ones? Cable variant?

## Mitigation / Workarounds (Tentative)

Until the mechanism is confirmed and silicon-level protection is verified:

- **Mechanical:** Investigate keying / chamfering on the connector to make off-axis insertion physically harder. Even a small mechanical guide pin would prevent the 3-offset state.
- **Electrical:** If a signal pin can see VBUS during misalignment, add an ESD/TVS diode clamped at 3.6V on the at-risk pin(s). Reviewable from the schematic once the affected pins are identified.
- **Process:** Until mechanical fix, instruct anyone handling units to verify cable alignment visually before pressing in — and to never plug a powered USB host into an obviously misaligned cable.
- **Detection:** If a damaged-pattern unit lands on a developer's bench, flag for return rather than reflashing in a loop. Reflashing a silicon-damaged unit wastes time and may mask the failure for the next user.

## Recovery Procedure When a Unit Lands in This State

1. Try a full power cycle first (battery disconnect if possible, not just reset pin).
2. If network-core debug is refused, run the dual-core recover sequence — Network first, then Application (recovering Network also wipes App, so order matters).
3. Reflash both cores from known-good artifacts.
4. If symptoms persist after reflash → **likely silicon damage**; quarantine the unit and tag it with serial number, observed symptoms, and approximate date/count of misalignment events.

## Investigation Plan

- [ ] Confirm pin mapping under a 1-pad-offset mate (multimeter on a sacrificial unit) — which glasses pad sees VBUS, which SoC pin does that pad route to.
- [ ] Try to reproduce Variant 2 (single-pin contact at pad 2) deliberately — confirm or refute it as a distinct trigger.
- [ ] If a signal pin sees VBUS: check schematic for series resistor / clamp; verify SoC absolute-max ratings on that pin.
- [ ] Run a controlled-misalignment test on a small batch of units; record post-event BT init success rate, memory access status, APPROTECT state. Gives us a base rate for the damage hypothesis.
- [ ] Decide on mechanical fix (connector keying) vs. electrical fix (TVS) vs. both, based on the above.

## References / Related

- See [[2026-05-13-shell-wedge-on-display-spam]] for an unrelated firmware issue in the same codebase — both incidents are unrelated but share the same hardware platform.
- nRF5340 dual-core recover order: Network-then-App; recovering Network also wipes App.
