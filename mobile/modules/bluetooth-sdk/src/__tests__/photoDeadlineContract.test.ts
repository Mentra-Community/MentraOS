import {readFileSync} from "node:fs"
import {resolve} from "node:path"

const root = resolve(__dirname, "../../../../../")
const asg = readFileSync(resolve(root, "asg_client/app/src/main/java/com/mentra/asg_client/AsgConstants.java"), "utf8")
const service = readFileSync(
  resolve(root, "asg_client/app/src/main/java/com/mentra/asg_client/io/media/core/MediaCaptureService.java"),
  "utf8",
)
const android = readFileSync(
  resolve(__dirname, "../../android/src/main/java/com/mentra/bluetoothsdk/MentraBluetoothSdk.kt"),
  "utf8",
)
const ios = readFileSync(resolve(__dirname, "../../ios/Source/MentraBluetoothSDK.swift"), "utf8")

function literal(source: string, name: string): number {
  const value = source.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`))?.[1]
  if (!value) throw new Error(`Missing numeric constant ${name}`)
  return Number(value.replaceAll("_", ""))
}

// Native SDKs and firmware ship independently. Verify the public requestPhoto wait selects
// the mirrored budget, not just that a (potentially unused) constant has the right value.
describe("thumbnail end-to-end deadline", () => {
  it.each([
    [
      "Android",
      android,
      "PHOTO_CAPTURE_TIMEOUT_MS",
      "PHOTO_THUMBNAIL_TIMEOUT_SECONDS",
      "PHOTO_DELIVERY_TIMEOUT_MS",
      "PHOTO_RESPONSE_MARGIN_MS",
      "PHOTO_THUMBNAIL_REQUEST_TIMEOUT_MS",
    ],
    [
      "iOS",
      ios,
      "photoCaptureTimeoutMs",
      "photoThumbnailTimeoutSeconds",
      "photoDeliveryTimeoutMs",
      "photoResponseMarginMs",
      "photoThumbnailRequestTimeoutMs",
    ],
  ])(
    "keeps %s capture, preview, delivery and response allowances aligned",
    (_name, sdk, capture, preview, delivery, margin, total) => {
      const pairs = [
        [capture, "PHOTO_CAPTURE_TIMEOUT_MS"],
        [preview, "PHOTO_THUMBNAIL_TIMEOUT_SECONDS"],
        [delivery, "PHOTO_DELIVERY_TIMEOUT_MS"],
        [margin, "PHOTO_RESPONSE_MARGIN_MS"],
      ]
      for (const [sdkName, asgName] of pairs) expect(literal(sdk, sdkName)).toBe(literal(asg, asgName))
      expect(sdk).toMatch(
        new RegExp(`${total}\\s*=\\s*${capture} \\+ ${preview} \\* 1000L?\\s*\\+\\s*${delivery} \\+ ${margin}`),
      )
      expect(literal(sdk, capture) + literal(sdk, preview) * 1000 + literal(sdk, delivery) + literal(sdk, margin)).toBe(
        110_000,
      )
    },
  )

  it("selects the opt-in budget in both public SDK request lifecycles", () => {
    expect(android).toMatch(
      /return pending.await\(\s*if \(routedRequest.presendThumbnail\) PHOTO_THUMBNAIL_REQUEST_TIMEOUT_MS else PHOTO_REQUEST_TIMEOUT_MS/,
    )
    expect(ios).toMatch(
      /pending.wait\(timeoutMs: routedRequest.presendThumbnail\s*\? MentraBluetoothSDK.photoThumbnailRequestTimeoutMs\s*: MentraBluetoothSDK.photoRequestTimeoutMs/,
    )
    expect(literal(android, "PHOTO_REQUEST_TIMEOUT_MS")).toBe(30_000)
    expect(literal(ios, "photoRequestTimeoutMs")).toBe(30_000)
    expect(asg).toMatch(
      /PHOTO_THUMBNAIL_JOB_TIMEOUT_MS\s*=\s*PHOTO_CAPTURE_TIMEOUT_MS \+ PHOTO_THUMBNAIL_TIMEOUT_SECONDS \* 1000L \+ PHOTO_DELIVERY_TIMEOUT_MS/,
    )
    expect(asg).toMatch(
      /PHOTO_THUMBNAIL_REQUEST_TIMEOUT_MS\s*=\s*PHOTO_THUMBNAIL_JOB_TIMEOUT_MS \+ PHOTO_RESPONSE_MARGIN_MS/,
    )
    expect(service).toMatch(
      /photoThumbnailIds.containsKey\(requestId\)\s*\? AsgConstants.PHOTO_THUMBNAIL_JOB_TIMEOUT_MS\s*: AsgConstants.PHOTO_CAPTURE_TIMEOUT_MS/,
    )
  })
})
