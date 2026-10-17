/* eslint-disable import/first -- Register the exact resolver and auth base before the provider. */
jest.mock("@/services/cloudClient", () => ({resolvedEndpoints: jest.fn()}))
jest.mock("@/utils/auth/authClient", () => ({AuthClient: class {}}))

import {resolvedEndpoints} from "@/services/cloudClient"
import {coreEndpointOrigin} from "@/services/deployment/endpointObservation"
import {AccountAuthProvider} from "./accountClient"
import {ACCOUNT_ENDPOINT_MARKER} from "./accountLoginObservation"

describe("AccountAuthProvider endpoint evidence", () => {
  const originalFetch = global.fetch
  let info: jest.SpyInstance, warn: jest.SpyInstance
  beforeEach(() => {
    jest.mocked(resolvedEndpoints).mockReset()
    info = jest.spyOn(console, "info").mockImplementation(() => {})
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it("uses a fresh request resolution after initialization changes without changing fetch or its error", async () => {
    jest
      .mocked(resolvedEndpoints)
      .mockImplementationOnce((observe) => {
        observe?.({activeDeployment: "consumer", origin: "official-dev", provenance: "manifest", overrideScope: "none"})
        return {core: "https://core.dev.us-west-2.mentraglass.com", runtime: "https://runtime.example.test"}
      })
      .mockImplementation((observe) => {
        observe?.({activeDeployment: "consumer", origin: "custom", provenance: "override", overrideScope: "scoped"})
        return {core: "https://private.example/selected", runtime: "https://runtime.example.test"}
      })
    const provider = new AccountAuthProvider(),
      originalError = new TypeError("Network request failed")
    const fetchMock = jest.fn().mockRejectedValue(originalError)
    global.fetch = fetchMock as unknown as typeof fetch
    expect(fetchMock).not.toHaveBeenCalled()
    const result = await provider.signInWithPassword({email: "private@example.test", password: "private-password"})
    expect(result.is_error()).toBe(true)
    if (!result.is_error()) throw Error("Expected the original fetch failure")
    expect(result.error).toBe(originalError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("https://private.example/selected/api/account/login")
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({email: "private@example.test", password: "private-password"}),
    })
    expect(fetchMock.mock.calls[0][1].signal).toBeUndefined()
    const rows = info.mock.calls.map(([line]) => JSON.parse(line.slice(ACCOUNT_ENDPOINT_MARKER.length)))
    expect(rows[0]).toMatchObject({phase: "provider-initialization", origin: "official-dev", requestId: null})
    expect(rows[1]).toMatchObject({
      phase: "password-request",
      origin: "custom",
      provenance: "override",
      requestId: fetchMock.mock.calls[0][1].headers["x-request-id"],
    })
    expect(JSON.stringify(rows)).not.toMatch(/private|https|password@|selected/)
  })

  it("records the existing Cloud Prod preset as official at actual password resolution", async () => {
    const core = "https://core.mentraglass.com/"
    jest.mocked(resolvedEndpoints).mockImplementation((observe) => {
      observe?.({
        activeDeployment: "consumer",
        origin: coreEndpointOrigin(core),
        provenance: "override",
        overrideScope: "scoped",
      })
      return {core, runtime: "https://runtime.example.test"}
    })
    const provider = new AccountAuthProvider(),
      error = new TypeError("Network request failed")
    const fetchMock = jest.fn().mockRejectedValue(error)
    global.fetch = fetchMock as unknown as typeof fetch
    await provider.signInWithPassword({email: "private@example.test", password: "private-password"})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("https://core.mentraglass.com/api/account/login")
    const rows = info.mock.calls.map(([line]) => JSON.parse(line.slice(ACCOUNT_ENDPOINT_MARKER.length)))
    expect(rows).toEqual([
      expect.objectContaining({phase: "provider-initialization", origin: "official-prod", requestId: null}),
      expect.objectContaining({
        phase: "password-request",
        origin: "official-prod",
        requestId: fetchMock.mock.calls[0][1].headers["x-request-id"],
      }),
    ])
    expect(JSON.stringify(rows)).not.toMatch(/https|mentraglass|private/)
  })

  it("contains diagnostic failure at construction and at the sink while preserving one original request", async () => {
    jest
      .mocked(resolvedEndpoints)
      .mockImplementationOnce(() => {
        throw Error("startup resolver unavailable")
      })
      .mockImplementation((observe) => {
        observe?.({activeDeployment: "consumer", origin: "official-dev", provenance: "manifest", overrideScope: "none"})
        return {core: "https://core.dev.us-west-2.mentraglass.com", runtime: "https://runtime.example.test"}
      })
    info.mockImplementation(() => {
      throw Error("sink unavailable")
    })
    const provider = new AccountAuthProvider(),
      error = new Error("original fetch error")
    const fetchMock = jest.fn().mockRejectedValue(error)
    global.fetch = fetchMock as unknown as typeof fetch
    const result = await provider.signInWithPassword({email: "private@example.test", password: "private-password"})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.is_error()).toBe(true)
    if (result.is_error()) expect(result.error).toBe(error)
  })
})
