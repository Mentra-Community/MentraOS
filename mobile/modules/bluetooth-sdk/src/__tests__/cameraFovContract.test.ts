import {readFileSync} from "node:fs"
import {resolve} from "node:path"

// These values cross separately shipped Java/Kotlin/Swift packages. Guard the wire
// contract here so changing ASG's recovery allowance cannot silently shorten SDK waits.
const root = resolve(__dirname, "../../../../../")
const asg = readFileSync(resolve(root, "asg_client/app/src/main/java/com/mentra/asg_client/AsgConstants.java"), "utf8")
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

describe("FOV readiness wire deadline", () => {
  it.each([
    [
      "Android",
      android,
      "CAMERA_FOV_READY_TIMEOUT_MS",
      "CAMERA_FOV_DELIVERY_MARGIN_MS",
      "CAMERA_FOV_REQUEST_TIMEOUT_MS",
    ],
    ["iOS", ios, "cameraFovReadyTimeoutMs", "cameraFovDeliveryMarginMs", "cameraFovRequestTimeoutMs"],
  ])("keeps %s aligned with one active and one pending ASG update", (_platform, sdk, ready, margin, total) => {
    const readyMs = literal(asg, "CAMERA_FOV_READY_TIMEOUT_MS")
    const marginMs = literal(asg, "CAMERA_FOV_DELIVERY_MARGIN_MS")
    expect(literal(sdk, ready)).toBe(readyMs)
    expect(literal(sdk, margin)).toBe(marginMs)
    expect(sdk).toMatch(new RegExp(`${total}\\s*=\\s*2 \\* ${ready} \\+ ${margin}`))
    expect(asg).toMatch(
      /CAMERA_FOV_REQUEST_TIMEOUT_MS\s*=\s*2 \* CAMERA_FOV_READY_TIMEOUT_MS \+ CAMERA_FOV_DELIVERY_MARGIN_MS/,
    )
    expect(2 * readyMs + marginMs).toBe(45_000)
  })
})
