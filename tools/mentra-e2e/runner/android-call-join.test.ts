import {expect, test} from "bun:test"
import {androidJoinState} from "./android-call-join"

const node = (id: string, text: string, description = "") => ({id, text, description})
const prompt = [
  node("com.android.settings:id/network_request_title_text", "Connect to device"),
  node(
    "com.android.settings:id/network_request_summary_text",
    "Mentra app wants to use a temporary Wi‑Fi network to connect to your device",
  ),
  node("android:id/message", "MentraLive_b9a02c"),
  node("android:id/button3", "Cancel"),
  node("android:id/button1", "Connect"),
]

test("accepts the observed Mentra network prompt only for the verified hotspot", () => {
  expect(androidJoinState(prompt, "MentraLive_b9a02c").kind).toBe("connect")
  expect(androidJoinState(prompt, "MentraLive_other").kind).toBe("failed")
  expect(
    androidJoinState(
      prompt.map((n) => (n.id.endsWith("summary_text") ? {...n, text: "Another app"} : n)),
      "MentraLive_b9a02c",
    ).kind,
  ).toBe("failed")
})

test("the reused positive button never turns OK or Try again into Connect", () => {
  for (const text of ["OK", "Try again"]) {
    expect(
      androidJoinState(
        prompt.map((n) => (n.id === "android:id/button1" ? {...n, text} : n)),
        "MentraLive_b9a02c",
      ).kind,
    ).toBe("failed")
  }
})

test("network failure overlays take priority over stale app Leave nodes", () => {
  const stale = node("", "", "Leave the call")
  for (const text of [
    "No devices found. Make sure devices are turned on and available to connect.",
    "Something came up. The application has cancelled the request to choose a device.",
  ]) {
    expect(androidJoinState([stale, node("android:id/message", text)], "MentraLive_b9a02c").kind).toBe("failed")
  }
  expect(androidJoinState([stale, node("android:id/message", "Searching for device…")], "MentraLive_b9a02c").kind).toBe(
    "waiting",
  )
})

test("call errors are terminal and an unobscured Leave control establishes UI join only", () => {
  expect(
    androidJoinState([node("", "Couldn’t join the meeting"), node("", "", "Leave the call")], "MentraLive_b9a02c").kind,
  ).toBe("failed")
  expect(androidJoinState([node("", "", "Leave the call")], "MentraLive_b9a02c").kind).toBe("connected")
  expect(() => androidJoinState(prompt, "arbitrary wifi")).toThrow()
})
