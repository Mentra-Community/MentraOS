import {expect, test} from "bun:test"
import {checkAr99Release, parseAr99Source} from "../releaseSource"

const source = {baseUrl: "https://example.invalid/", developerId: "vendor", clientKey: "test-key"}
const lookup = (payload: unknown, status = 200) =>
  checkAr99Release(source, " installed ", " SN123 ", " PROJECT ", {
    fetch: (async () => new Response(JSON.stringify(payload), {status})) as typeof fetch,
    sign: (key, app, version, scope, nonce) => {
      expect([key, app, version, scope, nonce]).toEqual(["test-key", "PROJECT", "installed", "SN123", "42"])
      return "signature"
    },
    nonce: () => "42",
  })

test.each([
  [{}, 553],
  [{code: 553}, 200],
  [{error: {code: 553}}, 400],
])("vendor no-update code is preserved at every response level", async (payload, status) => {
  expect((await lookup(payload, status as number)).hasUpdate).toBe(false)
})
test("vendor request fields, signing and language are unchanged", async () => {
  const result = await checkAr99Release(source, " old ", " serial ", " ", {
    fetch: (async (url, options) => {
      expect(url).toBe("https://example.invalid/api/v2/applications/public/getVersionURL")
      expect(options?.headers).toEqual({"Accept-Language": "en-US", "Content-Type": "application/json"})
      expect(JSON.parse(options?.body as string)).toEqual({
        app_name: "AR99",
        app_type: "juxinOTA",
        current_version: "old",
        developerId: "vendor",
        target_scope: "serial",
        nonce: "123",
        md5: "signed",
      })
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            current_version: "older-but-different",
            url: "/firmware.bin",
            md5: " ABC ",
            force_update: true,
            change_log: "Notes",
          },
        }),
      )
    }) as typeof fetch,
    sign: () => "signed",
    nonce: () => "123",
  })
  expect(result).toEqual({
    currentVersion: "older-but-different",
    firmwareUrl: "https://example.invalid/firmware.bin",
    fileMd5: "abc",
    forceUpdate: true,
    changeLog: "Notes",
    hasUpdate: true,
  })
})
test.each([0, 200])("existing numeric success markers are preserved", async (code) => {
  expect(
    (await lookup({code, data: {current_version: "installed", url: "https://example.invalid/fw"}})).hasUpdate,
  ).toBe(false)
})
test("failed lookups are not presented as no update", async () => {
  await expect(lookup({error: {detail: "vendor unavailable"}}, 503)).rejects.toThrow("vendor unavailable")
  expect(parseAr99Source(null)).toBeNull()
  expect(() => parseAr99Source({...source, baseUrl: "http://example.invalid/"})).toThrow("HTTPS")
})
