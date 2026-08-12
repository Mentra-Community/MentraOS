import {describe, expect, mock, test} from "bun:test"
import type {HttpClient} from "../../http"
import {SupportProfiles, type SupportStateInput} from "./support-profile"

describe("SupportProfiles", () => {
  test("uses an idempotent authenticated Core PUT", async () => {
    const put = mock(async () => ({status: "accepted" as const, observedAt: snapshot.observedAt}))
    const support = new SupportProfiles({put} as unknown as HttpClient)

    await expect(support.update(snapshot)).resolves.toEqual({
      status: "accepted",
      observedAt: snapshot.observedAt,
    })
    expect(put).toHaveBeenCalledWith("/api/client/support-profile", snapshot, {idempotent: true})
  })
})

const snapshot: SupportStateInput = {
  observedAt: "2026-08-11T12:00:00.000Z",
  host: {
    appVersion: "2.4.0",
    phonePlatform: "ios",
    phoneOsVersion: "26.0",
    connectionState: "connected",
  },
  device: {hardwareId: "not-persisted", model: "Mentra Live", firmwareVersion: "1.2.3"},
}
