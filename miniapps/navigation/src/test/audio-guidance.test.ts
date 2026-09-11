/// <reference types="bun-types" />

import {afterEach, describe, expect, jest, test} from "bun:test"

import {
  AudioGuidanceManager,
  selectAudioGuidanceDistance,
  type AudioGuidanceInput,
} from "../background/managers/AudioGuidanceManager"

function createHarness() {
  const spoken: string[] = []
  let stops = 0
  const manager = new AudioGuidanceManager({
    speak: async (text) => {
      spoken.push(text)
      return {completed: true}
    },
    stop: () => {
      stops += 1
    },
  })
  manager.setAvailable(true)
  return {
    manager,
    spoken,
    get stops() {
      return stops
    },
  }
}

function input(partial: Partial<AudioGuidanceInput> = {}): AudioGuidanceInput {
  return {
    status: "navigating",
    running: true,
    routeRevision: 1,
    pivotIndex: 0,
    maneuverType: "TURN_LEFT",
    instruction: "Turn left onto Market Street",
    distanceMeters: 100,
    offRoute: false,
    destinationName: "Blue Bottle",
    arrivalSide: null,
    travelMode: "walking",
    unitSystem: "metric",
    ...partial,
  }
}

async function settleSpeech(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

afterEach(() => {
  if (jest.isFakeTimers()) jest.useRealTimers()
})

describe("AudioGuidanceManager", () => {
  test("full guidance speaks at most one preparation and one now prompt per turn", async () => {
    const {manager, spoken} = createHarness()
    manager.setMode("full")

    manager.observe(input({distanceMeters: 59}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 48}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 9}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 4}))
    await settleSpeech()

    expect(spoken).toEqual(["In 60 meters, turn left onto Market Street.", "Turn left onto Market Street now."])
  })

  test("essential guidance skips advance notice but still announces the turn", async () => {
    const {manager, spoken} = createHarness()
    manager.setMode("essential")

    manager.observe(input({distanceMeters: 55}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 10}))
    await settleSpeech()

    expect(spoken).toEqual(["Turn left onto Market Street now."])
  })

  test("route revision and pivot index create fresh maneuver identities", async () => {
    const {manager, spoken} = createHarness()
    manager.setMode("full")

    manager.observe(input({distanceMeters: 9, pivotIndex: 0}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 9, pivotIndex: 1}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 9, pivotIndex: 1, routeRevision: 2}))
    await settleSpeech()

    expect(spoken).toHaveLength(3)
  })

  test("binding a late pivot does not replay the same maneuver", async () => {
    const {manager, spoken} = createHarness()
    manager.setMode("full")

    manager.observe(input({distanceMeters: 50, pivotIndex: null}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 48, pivotIndex: 0}))
    await settleSpeech()

    expect(spoken).toEqual(["In 50 meters, turn left onto Market Street."])
  })

  test("pivotless identical short turns receive distinct action cues", async () => {
    const {manager, spoken} = createHarness()
    manager.setMode("essential")

    manager.observe(input({distanceMeters: 9, pivotIndex: null}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 20, pivotIndex: null}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 9, pivotIndex: null}))
    await settleSpeech()

    expect(spoken).toEqual(["Turn left onto Market Street now.", "Turn left onto Market Street now."])
  })

  test("full guidance announces the final approach once", async () => {
    const {manager, spoken} = createHarness()
    manager.setMode("full")

    manager.observe(
      input({maneuverType: "ARRIVE", instruction: "Arriving", distanceMeters: 50, pivotIndex: null}),
    )
    await settleSpeech()
    manager.observe(
      input({maneuverType: "ARRIVE", instruction: "Arriving", distanceMeters: 30, pivotIndex: null}),
    )
    await settleSpeech()

    expect(spoken).toEqual(["Destination in 50 meters."])
  })

  test("arrival guidance uses live distance without detaching turn cues from their event", () => {
    expect(selectAudioGuidanceDistance("ARRIVE", 120, 35)).toBe(35)
    expect(selectAudioGuidanceDistance("ARRIVE", 120, null)).toBe(120)
    expect(selectAudioGuidanceDistance("TURN_LEFT", 12, 80)).toBe(12)
  })

  test("a new semantic maneuver stops an in-progress maneuver prompt", async () => {
    const spoken: string[] = []
    let stops = 0
    const manager = new AudioGuidanceManager({
      speak: (text) => {
        spoken.push(text)
        return new Promise(() => {})
      },
      stop: () => {
        stops += 1
      },
    })
    manager.setAvailable(true)
    manager.setMode("full")

    manager.observe(input({distanceMeters: 50, pivotIndex: 0}))
    manager.observe(
      input({
        maneuverType: "TURN_RIGHT",
        instruction: "Turn right onto Valencia Street",
        distanceMeters: 45,
        pivotIndex: 1,
      }),
    )
    await settleSpeech()

    expect(spoken).toEqual(["In 50 meters, turn left onto Market Street."])
    expect(stops).toBe(1)
  })

  test("off-route guidance replaces stale turn cues until the route is regained", async () => {
    const {manager, spoken} = createHarness()
    manager.setMode("essential")

    manager.observe(input({distanceMeters: 9, offRoute: true}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 7, offRoute: true}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 7, offRoute: false}))
    await settleSpeech()

    expect(spoken).toEqual(["You are off route. Go back to the route.", "Turn left onto Market Street now."])
  })

  test("startup grace resumes maneuver guidance when an off-route fix stabilizes", async () => {
    jest.useFakeTimers({now: 100_000})
    const {manager, spoken} = createHarness()
    manager.setMode("essential")
    manager.beginTrip()
    manager.confirmTripStarted("Blue Bottle")
    await settleSpeech()

    manager.observe(input({distanceMeters: 9, offRoute: true}))
    await settleSpeech()

    expect(spoken).toEqual(["Navigation started to Blue Bottle."])

    manager.observe(input({distanceMeters: 9, offRoute: false}))
    await settleSpeech()

    expect(spoken).toEqual(["Navigation started to Blue Bottle.", "Turn left onto Market Street now."])
  })

  test("startup off-route warning becomes eligible if the condition outlasts the grace period", async () => {
    jest.useFakeTimers({now: 100_000})
    const {manager, spoken} = createHarness()
    manager.setMode("essential")
    manager.beginTrip()
    manager.confirmTripStarted("Blue Bottle")
    await settleSpeech()

    manager.observe(input({distanceMeters: 9, offRoute: true}))
    await settleSpeech()
    jest.advanceTimersByTime(15_000)
    manager.observe(input({distanceMeters: 7, offRoute: true}))
    await settleSpeech()

    expect(spoken).toEqual(["Navigation started to Blue Bottle.", "You are off route. Go back to the route."])
  })

  test("startup reroute becomes eligible if it is still active after the grace period", async () => {
    jest.useFakeTimers({now: 100_000})
    const {manager, spoken} = createHarness()
    manager.setMode("essential")
    manager.beginTrip()
    manager.confirmTripStarted("Blue Bottle")
    await settleSpeech()

    manager.observe(input({status: "rerouting", maneuverType: null, instruction: null, distanceMeters: null}))
    await settleSpeech()
    jest.advanceTimersByTime(14_999)
    manager.observe(input({status: "rerouting", maneuverType: null, instruction: null, distanceMeters: null}))
    await settleSpeech()

    expect(spoken).toEqual(["Navigation started to Blue Bottle."])

    jest.advanceTimersByTime(1)
    manager.observe(input({status: "rerouting", maneuverType: null, instruction: null, distanceMeters: null}))
    await settleSpeech()
    manager.observe(input({status: "rerouting", maneuverType: null, instruction: null, distanceMeters: null}))
    await settleSpeech()

    expect(spoken).toEqual(["Navigation started to Blue Bottle.", "Off route. Rerouting."])
  })

  test("a suppressed startup reroute cancels stale maneuver speech", async () => {
    jest.useFakeTimers({now: 100_000})
    const spoken: string[] = []
    let stops = 0
    const manager = new AudioGuidanceManager({
      speak: (text) => {
        spoken.push(text)
        if (text.startsWith("Turn left")) return new Promise(() => {})
        return Promise.resolve({completed: true})
      },
      stop: () => {
        stops += 1
      },
    })
    manager.setAvailable(true)
    manager.setMode("essential")
    manager.beginTrip()
    manager.confirmTripStarted("Blue Bottle")
    await settleSpeech()
    manager.observe(input({distanceMeters: 9}))
    await settleSpeech()

    manager.observe(input({status: "rerouting", maneuverType: null, instruction: null, distanceMeters: null}))
    await settleSpeech()

    expect(spoken).toEqual(["Navigation started to Blue Bottle.", "Turn left onto Market Street now."])
    expect(stops).toBe(1)
  })

  test("late navigation updates cannot revive guidance after stop or arrival", async () => {
    const stopped = createHarness()
    stopped.manager.setMode("essential")
    stopped.manager.beginTrip()
    stopped.manager.endTrip()
    stopped.manager.observe(input({distanceMeters: 9}))
    await settleSpeech()
    expect(stopped.spoken).toEqual([])

    const arrived = createHarness()
    arrived.manager.setMode("essential")
    arrived.manager.beginTrip()
    arrived.manager.confirmTripStarted("Blue Bottle")
    await settleSpeech()
    arrived.manager.observe(
      input({status: "arrived", running: false, maneuverType: null, instruction: null, distanceMeters: null}),
    )
    await settleSpeech()
    arrived.manager.observe(input({distanceMeters: 9}))
    await settleSpeech()
    expect(arrived.spoken).toEqual(["Navigation started to Blue Bottle.", "You have arrived at Blue Bottle."])
  })

  test("distance jitter after a now cue cannot backtrack into preparation", async () => {
    const {manager, spoken} = createHarness()
    manager.setMode("full")

    manager.observe(input({distanceMeters: 9, pivotIndex: null}))
    await settleSpeech()
    manager.observe(input({distanceMeters: 16, pivotIndex: null}))
    await settleSpeech()

    expect(spoken).toEqual(["Turn left onto Market Street now."])
  })

  test("start confirmation leads a maneuver received during startup", async () => {
    jest.useFakeTimers({now: 100_000})
    const {manager, spoken} = createHarness()
    manager.setMode("full")
    manager.beginTrip()

    manager.observe(input({distanceMeters: 50}))
    expect(spoken).toEqual([])
    manager.confirmTripStarted(null)
    await settleSpeech()
    jest.advanceTimersByTime(4_000)
    await settleSpeech()

    expect(spoken).toEqual(["Navigation started.", "In 50 meters, turn left onto Market Street."])
  })

  test("rerouting and arrival are each announced once", async () => {
    jest.useFakeTimers({now: 100_000})
    const {manager, spoken} = createHarness()
    manager.setMode("essential")
    manager.beginTrip()
    manager.confirmTripStarted("Blue Bottle")
    await settleSpeech()
    jest.advanceTimersByTime(15_000)

    manager.observe(input({status: "rerouting", maneuverType: null, instruction: null, distanceMeters: null}))
    await settleSpeech()
    manager.observe(input({status: "rerouting", maneuverType: null, instruction: null, distanceMeters: null}))
    await settleSpeech()
    manager.observe(
      input({
        status: "arrived",
        running: false,
        maneuverType: null,
        instruction: null,
        distanceMeters: null,
        arrivalSide: "right",
      }),
    )
    await settleSpeech()

    expect(spoken).toEqual([
      "Navigation started to Blue Bottle.",
      "Off route. Rerouting.",
      "You have arrived at Blue Bottle, on your right.",
    ])
  })

  test("repeat speaks the latest live instruction and off stops all speech", async () => {
    const harness = createHarness()
    harness.manager.setMode("full")
    harness.manager.beginTrip()
    harness.manager.confirmTripStarted(null)
    await settleSpeech()
    harness.manager.observe(input({distanceMeters: 42}))
    await settleSpeech()

    expect(harness.manager.repeatCurrent()).toBe(true)
    await settleSpeech()
    harness.manager.setMode("off")
    expect(harness.manager.repeatCurrent()).toBe(false)
    expect(harness.spoken.at(-1)).toBe("In 40 meters, turn left onto Market Street.")
  })

  test("urgent turn cue cancels deferred advance notice", async () => {
    jest.useFakeTimers({now: 100_000})
    const {manager, spoken} = createHarness()
    manager.setMode("full")
    manager.beginTrip()
    manager.confirmTripStarted(null)
    await settleSpeech()

    // This preparation prompt waits for the automatic gap after the start
    // announcement. The urgent action cue must supersede it completely.
    manager.observe(input({distanceMeters: 50}))
    manager.observe(input({distanceMeters: 9}))
    await settleSpeech()
    jest.advanceTimersByTime(4_000)
    await settleSpeech()

    expect(spoken).toEqual(["Navigation started.", "Turn left onto Market Street now."])
  })

  test("new trip clears the previous arrival repeat phrase", async () => {
    const {manager} = createHarness()
    manager.setMode("essential")
    manager.beginTrip()
    manager.observe(
      input({
        status: "arrived",
        running: false,
        maneuverType: null,
        instruction: null,
        distanceMeters: null,
      }),
    )
    await settleSpeech()

    manager.beginTrip()

    expect(manager.repeatCurrent()).toBe(false)
  })
})
