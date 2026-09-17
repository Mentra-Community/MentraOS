import {AndroidSession, type androidNodes} from "./android-session"

type Node = ReturnType<typeof androidNodes>[number]
export type AndroidJoinState =
  {kind: "waiting" | "connected"} | {kind: "connect"; summary: string} | {kind: "failed"; reason: string}

/** System positive-button IDs are reused: never infer Connect from button1 alone. */
export function androidJoinState(nodes: Node[], expectedSsid: string): AndroidJoinState {
  if (!/^MentraLive_[A-Za-z0-9_-]+$/.test(expectedSsid)) throw new Error("Expected this run's verified glasses SSID")
  const has = (text: string) => nodes.some((n) => n.text === text || n.description === text)
  const node = (id: string) => nodes.find((n) => n.id === id)
  const message = node("android:id/message")?.text
  if (message === "No devices found. Make sure devices are turned on and available to connect.")
    return {kind: "failed", reason: "Android found no device for the requested hotspot"}
  if (message === "Something came up. The application has cancelled the request to choose a device.")
    return {kind: "failed", reason: "Android network request was cancelled before association"}
  if (node("com.android.settings:id/network_request_title_text")?.text === "Connect to device") {
    const summary = node("com.android.settings:id/network_request_summary_text")?.text
    if (
      summary !== "Mentra app wants to use a temporary Wi‑Fi network to connect to your device" ||
      message !== expectedSsid ||
      node("android:id/button1")?.text !== "Connect"
    )
      return {kind: "failed", reason: "Network prompt does not match Mentra, the verified SSID and Connect action"}
    return {kind: "connect", summary}
  }
  // A system message can cover underlying accessibility nodes from the app.
  if (message) return {kind: "waiting"}
  if (["Couldn’t join the meeting", "Couldn’t start glasses camera", "Call limit reached"].some(has))
    return {kind: "failed", reason: "Mentra Call reported a terminal join failure"}
  return {kind: has("Leave the call") ? "connected" : "waiting"}
}

const exact = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * After Create & Join, wait for system or app UI within one instrumentation session. The caller must read the SSID
 * from this attempt's identity-verified native trace, not a saved network name.
 * This helper never creates/retries a call and never performs OTA.
 */
export async function waitForAndroidCallJoin(run: AndroidSession, expectedSsid: string, timeoutMs = 90_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new Error("Invalid join deadline")
  if (!/^MentraLive_[A-Za-z0-9_-]+$/.test(expectedSsid)) throw new Error("Expected this run's verified glasses SSID")
  // Keep UI observation and the press inside one Maestro instrumentation session.
  // Android's external uiautomator dump waits for UI idleness and missed the
  // 30-second network approval while the join progress screen kept changing.
  const title = "com.android.settings:id/network_request_title_text"
  const summary = "Mentra app wants to use a temporary Wi‑Fi network to connect to your device"
  await run.step(
    "CALL-NETWORK-CONNECT",
    "Wait for Android's network decision and approve only this run's verified glasses hotspot.",
    "Any offered network prompt matches Mentra and the exact SSID; the call then exposes Leave.",
    async () => {
      await run.flow("CALL-NETWORK-CONNECT", [
        {
          extendedWaitUntil: {
            visible: {
              text: "Connect to device|Leave the call|Couldn’t join the meeting|Couldn’t start glasses camera|Call limit reached|No devices found\\..*|Something came up\\..*",
            },
            timeout: timeoutMs,
          },
        },
        {
          runFlow: {
            when: {visible: {id: title, text: "Connect to device"}},
            commands: [
              {assertVisible: {id: "com.android.settings:id/network_request_summary_text", text: exact(summary)}},
              {assertVisible: {id: "android:id/message", text: exact(expectedSsid)}},
              {takeScreenshot: "android-network-before-connect"},
              {tapOn: {id: "android:id/button1", text: "Connect"}},
            ],
          },
        },
        {
          assertNotVisible:
            "No devices found\\..*|Something came up\\..*|Couldn’t join the meeting|Couldn’t start glasses camera|Call limit reached",
        },
        {extendedWaitUntil: {visible: "Leave the call", timeout: timeoutMs}},
        {takeScreenshot: "android-call-joined"},
      ])
    },
  )
}
