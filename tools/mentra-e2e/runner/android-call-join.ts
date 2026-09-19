import {randomUUID} from "node:crypto"
import {readFile, writeFile} from "node:fs/promises"
import {join} from "node:path"
import {androidJoinProof, type AndroidJoinTrace} from "./android-join-proof"
import {AndroidSession} from "./android-session"

const exact = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** One instrumentation session and one deadline, including delayed system prompts. */
export function androidJoinCommands(
  expectedSsid: string,
  deadlineMs: number,
  proofUrl: string,
): Record<string, unknown>[] {
  if (!/^MentraLive_[A-Za-z0-9_-]+$/.test(expectedSsid)) throw new Error("Expected this run's verified glasses SSID")
  if (!Number.isFinite(deadlineMs)) throw new Error("Invalid join deadline")
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+$/.test(proofUrl)) throw new Error("Expected local native-proof endpoint")
  const title = "com.android.settings:id/network_request_title_text"
  const failures =
    "No devices found\\..*|Something came up\\..*|Couldn’t join the meeting|Couldn’t start glasses camera|Call limit reached"
  const readProof = {
    evalScript: "${output.nativeJoined = !!JSON.parse(http.get(" + JSON.stringify(proofUrl) + ").body).proof}",
  }
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
          readProof,
          {
            runFlow: {
              when: {true: "${output.nativeJoined}", notVisible: {id: title}, visible: "Leave the call"},
              commands: [{assertNotVisible: {id: "android:id/message"}}, {evalScript: "${output.joined = true}"}],
            },
          },
        ],
      },
    },
    readProof,
    {assertTrue: "${output.nativeJoined && output.joined && Date.now() < output.joinDeadline}"},
    {takeScreenshot: "android-call-joined"},
  ]
}

/**
 * The caller records logcat -v epoch for the verified phone process and supplies
 * this attempt's fresh trace/SSID. Both prompted and remembered approvals require
 * native association and ACS connection proof. Media checks still follow.
 * This helper never creates/retries a call and never performs OTA.
 */
export async function waitForAndroidCallJoin(run: AndroidSession, trace: AndroidJoinTrace, timeoutMs = 90_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new Error("Invalid join deadline")
  if (
    !Number.isInteger(trace.pid) ||
    trace.pid < 1 ||
    !/^[a-f0-9]+$/.test(trace.traceId) ||
    !Number.isFinite(trace.startedAtMs) ||
    trace.startedAtMs > Date.now() ||
    Date.now() - trace.startedAtMs > 180_000
  )
    throw new Error("Expected this attempt's fresh native trace identity")
  await run.step(
    "CALL-NETWORK-CONNECT",
    "Wait for Android's network decision and approve only this run's verified glasses hotspot.",
    "Any hotspot prompt is approved for the exact glasses. Fresh native logs prove association and ACS connection before Leave can pass; media is checked separately.",
    async () => {
      const deadline = Date.now() + timeoutMs
      const path = "/" + randomUUID()
      const proof = async () => androidJoinProof(await readFile(trace.logPath, "utf8"), trace, Date.now())
      // Maestro's host-side JS polls read-only evidence while continuing to watch
      // for delayed system prompts in the same instrumentation session.
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method !== "GET" || new URL(request.url).pathname !== path || Date.now() >= deadline)
            return new Response("Unavailable", {status: 404})
          return Response.json({proof: await proof()})
        },
      })
      try {
        const commands = androidJoinCommands(trace.ssid, deadline, `http://127.0.0.1:${server.port}${path}`)
        // Five additional seconds are for instrumentation teardown only.
        await run.flow("CALL-NETWORK-CONNECT", commands, timeoutMs + 5000)
        const verified = await proof()
        if (!verified) throw new Error("Native join proof disappeared before flow completion")
        await writeFile(
          join(run.directory, "android-join-proof.json"),
          JSON.stringify({verifiedAt: new Date().toISOString(), ...verified}, null, 2),
        )
      } finally {
        await server.stop(true)
      }
    },
  )
}
