import {expect, test} from "bun:test"
import {createInterface} from "node:readline"
import {PassThrough} from "node:stream"
import {waitForNativeCheckpoint} from "./native-checkpoint"

function pipe() {
  const source = new PassThrough()
  const input = createInterface({input: source})
  const closed = new AbortController()
  input.once("close", () => closed.abort(new Error("controller pipe closed")))
  return {
    source,
    input,
    signal: closed.signal,
    close: () => {
      input.close()
      source.destroy()
    },
  }
}

test("a fast acknowledgement cannot skip incomplete or failed checkpoint evidence", async () => {
  const p = pipe()
  try {
    let failEvidence!: (error: Error) => void
    let completed = false
    const pending = waitForNativeCheckpoint(
      p.input,
      "mute",
      async () => {
        p.source.write("MENTRA_NATIVE_ACK mute\n")
        await new Promise<void>((_, reject) => {
          failEvidence = reject
        })
      },
      performance.now() + 1000,
      p.signal,
    )
    pending.then(
      () => {
        completed = true
      },
      () => {},
    )
    await Bun.sleep(5)
    expect(completed).toBe(false)
    failEvidence(new Error("screenshot failed"))
    await expect(pending).rejects.toThrow("screenshot failed")
    expect(p.input.listenerCount("line")).toBe(0)
  } finally {
    p.close()
  }
})

test("only the requested checkpoint releases the native barrier", async () => {
  const p = pipe()
  try {
    const pending = waitForNativeCheckpoint(
      p.input,
      "mute",
      async () => {
        p.source.write("MENTRA_NATIVE_ACK browser-left\n")
      },
      performance.now() + 1000,
      p.signal,
    )
    let completed = false
    pending.then(() => {
      completed = true
    })
    await Bun.sleep(5)
    expect(completed).toBe(false)
    p.source.write("MENTRA_NATIVE_ACK mute\n")
    await pending
    expect(completed).toBe(true)
    expect(p.input.listenerCount("line")).toBe(0)
  } finally {
    p.close()
  }
})

test("a closed controller interrupts the wait and prevents later checkpoint publication", async () => {
  const p = pipe()
  try {
    let earlyPublished = false
    const pending = waitForNativeCheckpoint(
      p.input,
      "mute",
      async () => {
        earlyPublished = true
      },
      performance.now() + 1000,
      p.signal,
    )
    p.close()
    await expect(pending).rejects.toThrow("controller pipe closed")
    expect(earlyPublished).toBe(false)
    let published = false
    await expect(
      waitForNativeCheckpoint(
        p.input,
        "restore",
        async () => {
          published = true
        },
        performance.now() + 1000,
        p.signal,
      ),
    ).rejects.toThrow("controller pipe closed")
    expect(published).toBe(false)
    expect(p.input.listenerCount("line")).toBe(0)
  } finally {
    p.close()
  }
})

test("the run deadline bounds slow native work without resetting at each checkpoint", async () => {
  const p = pipe()
  try {
    const deadline = performance.now() + 500
    await waitForNativeCheckpoint(
      p.input,
      "mute",
      async () => {
        await Bun.sleep(35)
        p.source.write("MENTRA_NATIVE_ACK mute\n")
      },
      deadline,
      p.signal,
    )
    await expect(waitForNativeCheckpoint(p.input, "restore", async () => {}, deadline, p.signal)).rejects.toThrow(
      "Controller deadline expired",
    )
    let published = false
    await expect(
      waitForNativeCheckpoint(
        p.input,
        "late",
        async () => {
          published = true
        },
        performance.now() - 1,
        p.signal,
      ),
    ).rejects.toThrow("Controller deadline expired")
    expect(published).toBe(false)
    expect(p.input.listenerCount("line")).toBe(0)
  } finally {
    p.close()
  }
})
