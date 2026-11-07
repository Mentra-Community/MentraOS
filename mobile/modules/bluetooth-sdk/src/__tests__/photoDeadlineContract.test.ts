import {readFileSync} from "node:fs"
import {resolve} from "node:path"

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

// Native SDKs and private firmware ship independently. Verify each public client
// retains the wire budget and actually selects it in requestPhoto.
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
      const pairs: [string, number][] = [
        [capture, 45_000],
        [preview, 30],
        [delivery, 30_000],
        [margin, 5_000],
      ]
      for (const [sdkName, budget] of pairs) expect(literal(sdk, sdkName)).toBe(budget)
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
      /pending.await\(\s*if \(routedRequest.presendThumbnail\) PHOTO_THUMBNAIL_REQUEST_TIMEOUT_MS else PHOTO_REQUEST_TIMEOUT_MS/,
    )
    expect(ios).toMatch(
      /pending.wait\(timeoutMs: routedRequest.presendThumbnail\s*\? MentraBluetoothSDK.photoThumbnailRequestTimeoutMs\s*: MentraBluetoothSDK.photoRequestTimeoutMs/,
    )
    expect(literal(android, "PHOTO_REQUEST_TIMEOUT_MS")).toBe(30_000)
    expect(literal(ios, "photoRequestTimeoutMs")).toBe(30_000)
  })
})
