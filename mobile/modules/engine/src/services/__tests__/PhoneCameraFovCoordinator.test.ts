/// <reference types="bun-types" />

import {beforeEach, describe, expect, test} from "bun:test"

import {
  releaseCameraFovOverride,
  resetAudioTestMocks,
  restoreLegacyCameraFov,
  setCameraFovOverride,
  setLegacyCameraFov,
} from "./audioTestMocks"

const {PhoneCameraFovCoordinator} = await import("../PhoneCameraFovCoordinator")

beforeEach(() => {
  resetAudioTestMocks()
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

  test("falls back to the acknowledgement-free staging command when override support is unavailable", async () => {
    setCameraFovOverride.mockRejectedValueOnce(new Error("timed out waiting for glasses response"))
    const coordinator = new PhoneCameraFovCoordinator(0)

    await expect(coordinator.setOverride("com.a", {fov: 62, roiPosition: "center"})).resolves.toMatchObject({
      fov: 62,
      roiPosition: "center",
    })
    expect(setLegacyCameraFov).toHaveBeenCalledWith({fov: 62, roiPosition: "center"})

    await coordinator.setOverride("com.a", {fov: 82})
    expect(setCameraFovOverride).toHaveBeenCalledTimes(1)
    expect(setLegacyCameraFov).toHaveBeenCalledTimes(2)

    await coordinator.releaseForApp("com.a")
    expect(restoreLegacyCameraFov).toHaveBeenCalledTimes(1)

    // A completed ownership cycle probes the modern lease path again, allowing
    // recovery after a transient timeout or a glasses reconnect/upgrade.
    await coordinator.setOverride("com.a", {fov: 102})
    expect(setCameraFovOverride).toHaveBeenCalledTimes(2)
    await coordinator.releaseForApp("com.a")
  })

  test("does not latch legacy mode when the fallback itself fails", async () => {
    setCameraFovOverride.mockRejectedValueOnce(new Error("timed out waiting for glasses response"))
    setLegacyCameraFov.mockRejectedValueOnce(new Error("not_connected"))
    const coordinator = new PhoneCameraFovCoordinator(0)

    await expect(coordinator.setOverride("com.a", {fov: 62})).rejects.toThrow("not_connected")
    await coordinator.setOverride("com.a", {fov: 82})

    expect(setCameraFovOverride).toHaveBeenCalledTimes(2)
    expect(setLegacyCameraFov).toHaveBeenCalledTimes(1)
    await coordinator.releaseForApp("com.a")
  })

  test("does not treat a generic native rejection as legacy compatibility", async () => {
    setCameraFovOverride.mockRejectedValueOnce(new Error("native request has been rejected: camera busy"))
    const coordinator = new PhoneCameraFovCoordinator(0)

    await expect(coordinator.setOverride("com.a", {fov: 62})).rejects.toThrow("camera busy")

    expect(setLegacyCameraFov).not.toHaveBeenCalled()
  })
})
