import {describe, expect, test} from "bun:test"

import {loadOutgoingStill, meetingCanSharePhoto} from "../outgoingStill"

describe("meetingCanSharePhoto", () => {
  test("a connected owner can share, and a finished meeting cannot", () => {
    expect(
      meetingCanSharePhoto({owner: "com.mentra.call", packageName: "com.mentra.call", released: false, phase: "connected"}),
    ).toBe(true)
    expect(
      meetingCanSharePhoto({owner: "com.mentra.call", packageName: "com.mentra.call", released: false, phase: "disconnected"}),
    ).toBe(false)
    expect(
      meetingCanSharePhoto({owner: "com.mentra.call", packageName: "com.other", released: false, phase: "connected"}),
    ).toBe(false)
    expect(
      meetingCanSharePhoto({owner: "com.mentra.call", packageName: "com.mentra.call", released: true, phase: "connected"}),
    ).toBe(false)
  })
})

describe("loadOutgoingStill", () => {
  test("reads a data URL without fetching it", async () => {
    const bytes = Buffer.from("photo").toString("base64")
    const fetchImpl = (() => {
      throw new Error("fetched")
    }) as unknown as typeof fetch
    await expect(loadOutgoingStill(`data:image/jpeg;base64,${bytes}`, fetchImpl)).resolves.toBe(bytes)
  })

  test("rejects an empty download", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array(), {status: 200})) as unknown as typeof fetch
    await expect(loadOutgoingStill("https://photos.example/a.jpg", fetchImpl)).rejects.toThrow("could not be read")
  })

  // The host's fetch reads file: URLs on iOS, and the bytes would go out to the meeting.
  test("fetches only http and https photo URLs", async () => {
    const fetched: string[] = []
    const fetchImpl = (async (url: string) => {
      fetched.push(url)
      return new Response(new Uint8Array([1, 2, 3]), {status: 200})
    }) as unknown as typeof fetch
    for (const url of [
      "file:///var/mobile/Documents/mmkv/mmkv.default",
      "FILE:///etc/hosts",
      "content://x/y",
      "/etc/hosts",
    ]) {
      await expect(loadOutgoingStill(url, fetchImpl)).rejects.toThrow("http")
    }
    expect(fetched).toEqual([])
    await expect(loadOutgoingStill("https://photos.example/a.jpg", fetchImpl)).resolves.toBe("AQID")
    await expect(loadOutgoingStill("DATA:image/jpeg;base64,AQID", fetchImpl)).resolves.toBe("AQID")
  })
})
