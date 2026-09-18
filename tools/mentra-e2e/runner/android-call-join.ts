import {AndroidSession} from "./android-session"

const exact = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** One instrumentation session and one deadline, including delayed system prompts. */
export function androidJoinCommands(expectedSsid: string, deadlineMs: number): Record<string, unknown>[] {
  if (!/^MentraLive_[A-Za-z0-9_-]+$/.test(expectedSsid)) throw new Error("Expected this run's verified glasses SSID")
  if (!Number.isFinite(deadlineMs)) throw new Error("Invalid join deadline")
  const title = "com.android.settings:id/network_request_title_text"
  const failures =
    "No devices found\\..*|Something came up\\..*|Couldn’t join the meeting|Couldn’t start glasses camera|Call limit reached"
  return [
    {evalScript: "${output.joinDeadline = " + deadlineMs + "; output.joinApproved = false; output.joined = false}"},
    {
      repeat: {
        while: {true: "${Date.now() < output.joinDeadline && !output.joined}"},
        commands: [
          {assertNotVisible: failures},
          {
            runFlow: {
              // The title also exists while Android is still searching. Only the
              // actionable Connect button permits checking and approving the SSID.
              when: {
                true: "${!output.joinApproved}",
                visible: {id: "android:id/button1", text: "Connect", enabled: true},
              },
              commands: [
                {assertVisible: {id: title, text: "Connect to device"}},
                {
                  assertVisible: {
                    id: "com.android.settings:id/network_request_summary_text",
                    text: exact("Mentra app wants to use a temporary Wi‑Fi network to connect to your device"),
                  },
                },
                {assertVisible: {id: "android:id/message", text: exact(expectedSsid)}},
                {takeScreenshot: "android-network-before-connect"},
                {assertTrue: "${Date.now() < output.joinDeadline}"},
                {tapOn: {id: "android:id/button1", text: "Connect", enabled: true, retryTapIfNoChange: false}},
                {evalScript: "${output.joinApproved = true}"},
              ],
            },
          },
          {assertNotVisible: failures},
          {
            runFlow: {
              when: {true: "${output.joinApproved}", notVisible: {id: title}, visible: "Leave the call"},
              commands: [{assertNotVisible: {id: "android:id/message"}}, {evalScript: "${output.joined = true}"}],
            },
          },
        ],
      },
    },
    {assertTrue: "${output.joinApproved && output.joined && Date.now() < output.joinDeadline}"},
    {takeScreenshot: "android-call-joined"},
  ]
}

/**
 * The caller supplies the SSID from this attempt's identity-verified native trace.
 * A prompt-free/cached association is not qualified by this routine: Leave alone
 * cannot prove that the network request succeeded. Native media checks follow.
 * This helper never creates/retries a call and never performs OTA.
 */
export async function waitForAndroidCallJoin(run: AndroidSession, expectedSsid: string, timeoutMs = 90_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new Error("Invalid join deadline")
  await run.step(
    "CALL-NETWORK-CONNECT",
    "Wait for Android's network decision and approve only this run's verified glasses hotspot.",
    "The exact Mentra hotspot prompt is approved and disappears before the call exposes Leave; native media is checked separately.",
    async () => {
      const commands = androidJoinCommands(expectedSsid, Date.now() + timeoutMs)
      // The same overall budget covers searching, approval and call UI. Allow
      // five additional seconds only for the instrumentation process to close.
      await run.flow("CALL-NETWORK-CONNECT", commands, timeoutMs + 5000)
    },
  )
}
