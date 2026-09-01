import {fetchMinimumClientVersion} from "./cloudVersion"

describe("minimum client version policy", () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  it("fetches the policy from Runtime", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {required: "3.1.0", recommended: "3.2.0"},
      }),
    } as Response)

    const result = await fetchMinimumClientVersion("https://runtime.example/", 1, 0)

    expect(result.is_ok()).toBe(true)
    if (result.is_error()) throw result.error
    expect(result.value).toEqual({required: "3.1.0", recommended: "3.2.0"})
    expect(fetchMock).toHaveBeenCalledWith("https://runtime.example/api/client/min-version")
  })
})
