import {fetchMinimumClientVersion, minimumClientVersionUrl} from "./cloudVersion"

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {ok, status, json: async () => body} as Response
}

describe("minimum client version policy", () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  it("fetches the policy from Runtime", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({success: true, data: {required: "3.1.0", recommended: "3.2.0"}}))

    const result = await fetchMinimumClientVersion("https://runtime.example/", 1, 0)

    expect(result.is_ok()).toBe(true)
    if (result.is_error()) throw result.error
    expect(result.value).toEqual({required: "3.1.0", recommended: "3.2.0"})
    expect(fetchMock).toHaveBeenCalledWith("https://runtime.example/api/client/min-version")
  })

  it("keeps a Runtime base path and rejects query-bearing base URLs", () => {
    expect(minimumClientVersionUrl("https://runtime.example/mentra/")).toBe(
      "https://runtime.example/mentra/api/client/min-version",
    )
    expect(() => minimumClientVersionUrl("https://runtime.example/?tenant=acme")).toThrow(/query/)
    expect(() => minimumClientVersionUrl("not a url")).toThrow(/invalid/)
  })

  it("falls back to the required version when recommended is missing", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({data: {required: "3.1.0"}}))

    const result = await fetchMinimumClientVersion("https://runtime.example", 1, 0)

    if (result.is_error()) throw result.error
    expect(result.value).toEqual({required: "3.1.0", recommended: "3.1.0"})
  })

  it("rejects malformed policy values instead of returning them", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({data: {required: "latest", recommended: "3.2.0"}}))

    const result = await fetchMinimumClientVersion("https://runtime.example", 1, 0)

    expect(result.is_error()).toBe(true)
    if (result.is_ok()) throw new Error("expected malformed policy to fail")
    expect(result.error.message).toMatch(/malformed required/)
  })

  it("rejects non-canonical SemVer such as a v prefix", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({data: {required: "3.1.0", recommended: "v3.2.0"}}))

    const result = await fetchMinimumClientVersion("https://runtime.example", 1, 0)

    expect(result.is_error()).toBe(true)
  })

  it("retries HTTP failures and returns the last error", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({}, false, 503))
      .mockRejectedValueOnce(new Error("dns"))
      .mockResolvedValueOnce(jsonResponse({}, false, 500))

    const result = await fetchMinimumClientVersion("https://runtime.example", 3, 0)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.is_error()).toBe(true)
    if (result.is_ok()) throw new Error("expected HTTP failure")
    expect(result.error.message).toBe("min-version HTTP 500")
  })

  it("succeeds on a later attempt after a transient failure", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("dns"))
      .mockResolvedValueOnce(jsonResponse({data: {required: "3.1.0", recommended: "3.2.0"}}))

    const result = await fetchMinimumClientVersion("https://runtime.example", 3, 0)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.is_ok()).toBe(true)
  })
})
