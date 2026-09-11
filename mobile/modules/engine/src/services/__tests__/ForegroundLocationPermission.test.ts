/// <reference types="bun-types" />

import {describe, expect, jest, test} from "bun:test"

import {
  resolveForegroundLocationPermission,
  type ForegroundLocationPermissionClient,
} from "../ForegroundLocationPermission"

function buildClient(currentStatus: string, requestedStatus = currentStatus) {
  const getForegroundPermissionsAsync = jest.fn(async () => ({status: currentStatus}))
  const requestForegroundPermissionsAsync = jest.fn(async () => ({status: requestedStatus}))
  const client: ForegroundLocationPermissionClient = {
    getForegroundPermissionsAsync,
    requestForegroundPermissionsAsync,
  }

  return {client, getForegroundPermissionsAsync, requestForegroundPermissionsAsync}
}

describe("resolveForegroundLocationPermission", () => {
  test("does not invoke the Activity-bound request when permission is already granted in the background", async () => {
    const mocks = buildClient("granted")

    const result = await resolveForegroundLocationPermission(mocks.client, () => "background")

    expect(result.status).toBe("granted")
    expect(mocks.getForegroundPermissionsAsync).toHaveBeenCalledTimes(1)
    expect(mocks.requestForegroundPermissionsAsync).not.toHaveBeenCalled()
  })

  test("requests missing permission while the app is active", async () => {
    const mocks = buildClient("undetermined", "granted")

    const result = await resolveForegroundLocationPermission(mocks.client, () => "active")

    expect(result.status).toBe("granted")
    expect(mocks.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1)
  })

  test("returns missing permission without requesting it from the background", async () => {
    const mocks = buildClient("denied", "granted")

    const result = await resolveForegroundLocationPermission(mocks.client, () => "background")

    expect(result.status).toBe("denied")
    expect(mocks.requestForegroundPermissionsAsync).not.toHaveBeenCalled()
  })

  test("rechecks app state after the permission read before requesting", async () => {
    let appState = "active"
    const requestForegroundPermissionsAsync = jest.fn(async () => ({status: "granted"}))
    const client: ForegroundLocationPermissionClient = {
      getForegroundPermissionsAsync: jest.fn(async () => {
        appState = "background"
        return {status: "undetermined"}
      }),
      requestForegroundPermissionsAsync,
    }

    const result = await resolveForegroundLocationPermission(client, () => appState)

    expect(result.status).toBe("undetermined")
    expect(requestForegroundPermissionsAsync).not.toHaveBeenCalled()
  })
})
