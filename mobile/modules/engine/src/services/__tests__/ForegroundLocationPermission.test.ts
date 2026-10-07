/// <reference types="bun-types" />

import {describe, expect, jest, test} from "bun:test"

import {
  mayRequestLocationFor,
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

describe("optional location", () => {
  test("never raises the OS prompt for a miniapp that declared location optional", async () => {
    const mocks = buildClient("undetermined", "granted")

    const result = await resolveForegroundLocationPermission(mocks.client, () => "active", {
      mayRequest: mayRequestLocationFor([{type: "LOCATION", required: false}]),
    })

    expect(result.status).toBe("undetermined")
    expect(mocks.requestForegroundPermissionsAsync).not.toHaveBeenCalled()
  })

  test("still uses an existing grant for an optional declaration", async () => {
    const mocks = buildClient("granted")

    const result = await resolveForegroundLocationPermission(mocks.client, () => "active", {mayRequest: false})

    expect(result.status).toBe("granted")
  })

  test("keeps request-while-active for required or undeclared location", () => {
    expect(mayRequestLocationFor([{type: "LOCATION"}])).toBe(true)
    expect(mayRequestLocationFor([{type: "location", required: true}])).toBe(true)
    expect(mayRequestLocationFor([{type: "MICROPHONE", required: false}])).toBe(true)
    expect(mayRequestLocationFor(undefined)).toBe(true)
    expect(mayRequestLocationFor([{type: "LOCATION", required: false}])).toBe(false)
  })
})
