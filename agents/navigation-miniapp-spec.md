# Navigation Mini App — Product Spec

## Summary

A turn-by-turn navigation mini app for MentraOS smart glasses. The user enters
a destination on their phone, and step-by-step driving/walking directions
appear on the glasses display in real time as they move.

This document describes **what** we are building and **what behavior the
product must have**. It does not specify implementation, library choices, or
SDKs. Those decisions are tracked separately.

## Goals

- Deliver accurate, low-latency turn-by-turn navigation to the glasses
  display.
- Make destination entry effortless from the phone.
- Work for the most common navigation modes the user expects (driving and
  walking at minimum).
- Stay reliable in the everyday cases where consumer GPS is hardest:
  intersections, urban canyons, slow speeds, and standing still.
- Ship something a user can hand to a friend and have them complete a real
  trip without fiddling.

## Non-goals (for v1)

- Full top-down map rendered on the glasses.
- App store distribution. v1 ships through local install.
- Voice guidance.
- Offline routing.
- Multi-stop trips, route preview, or alternate route selection.
- G2 or non-G1 hardware support.

## Target user and primary use case

A MentraOS user wearing G1 glasses, holding their phone, who wants to walk or
drive somewhere they don't already know how to get to. They open the
navigation mini app on the phone, type or paste an address, start the trip,
and put the phone away. From that point forward, every direction they need
appears on the glasses at the moment they need it. They never look at the
phone again until they arrive.

## User journey

1. **Open the mini app.** From the MentraOS phone app, the user launches the
   navigation mini app. It opens to a destination entry screen.
2. **Enter destination.** The user types or pastes an address. The app
   confirms the destination is valid and resolvable.
3. **Start trip.** The user taps a clear "start" affordance. The mini app
   tells the user navigation has begun.
4. **Receive guidance on the glasses.** Each upcoming maneuver appears on the
   glasses display with enough information for the user to act on it
   confidently. The display updates as the user gets closer to the maneuver
   and again when the maneuver is completed.
5. **Off-route recovery.** If the user goes the wrong way, the system
   notices, recomputes, and resumes guidance without requiring user
   intervention.
6. **Arrival.** When the user reaches the destination, the glasses show an
   arrival state and guidance ends.
7. **Cancel.** The user can stop navigation at any time from the phone.

## What the product must do

### On the phone

- Provide a screen for entering a destination.
- Validate that the destination is real and reachable before starting.
- Show the user that navigation is active. The user must be able to tell at a
  glance whether nav is on or off without unlocking the phone.
- Allow the user to cancel an in-progress trip.
- Continue providing guidance when the phone is locked or in another app.

### On the glasses

- Display the next maneuver clearly enough that the user can act on it
  without ambiguity. At minimum this includes: what to do (turn, continue,
  arrive), where to do it (street name and/or distance), and when to do it
  (a distance countdown that updates as the user approaches).
- Update at a rate that feels live, not stale. The user should not be past a
  turn before the display tells them to take it.
- Show an unambiguous arrival state when the trip is done.
- Show an unambiguous "rerouting" state when the system is recovering from an
  off-route event, so the user knows not to act on stale guidance.

### As a mini app

- Subscribe to the existing MentraOS event streams it needs (e.g. location).
- Render to the glasses through the existing mini app rendering pipeline.
- Coexist with other running mini apps without breaking them or being broken
  by them.
- Tear down cleanly when the user closes the trip or the app.

## Quality bar

These are the qualities the product must hit to be considered shippable, in
priority order.

1. **Correctness at decision points.** When the user is approaching an
   intersection or maneuver, the displayed instruction must match the
   maneuver they are about to perform. This is the single most important
   quality. Wrong directions are worse than no directions.
2. **Low latency end-to-end.** From the moment the user crosses a maneuver
   trigger point to the moment the next instruction appears on the glasses,
   the delay must be short enough that the user does not perceive the system
   as lagging behind reality. The exact target is to be measured, but the
   feel should be "instant."
3. **Robust to GPS jitter.** Phone GPS drifts, especially at intersections
   and in cities. The product must remain usable in conditions where raw GPS
   alone would mislead the user.
4. **Robust to off-route events.** When the user deviates from the planned
   route, the system must detect this quickly and either reroute or signal
   that something has changed. The user must never silently follow stale
   guidance.
5. **Reliable in the background.** Nav must keep working when the user locks
   their phone or switches to another app. A user putting their phone in
   their pocket is the expected mode of use, not an edge case.
6. **Battery-aware.** Continuous GPS and a continuously-updating glasses
   display are both expensive. The product should not flatten the user's
   phone or glasses on a normal trip.
7. **Honest about uncertainty.** When the system does not know where the
   user is, or has lost the route, or is recomputing — say so on the
   glasses. Do not present uncertain guidance as certain.

## Behavior in adverse conditions

The product must define and document its behavior in each of these cases.
Each one is a known failure mode of consumer navigation and the user
experience here is what separates a good nav product from a frustrating one.

- **Standing still at an intersection.** Multiple roads converge; GPS
  bearing is unreliable below walking speed. The display must still
  communicate the next maneuver clearly.
- **Dense urban environment.** Tall buildings cause GPS multipath and the
  reported position can be off by tens of meters. The display should not
  flicker between conflicting instructions as the position bounces.
- **Lost GPS signal entirely.** Tunnel, parking garage, deep indoor area.
  The display must not lie about position. It should communicate that
  guidance is paused and resume cleanly when signal returns.
- **User takes a wrong turn deliberately.** Detour, scenic route, or stop.
  The system should reroute rather than nag the user back to the original
  path.
- **Phone goes to sleep mid-trip.** Guidance must continue.
- **User opens another app mid-trip.** Guidance must continue.
- **User exits the mini app mid-trip.** The product must define whether nav
  ends or continues. Recommended: nav ends, with explicit confirmation.
- **Glasses disconnect mid-trip.** Phone-side nav state should persist;
  guidance resumes when the glasses reconnect.

## Inputs and outputs

This section describes what the product consumes and produces, not how.

**Inputs:**
- A destination supplied by the user.
- The user's current geographic position over time.
- The user's current heading (which way they are facing) when available and
  trustworthy.

**Outputs:**
- Phone UI confirming destination and trip state.
- Glasses display showing the current navigation instruction.
- Trip lifecycle events (started, rerouting, arrived, cancelled) that other
  parts of the system can observe.

## Success criteria

The v1 release is successful if a new user can:

1. Open the mini app, enter an address they have never been to before, and
   start a trip in under 30 seconds with no instructions.
2. Reach that destination by following only the glasses display, without
   looking at the phone again, on a route involving at least three turns.
3. Take a wrong turn intentionally and observe the system recover, without
   manual intervention, before they are misled into a second wrong turn.
4. Complete the trip with their phone locked in their pocket the entire
   time.

If any of these four scenarios fails, v1 is not done.

## Out of scope but worth noting

Things deliberately deferred from v1 that we know will come up:

- Walking vs driving mode selection (v1 picks one mode and ships it well).
- Saved destinations / history.
- Search-by-place-name (v1 takes a typed address).
- Sharing trips or ETA.
- Multi-modal directions (transit, biking).
- Live traffic.
- Speed limit display.
- Lane guidance.

These are valuable but they are not what makes v1 succeed or fail. v1
succeeds if the core loop — enter destination, follow turn-by-turn on
glasses, arrive — works reliably.

## Open product questions

These need answers before implementation can be locked in. Implementation
choices follow from these.

1. **Driving or walking first?** The disambiguation, latency, and accuracy
   problems differ between the two. Pick one as the v1 target.
2. **What does "arrived" look like on G1?** A static screen, an animation,
   a timed dismissal? Define the visual.
3. **What does "rerouting" look like on G1?** The user must be able to
   distinguish "system is thinking" from "system has lost me."
4. **What is the cancellation gesture?** Phone-only, or also from the
   glasses?
5. **Distance units.** Imperial, metric, or follow phone locale?
6. **Do we surface ETA on the glasses, or only on the phone?**
7. **What happens if the user enters an address far enough away that the
   trip would take many hours?** Confirm and proceed, or warn?

## Risks

- **GPS accuracy at intersections is the core UX risk.** No product decision
  fully eliminates it; the product must define acceptable behavior under
  uncertainty.
- **Latency across the mobile → cloud → mini app chain may be too slow for
  live navigation.** If measured latency exceeds the perceptual budget, the
  product may need a more direct delivery path.
- **G1 display refresh and bitmap rendering rate may not keep up with live
  nav updates.** This must be measured against the rate at which nav events
  fire.
- **User expectation mismatch.** Users coming from Google Maps or Apple Maps
  will expect a map. v1 deliberately does not render one. The phone UI and
  onboarding must set the right expectation, or the product will feel
  broken even when working as designed.
