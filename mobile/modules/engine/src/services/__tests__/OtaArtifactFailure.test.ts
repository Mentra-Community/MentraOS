import {describe, expect, test} from "bun:test"

import {otaArtifactFailure} from "../OtaArtifactFailure"
import {OTA_ERROR_ENGLISH_COPY, phoneOtaErrorCopyKey} from "../OtaErrorMapping"

const context = {artifact: "apk", stage: "download", bytesWritten: 40, contentLength: 100} as const

describe("phone download failure diagnosis", () => {
  test.each([
    ["Network is down", "internet"],
    ["The Internet connection appears to be offline.", "download"],
    ["not connected to the Internet", "internet"],
    ['Unable to resolve host "cdn.example.com"', "connection"],
    ["Software caused connection abort", "connection"],
    ["Connection reset", "connection"],
    ["ENETUNREACH", "connection"],
    ["Read timed out", "timeout"],
    ["No space left on device", "storage"],
    ["EACCES: Permission denied", "save"],
    ["SSLHandshakeException", "secure_connection"],
    ["unexpected native failure", "download"],
  ])("classifies %s without inventing a broader cause", (message, category) => {
    const failure = otaArtifactFailure(new Error(message), context)
    expect(failure.category).toBe(category)
    const copy = OTA_ERROR_ENGLISH_COPY[phoneOtaErrorCopyKey({code: "artifact_download_failed", failure})]
    expect(copy.toLowerCase().includes("internet")).toBe(category === "internet")
  })

  test("retains HTTP failure, byte progress, and non-enumerable native cause fields", () => {
    const error = new Error("read failed", {cause: Object.assign(new Error("Connection reset"), {code: "ECONNRESET"})})
    const failure = otaArtifactFailure(error, {...context, httpStatus: 503})
    expect(failure).toMatchObject({category: "server", httpStatus: 503, bytesWritten: 40, contentLength: 100})
    expect(failure.nativeErrors).toEqual([
      {name: "Error", message: "read failed"},
      {name: "Error", code: "ECONNRESET", message: "Connection reset"},
    ])
  })

  test.each([404, 503])("recognizes the existing iOS HTTP %s rejection, including Expo wrappers", (status) => {
    const error = new Error(
      `Calling the 'downloadArtifact' function has failed\n→ Caused by: Artifact download failed with HTTP ${status}`,
    )
    const failure = otaArtifactFailure(error, context)
    expect(failure).toMatchObject({httpStatus: status, category: "server"})
    expect(phoneOtaErrorCopyKey({code: "artifact_download_failed", failure})).toBe("ota:errorPhoneDownloadServer")
  })

  test("does not treat missing HTTP status or unrelated status text as a server response", () => {
    expect(otaArtifactFailure(new Error("Artifact download failed with HTTP 0"), context).category).toBe("download")
    expect(otaArtifactFailure(new Error("HTTP 404"), context).httpStatus).toBeUndefined()
    expect(otaArtifactFailure(new Error("unknown"), {...context, httpStatus: 0}).category).toBe("download")
  })

  test("does not relabel verification or final save failures as internet problems", () => {
    expect(otaArtifactFailure(new Error("Network is down"), {...context, stage: "verify"}).category).toBe("verify")
    expect(otaArtifactFailure(new Error("Network is down"), {...context, stage: "save"}).category).toBe("save")
  })

  test("redacts signed URLs, local paths and secrets; bounds cyclic native cause chains", () => {
    const error = Object.assign(
      new Error(
        "Unable to resolve host https://cdn.example/update?signature=private /data/user/0/private.apk token=secret",
      ),
      {code: "EAI_NODATA", userInfo: {password: "private"}},
    )
    Object.defineProperty(error, "cause", {value: error})
    const json = JSON.stringify(otaArtifactFailure(error, context))
    expect(json).toContain("EAI_NODATA")
    expect(json).not.toContain("private")
    expect(json).not.toContain("secret")
    expect(json).not.toContain("userInfo")
  })

  test("uses stage-specific copy for legacy wrappers and a plain fallback for unknown failures", () => {
    expect(phoneOtaErrorCopyKey({code: "artifact_download_failed"})).toBe("ota:errorPhoneDownload")
    expect(phoneOtaErrorCopyKey({code: "artifact_verify_failed"})).toBe("ota:errorPhoneVerify")
    expect(phoneOtaErrorCopyKey({code: "unrecognized"})).toBe("ota:errorGeneric")
    expect(OTA_ERROR_ENGLISH_COPY[phoneOtaErrorCopyKey(new Error("unknown"))]).toBe(
      "Something went wrong. Please try again.",
    )
  })
})
