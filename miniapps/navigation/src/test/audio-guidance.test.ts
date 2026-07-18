/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {AudioGuidanceManager, type AudioGuidanceInput} from "../background/managers/AudioGuidanceManager"

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
    destinationName: "Blue Bottle",
    arrivalSide: null,
    travelMode: "walking",
    unitSystem: "metric",
    ...partial,
  }
}

async function settleSpeech(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

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

  test("rerouting and arrival are each announced once", async () => {
    const {manager, spoken} = createHarness()
    manager.setMode("essential")
    manager.beginTrip()
    manager.confirmTripStarted("Blue Bottle")
    await settleSpeech()

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
})
