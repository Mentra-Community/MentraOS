import {describe, expect, mock, test} from "bun:test"

import {NavigationController} from "../background/NavigationController"
import type {LatLng} from "../background/lib/geometry"
import type {Coords, TripState} from "../shared/types"

// Exercise the controller's arrival transition without constructing device,
// network, UI, or timer-owning managers.
type ArrivalHarness = {
  coords: Coords | null
  trip: TripState
  maybeFireEarlyArrival(): void
}

const point = (eastMeters: number, northMeters = 0): LatLng => ({
  lat: northMeters / 111_320,
  lng: eastMeters / 111_320,
})
const route = [point(0), point(372)]

function checkArrival(me: LatLng, points: LatLng[] | null = route, destination: LatLng = point(372)) {
  const stop = mock(() => {})
  const controller: ArrivalHarness = Object.create(NavigationController.prototype)
  Object.assign(controller, {
    coords: {...me, ts: 0},
    trip: {
      status: "navigating",
      running: true,
      maneuver: null,
      activeDestination: destination,
      activeDestinationName: null,
      routePoints: points,
      routeSteps: null,
      offRouteAt: null,
      arrivalSide: null,
    } satisfies TripState,
    appendLog: () => {},
    cancelPendingRebuild: () => {},
    exitLargeMap: () => {},
    navigation: {stop},
    ui: {send: () => {}},
  })
  controller.maybeFireEarlyArrival()
  return {controller, stop}
}

describe("early arrival requires actual proximity", () => {
  test("does not stop a trip when a fix projects beyond the route tail from 64.4m away", () => {
    const {controller, stop} = checkArrival(point(436.4))
    expect(controller.trip.status).toBe("navigating")
    expect(stop).not.toHaveBeenCalled()
  })

  test("does not arrive 64.4m lateral to the endpoint despite zero projected distance", () => {
    const {controller, stop} = checkArrival(point(372, 64.4))
    expect(controller.trip.status).toBe("navigating")
    expect(stop).not.toHaveBeenCalled()
  })

  test("still arrives five meters before the route endpoint", () => {
    const {controller, stop} = checkArrival(point(367))
    expect(controller.trip.status).toBe("arrived")
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test("still arrives at the walkable route endpoint when the destination pin is set back", () => {
    const {controller, stop} = checkArrival(point(372), route, point(372, 30))
    expect(controller.trip.status).toBe("arrived")
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test("preserves near-pin arrival within the last forty meters", () => {
    const {controller, stop} = checkArrival(point(350), route, point(350, 10))
    expect(controller.trip.status).toBe("arrived")
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test("does not arrive at the beginning of a 372m route", () => {
    const {controller, stop} = checkArrival(point(0))
    expect(controller.trip.status).toBe("navigating")
    expect(stop).not.toHaveBeenCalled()
  })

  test("leaves arrival to the native stream when route geometry is unavailable", () => {
    for (const points of [null, [], [point(372)]]) {
      const {controller, stop} = checkArrival(point(372), points)
      expect(controller.trip.status).toBe("navigating")
      expect(stop).not.toHaveBeenCalled()
    }
  })

  test("does not infer arrival from a route containing nonfinite points", () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      const {controller, stop} = checkArrival(point(372), [{lat: invalid, lng: 0}, ...route])
      expect(controller.trip.status).toBe("navigating")
      expect(stop).not.toHaveBeenCalled()
    }
  })

  test("does not infer arrival from a nonfinite location fix", () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      const {controller, stop} = checkArrival({lat: invalid, lng: route[1].lng})
      expect(controller.trip.status).toBe("navigating")
      expect(stop).not.toHaveBeenCalled()
    }
  })
})
