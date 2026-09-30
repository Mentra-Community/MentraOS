import {describe, expect, test} from "bun:test"
import {acquireFirmwareRuntime, cancelDeferredFirmwareStop, deferStopForFirmware} from "../RuntimeLease"

describe("firmware runtime input lifetime", () => {
  test("one failed projection cleanup cannot strand the remaining projections", () => {
    const release = acquireFirmwareRuntime()
    let stopped = false
    deferStopForFirmware(() => {
      throw new Error("projection teardown failed")
    })
    deferStopForFirmware(() => {
      stopped = true
    })
    release()
    expect(stopped).toBe(true)
    expect(deferStopForFirmware(() => {})).toBe(false)
  })
  test("keeps device projections until the final owner releases, with idempotent cleanup", () => {
    const first = acquireFirmwareRuntime()
    const second = acquireFirmwareRuntime()
    let stops = 0
    expect(deferStopForFirmware(() => stops++)).toBe(true)
    first()
    first()
    expect(stops).toBe(0)
    second()
    expect(stops).toBe(1)
    expect(deferStopForFirmware(() => stops++)).toBe(false)
  })

  test("a new Engine start supersedes its earlier deferred stop", () => {
    const release = acquireFirmwareRuntime()
    let stops = 0
    const stop = () => stops++
    deferStopForFirmware(stop)
    cancelDeferredFirmwareStop(stop)
    release()
    expect(stops).toBe(0)
  })
})
