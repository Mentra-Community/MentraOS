import {describe, expect, test} from "bun:test"
import {
  BLUETOOTH_SDK_DIST_TAGS_URL,
  BluetoothSdkUpdateService,
  DIST_TAG_CACHE_TTL_MS,
  DIST_TAG_RETRY_AFTER_FAILURE_MS,
  captureBody,
  decideUpdateStatus,
  parseSdkVersion,
  parseUpdateCheckRequest,
  type Fetcher,
} from "./bluetooth-sdk-update.service"

const TAGS = {latest: "3.2.1", beta: "3.2.1-beta.646", dev: "3.3.0-dev.821", "candidate-3.2.1": "3.2.1"}

function decide(sdkVersion: string, minimumSupportedVersion?: string) {
  return decideUpdateStatus({sdkVersion, distTags: TAGS, minimumSupportedVersion})
}

describe("parseSdkVersion", () => {
  test("maps the prerelease label to the release channel", () => {
    expect(parseSdkVersion("3.2.1")).toEqual({major: 3, minor: 2, patch: 1, channel: "latest", prerelease: null})
    expect(parseSdkVersion("3.2.1-beta.646")?.channel).toBe("beta")
    expect(parseSdkVersion("3.3.0-dev.821")).toEqual({major: 3, minor: 3, patch: 0, channel: "dev", prerelease: 821})
  })

  test("rejects other prerelease labels and garbage", () => {
    for (const raw of ["3.2.1-rc.1", "3.2", "v3.2.1", "3.2.1-dev", "3.2.1-dev.x", "unknown", ""]) {
      expect(parseSdkVersion(raw)).toBeNull()
    }
  })
})

describe("decideUpdateStatus", () => {
  test("dev channel compares against the dev tag", () => {
    expect(decide("3.3.0-dev.700")).toEqual({
      status: "update_available",
      channel: "dev",
      latestVersion: "3.3.0-dev.821",
      minimumSupportedVersion: null,
    })
    expect(decide("3.3.0-dev.821").status).toBe("current")
    expect(decide("3.2.0-dev.900").status).toBe("update_available")
    expect(decide("3.3.0-dev.900").status).toBe("current")
  })

  test("beta channel compares against the beta tag", () => {
    expect(decide("3.2.1-beta.600")).toMatchObject({status: "update_available", channel: "beta", latestVersion: "3.2.1-beta.646"})
    expect(decide("3.2.1-beta.646")).toMatchObject({status: "current", channel: "beta"})
  })

  test("stable releases compare against latest by base version", () => {
    expect(decide("3.1.0")).toMatchObject({status: "update_available", channel: "latest", latestVersion: "3.2.1"})
    expect(decide("3.2.1")).toMatchObject({status: "current", channel: "latest"})
    // An unreleased local build ahead of npm is current.
    expect(decide("3.3.0")).toMatchObject({status: "current", channel: "latest", latestVersion: "3.2.1"})
  })

  test("unparseable SDK versions are unknown on the latest channel", () => {
    for (const version of ["3.2.1-rc.1", "garbage"]) {
      expect(decide(version)).toEqual({status: "unknown", channel: "latest", latestVersion: null, minimumSupportedVersion: null})
    }
  })

  test("a missing or unparseable channel tag is unknown", () => {
    expect(decideUpdateStatus({sdkVersion: "3.3.0-dev.1", distTags: {latest: "3.2.1"}, minimumSupportedVersion: undefined}))
      .toEqual({status: "unknown", channel: "dev", latestVersion: null, minimumSupportedVersion: null})
    expect(decideUpdateStatus({sdkVersion: "3.2.0", distTags: {latest: "3.2.1-rc.1"}, minimumSupportedVersion: undefined}))
      .toMatchObject({status: "unknown", latestVersion: null})
    expect(decideUpdateStatus({sdkVersion: "3.2.0", distTags: null, minimumSupportedVersion: undefined}))
      .toMatchObject({status: "unknown", latestVersion: null})
  })

  test("the minimum tier compares base versions only", () => {
    expect(decide("3.0.5", "3.1.0")).toEqual({
      status: "unsupported",
      channel: "latest",
      latestVersion: "3.2.1",
      minimumSupportedVersion: "3.1.0",
    })
    expect(decide("3.1.0-dev.3", "3.1.0")).toMatchObject({status: "update_available", minimumSupportedVersion: "3.1.0"})
    expect(decide("3.2.1", "3.1.0")).toMatchObject({status: "current", minimumSupportedVersion: "3.1.0"})
    // Unsupported does not depend on npm.
    expect(decideUpdateStatus({sdkVersion: "3.0.5", distTags: null, minimumSupportedVersion: "3.1.0"}))
      .toMatchObject({status: "unsupported", latestVersion: null})
  })

  test("an empty or unparseable minimum means no minimum", () => {
    for (const minimum of ["", "  ", "3.1", "3.1.0-dev.1", "latest"]) {
      expect(decide("0.0.1", minimum)).toMatchObject({status: "update_available", minimumSupportedVersion: null})
    }
  })
})

describe("parseUpdateCheckRequest", () => {
  const valid = {install_id: "mentra-bt-sdk-1", app_identifier: "com.example", sdk_version: "3.2.1", sdk_platform: "android" as const}

  test("trims strings, normalizes os_version and drops unknown fields", () => {
    expect(parseUpdateCheckRequest({...valid, install_id: "  id  ", os_version: 17, extra: "x", app_build: "  "}))
      .toEqual({...valid, install_id: "id", os_version: "17"})
    expect(parseUpdateCheckRequest({...valid, os_version: "17.5", sdk_surface: null})).toEqual({...valid, os_version: "17.5"})
  })

  test("rejects missing, blank, overlong and out-of-enum fields", () => {
    for (const body of [
      {...valid, install_id: undefined},
      {...valid, app_identifier: "   "},
      {...valid, sdk_version: "x".repeat(129)},
      {...valid, app_version: "x".repeat(129)},
      {...valid, sdk_platform: "web"},
      {...valid, sdk_surface: "flutter"},
      {...valid, app_build_type: "profile"},
      {...valid, os_version: true},
      [valid],
      null,
    ]) {
      expect(parseUpdateCheckRequest(body)).toBeNull()
    }
    expect(parseUpdateCheckRequest({...valid, app_version: "x".repeat(128)})).not.toBeNull()
  })
})

describe("BluetoothSdkUpdateService dist-tag cache", () => {
  function harness(responses: Array<() => Promise<Response>>) {
    let clock = 1_000_000
    const urls: string[] = []
    const signals: unknown[] = []
    const fetcher: Fetcher = async (url, init) => {
      urls.push(url)
      signals.push(init.signal)
      const next = responses.shift()
      if (!next) throw new Error("unexpected fetch")
      return next()
    }
    const service = new BluetoothSdkUpdateService({fetch: fetcher, now: () => clock, minimumSupportedVersion: () => undefined})
    return {
      service,
      urls,
      signals,
      advance: (ms: number) => {
        clock += ms
      },
    }
  }
  const ok = (tags: unknown) => async () => Response.json(tags)
  const fail = () => async (): Promise<Response> => {
    throw new Error("network down")
  }

  test("serves the cached value within the TTL and refetches after it", async () => {
    const h = harness([ok(TAGS), ok({...TAGS, latest: "3.2.2"})])
    expect((await h.service.distTags())?.latest).toBe("3.2.1")
    h.advance(DIST_TAG_CACHE_TTL_MS - 1)
    expect((await h.service.distTags())?.latest).toBe("3.2.1")
    expect(h.urls).toEqual([BLUETOOTH_SDK_DIST_TAGS_URL])
    expect(h.signals[0]).toBeInstanceOf(AbortSignal)
    h.advance(1)
    expect((await h.service.distTags())?.latest).toBe("3.2.2")
    expect(h.urls).toHaveLength(2)
  })

  test("concurrent callers share one in-flight refresh", async () => {
    let release!: (response: Response) => void
    const h = harness([() => new Promise<Response>((resolve) => (release = resolve))])
    const pending = Promise.all([h.service.distTags(), h.service.distTags(), h.service.distTags()])
    release(Response.json(TAGS))
    expect((await pending).map((tags) => tags?.dev)).toEqual(["3.3.0-dev.821", "3.3.0-dev.821", "3.3.0-dev.821"])
    expect(h.urls).toHaveLength(1)
  })

  test("a failed refresh keeps serving the last good value and backs off", async () => {
    const h = harness([ok(TAGS), fail(), ok({...TAGS, latest: "3.2.2"})])
    await h.service.distTags()
    h.advance(DIST_TAG_CACHE_TTL_MS)
    expect((await h.service.distTags())?.latest).toBe("3.2.1")
    expect(h.urls).toHaveLength(2)
    h.advance(DIST_TAG_RETRY_AFTER_FAILURE_MS - 1)
    expect((await h.service.distTags())?.latest).toBe("3.2.1")
    expect(h.urls).toHaveLength(2)
    h.advance(1)
    expect((await h.service.distTags())?.latest).toBe("3.2.2")
    expect(h.urls).toHaveLength(3)
  })

  test("never fetched plus a failing fetch is unknown with no latest version", async () => {
    const h = harness([fail()])
    const request = parseUpdateCheckRequest({install_id: "i", app_identifier: "a", sdk_version: "3.1.0", sdk_platform: "ios"})!
    expect(await h.service.check(request)).toEqual({
      status: "unknown",
      channel: "latest",
      latestVersion: null,
      minimumSupportedVersion: null,
    })
  })

  test("non-OK and non-object npm responses count as failures", async () => {
    const h = harness([async () => new Response("nope", {status: 503}), ok(["3.2.1"])])
    expect(await h.service.distTags()).toBeNull()
    h.advance(DIST_TAG_RETRY_AFTER_FAILURE_MS)
    expect(await h.service.distTags()).toBeNull()
    expect(h.urls).toHaveLength(2)
  })

  test("unparseable SDK versions skip the npm fetch", async () => {
    const h = harness([])
    const request = parseUpdateCheckRequest({install_id: "i", app_identifier: "a", sdk_version: "garbage", sdk_platform: "ios"})!
    expect((await h.service.check(request)).status).toBe("unknown")
    expect(h.urls).toHaveLength(0)
  })
})

describe("captureBody", () => {
  test("builds an anonymous PostHog event with the request fields", () => {
    const request = parseUpdateCheckRequest({
      install_id: "mentra-bt-sdk-1",
      app_identifier: "com.example",
      sdk_version: "3.1.0",
      sdk_platform: "android",
      os_version: 34,
    })!
    const at = new Date("2026-10-11T00:00:00.000Z")
    const body = captureBody("phc_test", request, {status: "unknown", channel: "latest", latestVersion: null, minimumSupportedVersion: null}, at)
    expect(body).toMatchObject({
      api_key: "phc_test",
      event: "bluetooth_sdk_update_check",
      distinct_id: "mentra-bt-sdk-1",
      timestamp: "2026-10-11T00:00:00.000Z",
    })
    expect(body.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.properties).toEqual({
      install_id: "mentra-bt-sdk-1",
      app_identifier: "com.example",
      sdk_version: "3.1.0",
      sdk_platform: "android",
      os_version: "34",
      event_source: "mentra_bluetooth_sdk",
      update_status: "unknown",
      update_channel: "latest",
      $process_person_profile: false,
      $geoip_disable: true,
    })
  })
})
