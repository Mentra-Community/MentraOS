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
 * After Create & Join, poll both system and app UI. The caller must read the SSID
 * from this attempt's identity-verified native trace, not a saved network name.
 * This helper never creates/retries a call and never performs OTA.
 */
export async function waitForAndroidCallJoin(run: AndroidSession, expectedSsid: string, timeoutMs = 90_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new Error("Invalid join deadline")
  const deadline = Date.now() + timeoutMs
  let approved = false
  while (Date.now() < deadline) {
    const state = androidJoinState((await run.snapshot()).nodes, expectedSsid)
    if (state.kind === "failed") throw new Error(state.reason)
    if (state.kind === "connected") return
    if (state.kind === "connect") {
      if (approved) throw new Error("Android repeated the network approval; do not retry silently")
      approved = true
      await run.step(
        "CALL-NETWORK-CONNECT",
        "Approve the temporary Wi-Fi connection to this run's verified glasses hotspot.",
        "The matching Android network prompt closes; subsequent checks still require successful call join.",
        async () => {
          await run.flow("CALL-NETWORK-CONNECT", [
            {assertVisible: {id: "com.android.settings:id/network_request_title_text", text: "Connect to device"}},
            {assertVisible: {id: "com.android.settings:id/network_request_summary_text", text: exact(state.summary)}},
            {assertVisible: {id: "android:id/message", text: exact(expectedSsid)}},
            {tapOn: {id: "android:id/button1", text: "Connect"}},
            {
              extendedWaitUntil: {
                notVisible: {id: "com.android.settings:id/network_request_title_text"},
                timeout: 15000,
              },
            },
          ])
        },
      )
    }
    await Bun.sleep(250)
  }
  throw new Error("Call join timed out; preserve evidence and clean up the owned attempt before retrying")
}
