/// <reference types="bun-types" />

import {beforeEach, describe, expect, test} from "bun:test"

import {
  getFleetManagementState,
  onFleetManagementStateChanged,
  resetFleetManagementStateForTests,
  setFleetManagementState,
} from "../fleetManagementState"

beforeEach(() => resetFleetManagementStateForTests())

describe("the Fleet management state", () => {
  test("starts unknown and notifies only on change", () => {
    const seen: string[] = []
    onFleetManagementStateChanged((state) => seen.push(state.status))
    expect(getFleetManagementState()).toEqual({status: "unknown"})
    setFleetManagementState({status: "unknown"})
    setFleetManagementState({status: "managed", workspaceId: "ws_A", workspaceName: "Acme"})
    setFleetManagementState({status: "managed", workspaceId: "ws_A", workspaceName: "Acme"})
    setFleetManagementState({status: "managed", workspaceId: "ws_B", workspaceName: "Beta"})
    setFleetManagementState({status: "unmanaged"})
    expect(seen).toEqual(["managed", "managed", "unmanaged"])
    expect(getFleetManagementState()).toEqual({status: "unmanaged"})
  })

  test("a listener that throws does not stop the others, and unsubscribing stops its calls", () => {
    const seen: string[] = []
    onFleetManagementStateChanged(() => {
      throw new Error("boom")
    })
    const unsubscribe = onFleetManagementStateChanged((state) => seen.push(state.status))
    setFleetManagementState({status: "unmanaged"})
    unsubscribe()
    setFleetManagementState({status: "unknown"})
    expect(seen).toEqual(["unmanaged"])
  })
})
