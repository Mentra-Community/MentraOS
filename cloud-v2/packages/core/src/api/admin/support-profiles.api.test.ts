import {afterEach, expect, mock, spyOn, test} from "bun:test"

import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import {ReportModel} from "../../models/report.model"
import * as reports from "../../services/report.service"
import supportProfiles, {serializeRecentReport} from "./support-profiles.api"

afterEach(() => mock.restore())

const crash = {
  reportId: "rep_BES",
  kind: "automatic",
  status: "ready",
  trigger: {type: "automatic", source: "glasses_firmware_crash", reason: "bes_crash"},
  artifacts: [
    {artifactId: "art_phone", type: "logs", source: "phone"},
    {artifactId: "art_bes", type: "logs", source: "glasses_firmware"},
  ],
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:01:00Z"),
}

test("recent reports expose the trigger and flag BES crashes with their log artifact", () => {
  expect(serializeRecentReport(crash)).toEqual({
    reportId: "rep_BES",
    kind: "automatic",
    status: "ready",
    triggerSource: "glasses_firmware_crash",
    triggerReason: "bes_crash",
    isBesCrash: true,
    besLogArtifactId: "art_bes",
    besLogPath: "/api/admin/support-profiles/bes-log/rep_BES",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:01:00.000Z",
    adminPath: "/api/admin/reports/rep_BES",
  })
})

test("a crash whose BES log has not arrived is still flagged, without an artifact", () => {
  expect(serializeRecentReport({...crash, artifacts: []})).toMatchObject({isBesCrash: true, besLogArtifactId: null, besLogPath: null})
})

test("other reports are not flagged, and missing triggers serialize as null", () => {
  expect(serializeRecentReport({...crash, trigger: {source: "watchdog", reason: "x"}})).toMatchObject({isBesCrash: false, triggerSource: "watchdog"})
  expect(serializeRecentReport({...crash, kind: "bug"})).toMatchObject({isBesCrash: false, besLogArtifactId: "art_bes", besLogPath: null})
  expect(serializeRecentReport({reportId: "rep_F", kind: "feedback", status: "ready", trigger: null})).toMatchObject({
    triggerSource: null, triggerReason: null, isBesCrash: false, besLogArtifactId: null, createdAt: null,
  })
})

const logBody = JSON.stringify({entries: [{timestamp: 1, level: "info", message: "[CRASH-CONTEXT] v=2", source: "BES_CRASH"}]})

function stubReport(row: unknown) {
  spyOn(ReportModel, "findOne").mockReturnValue({lean: async () => row} as never)
}

test("serves the newest BES firmware log text and audits the read", async () => {
  stubReport({mentraUserId: "mu_1", artifacts: [{artifactId: "art_phone", type: "logs", source: "phone"}, {artifactId: "art_bes", type: "logs", source: "glasses_firmware"}]})
  const read = spyOn(reports, "readReportArtifact").mockResolvedValue({sizeBytes: logBody.length, contentType: "application/json", fileName: null, sha256: "x", stream: async () => new Blob([logBody])})
  const audit = spyOn(AdminActionAuditLogModel, "create").mockResolvedValue({} as never)

  const response = await supportProfiles.request("/bes-log/rep_BES")

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(JSON.parse(logBody))
  expect(read).toHaveBeenCalledWith("rep_BES", "art_bes")
  expect((audit.mock.calls[0]![0] as unknown as {action: string; targetId: string}).action).toBe("support_profile.read_bes_log")
})

test("answers 404 for a report without a BES crash log", async () => {
  stubReport({mentraUserId: "mu_1", artifacts: [{artifactId: "art_phone", type: "logs", source: "phone"}]})
  const audit = spyOn(AdminActionAuditLogModel, "create").mockResolvedValue({} as never)

  expect((await supportProfiles.request("/bes-log/rep_BES")).status).toBe(404)
  stubReport(null)
  expect((await supportProfiles.request("/bes-log/rep_OTHER")).status).toBe(404)
  expect(audit).not.toHaveBeenCalled()
})
