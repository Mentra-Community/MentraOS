import {afterEach, beforeEach, expect, mock, spyOn, test} from "bun:test"

import {ReportModel} from "../models/report.model"
import {UserModel} from "../models/user.model"
import {notifyFirmwareLogAttached} from "./report.service"

const owner = {mentraUserId: "mu_test", reportId: "rep_BESCRASH"}
const realFetch = globalThis.fetch
const saved = {token: process.env.CLOUD_REPORTS_SLACK_BOT_TOKEN, channel: process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID_AUTOMATIC}
let fetchMock: ReturnType<typeof mock>
let update: ReturnType<typeof spyOn>
let unset: ReturnType<typeof spyOn>

const claimed = {
  kind: "automatic",
  trigger: {type: "automatic", source: "glasses_firmware_crash", reason: "bes_crash"},
  report: {actualBehavior: "BES crashed"},
  feedback: null,
  context: {},
  artifacts: [{artifactId: "art_1"}, {artifactId: "art_2"}],
}

beforeEach(() => {
  process.env.CLOUD_REPORTS_SLACK_BOT_TOKEN = "xoxb-test"
  process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID_AUTOMATIC = "C0AUTO"
  fetchMock = mock(async () => Response.json({ok: true, ts: "1.2"}))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  spyOn(UserModel, "findOne").mockReturnValue({lean: async () => null} as never)
  unset = spyOn(ReportModel, "updateOne").mockResolvedValue({} as never)
})

afterEach(() => {
  mock.restore()
  globalThis.fetch = realFetch
  for (const [key, value] of [["CLOUD_REPORTS_SLACK_BOT_TOKEN", saved.token], ["CLOUD_REPORTS_SLACK_CHANNEL_ID_AUTOMATIC", saved.channel]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("posts one follow-up with the updated artifact count when the claim succeeds", async () => {
  update = spyOn(ReportModel, "findOneAndUpdate").mockReturnValue({lean: async () => claimed} as never)

  expect(await notifyFirmwareLogAttached(owner)).toBe(true)

  const [filter, change] = update.mock.calls[0] as [Record<string, unknown>, {$set: Record<string, unknown>}]
  expect(filter).toMatchObject({kind: "automatic", status: "ready", "trigger.source": "glasses_firmware_crash", firmwareLogNotifiedAt: {$exists: false}})
  expect(change.$set.firmwareLogNotifiedAt).toBeInstanceOf(Date)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
  expect(body.channel).toBe("C0AUTO")
  expect(body.text).toContain("Artifacts: 2")
  expect(body.text).toContain("BES firmware log attached")
})

test("stays silent when the report is still collecting, not a crash, or already followed up", async () => {
  update = spyOn(ReportModel, "findOneAndUpdate").mockReturnValue({lean: async () => null} as never)

  expect(await notifyFirmwareLogAttached(owner)).toBe(false)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("releases the claim when Slack refuses so a later upload can retry", async () => {
  update = spyOn(ReportModel, "findOneAndUpdate").mockReturnValue({lean: async () => claimed} as never)
  fetchMock = mock(async () => Response.json({ok: false, error: "channel_not_found"}))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  expect(await notifyFirmwareLogAttached(owner)).toBe(false)
  expect(unset.mock.calls[0]?.[1]).toEqual({$unset: {firmwareLogNotifiedAt: ""}})
})

test("never throws into the upload path", async () => {
  update = spyOn(ReportModel, "findOneAndUpdate").mockImplementation(() => { throw new Error("mongo down") })

  expect(await notifyFirmwareLogAttached(owner)).toBe(false)
})
