/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

const setCameraFovOverride = mock(async (request: Record<string, unknown>) => ({
  requestId: "ack-1",
  fov: "preset" in request ? (request.preset === "wide" ? 118 : 102) : request.fov,
  roiPosition: "preset" in request ? "center" : request.roiPosition ?? "center",
  timestamp: 1,
}))
const releaseCameraFovOverride = mock(async (_leaseId: string) => ({ready: true}))

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  default: {setCameraFovOverride, releaseCameraFovOverride},
}))

const {PhoneCameraFovCoordinator} = await import("../PhoneCameraFovCoordinator")

beforeEach(() => {
  setCameraFovOverride.mockClear()
  releaseCameraFovOverride.mockClear()
})

describe("PhoneCameraFovCoordinator", () => {
  test("uses last-writer-wins and restores the previous live miniapp override", async () => {
    const coordinator = new PhoneCameraFovCoordinator()
    await coordinator.setOverride("com.a", {fov: 82, roiPosition: "bottom"})
    const aLease = (setCameraFovOverride.mock.calls[0]![0] as {leaseId: string}).leaseId

    await coordinator.setOverride("com.b", {preset: "wide"})
    const bLease = (setCameraFovOverride.mock.calls[1]![0] as {leaseId: string}).leaseId
    expect(bLease).not.toBe(aLease)

    await coordinator.releaseForApp("com.b")
    expect(setCameraFovOverride.mock.calls[2]![0]).toMatchObject({
      leaseId: aLease,
      fov: 82,
      roiPosition: "bottom",
    })
    expect(releaseCameraFovOverride).not.toHaveBeenCalled()
    await coordinator.releaseForApp("com.a")
  })

  test("releasing the final owner asks ASG to restore its persistent base", async () => {
    const coordinator = new PhoneCameraFovCoordinator()
    await coordinator.setOverride("com.a", {preset: "standard"})
    const leaseId = (setCameraFovOverride.mock.calls[0]![0] as {leaseId: string}).leaseId

    await coordinator.releaseForApp("com.a")
    expect(releaseCameraFovOverride).toHaveBeenCalledWith(leaseId)
  })

  test("releasing a non-effective owner does not disturb the active hardware lease", async () => {
    const coordinator = new PhoneCameraFovCoordinator()
    await coordinator.setOverride("com.a", {fov: 90})
    await coordinator.setOverride("com.b", {fov: 100})
    setCameraFovOverride.mockClear()

    await coordinator.releaseForApp("com.a")
    expect(setCameraFovOverride).not.toHaveBeenCalled()
    expect(releaseCameraFovOverride).not.toHaveBeenCalled()
    await coordinator.releaseForApp("com.b")
  })

  test("serializes concurrent HAL-changing requests", async () => {
    const coordinator = new PhoneCameraFovCoordinator()
    await Promise.all([coordinator.setOverride("com.a", {fov: 82}), coordinator.setOverride("com.b", {fov: 102})])
    expect(setCameraFovOverride.mock.calls.map((call) => (call[0] as {fov: number}).fov)).toEqual([82, 102])
    await coordinator.releaseForApp("com.b")
    await coordinator.releaseForApp("com.a")
  })

  test("reuses a package lease when that miniapp changes its crop", async () => {
    const coordinator = new PhoneCameraFovCoordinator()
    await coordinator.setOverride("com.a", {fov: 82})
    await coordinator.setOverride("com.a", {fov: 102, roiPosition: "top"})

    const firstLease = (setCameraFovOverride.mock.calls[0]![0] as {leaseId: string}).leaseId
    expect(setCameraFovOverride.mock.calls[1]![0]).toMatchObject({
      leaseId: firstLease,
      fov: 102,
      roiPosition: "top",
    })
    await coordinator.releaseForApp("com.a")
  })

  test("retains the effective owner when restoring a previous override fails", async () => {
    const coordinator = new PhoneCameraFovCoordinator()
    await coordinator.setOverride("com.a", {fov: 82})
    await coordinator.setOverride("com.b", {fov: 102})
    const bLease = (setCameraFovOverride.mock.calls[1]![0] as {leaseId: string}).leaseId
    setCameraFovOverride.mockRejectedValueOnce(new Error("glasses disconnected"))

    await expect(coordinator.releaseForApp("com.b")).rejects.toThrow("glasses disconnected")
    await coordinator.releaseForApp("com.b")

    expect(setCameraFovOverride.mock.calls[3]![0]).toMatchObject({fov: 82})
    expect(releaseCameraFovOverride).not.toHaveBeenCalledWith(bLease)
    await coordinator.releaseForApp("com.a")
  })

  test("retains the final owner when restoring the persistent base fails", async () => {
    const coordinator = new PhoneCameraFovCoordinator()
    await coordinator.setOverride("com.a", {fov: 82})
    const leaseId = (setCameraFovOverride.mock.calls[0]![0] as {leaseId: string}).leaseId
    releaseCameraFovOverride.mockRejectedValueOnce(new Error("glasses disconnected"))

    await expect(coordinator.releaseForApp("com.a")).rejects.toThrow("glasses disconnected")
    await coordinator.releaseForApp("com.a")

    expect(releaseCameraFovOverride.mock.calls).toEqual([[leaseId], [leaseId]])
  })
})
