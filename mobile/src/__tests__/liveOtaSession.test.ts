import {MentraLiveOtaSession} from "../../modules/engine/src/devices/mentra-live/session"
import {fixture, offer, current} from "../test-utils/liveOtaFixture"

describe("headless Live OTA session", () => {
  const sessions: MentraLiveOtaSession[] = []
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    sessions.splice(0).forEach((session) => session.dispose())
    jest.useRealTimers()
  })
  const make = () => {
    const f = fixture()
    sessions.push(f.session)
    return f
  }

  it("waits for status hydration without depending on a mounted React component", async () => {
    const {session, ports, device} = make()
    device({connected: false, ready: false})
    let resolve!: () => void
    jest.mocked(ports.initialize).mockReturnValue(
      new Promise<void>((done) => {
        resolve = done
      }),
    )
    const opened = session.open()
    expect(session.snapshot().state.screen).toBe("initializing")
    expect(session.snapshot().exitRequest).toBe(0)
    resolve()
    await opened
    expect(session.snapshot().exitRequest).toBe(1)
    expect(session.claimExitRequest(1)).toBe(true)
    expect(session.claimExitRequest(1)).toBe(false)
  })

  it("keeps an active coordinator attached when all views unsubscribe and reattach", async () => {
    const {session, ports} = make()
    await session.open({initialPage: "progress", initializeRuntime: false})
    const off = session.subscribe(() => {})
    off()
    session.subscribe(() => {})()
    await session.open({initialPage: "progress", initializeRuntime: false})
    expect(ports.installSession.attach).toHaveBeenCalledTimes(1)
    expect(ports.installSession.detach).not.toHaveBeenCalled()
  })

  it("preserves check arguments, checking duration and known/unknown battery policy", async () => {
    const {session, ports, device} = make()
    await session.open({initializeRuntime: false})
    expect(ports.checkForUpdates).toHaveBeenCalledWith({
      waitForBuildNumberMs: 10_000,
      waitForBesVersionMs: 5000,
      waitForMtkVersionMs: 2000,
      waitForLegacyMigrationMs: 0,
      refreshVersionInfo: true,
      fixClockBeforeCheck: false,
      canPublish: expect.any(Function),
    })
    await jest.advanceTimersByTimeAsync(1099)
    expect(session.snapshot().state.screen).toBe("checking")
    await jest.advanceTimersByTimeAsync(1)
    device({batteryLevel: 24})
    session.install()
    expect(session.snapshot().state.screen).toBe("battery_required")
    expect(ports.installSession.attach).not.toHaveBeenCalled()
    device({batteryLevel: null})
    session.install()
    session.install()
    expect(ports.installSession.prepare).toHaveBeenCalledTimes(1)
    expect(ports.installSession.attach).toHaveBeenCalledTimes(1)
    expect(session.chain.isOtaAutoChainActive()).toBe(true)
  })

  it("keeps finishing visible through asynchronous hotspot teardown and final verification", async () => {
    const {session, ports, install} = make()
    await session.open({initializeRuntime: false})
    await jest.advanceTimersByTimeAsync(1100)
    session.install()
    let finish!: () => void
    jest.mocked(ports.installSession.finish).mockReturnValue(
      new Promise<void>((done) => {
        finish = done
      }),
    )
    jest.mocked(ports.checkForUpdates).mockResolvedValue(current)
    install({displayState: "complete"})
    expect(session.snapshot().state).toMatchObject({screen: "finishing", canFinish: false, changelogs: []})
    await jest.advanceTimersByTimeAsync(750)
    expect(ports.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(ports.installSession.detach).not.toHaveBeenCalled()
    finish()
    await jest.advanceTimersByTimeAsync(0)
    expect(ports.installSession.detach).toHaveBeenCalledTimes(1)
    expect(session.snapshot().state.screen).toBe("finishing")
    await jest.advanceTimersByTimeAsync(1100)
    expect(session.snapshot().state).toMatchObject({screen: "up_to_date", completedUpdate: true, canFinish: true})
    expect(session.snapshot().state.changelogs).toHaveLength(1)
    expect(ports.installSession.finish).toHaveBeenCalledTimes(1)
  })

  it("retains approval across a version-information failure and retry", async () => {
    const {session, ports} = make()
    session.chain.beginOtaAutoChain("prior", false, {fromVersion: "3.3.0", toVersion: "3.3.1"})
    jest
      .mocked(ports.checkForUpdates)
      .mockResolvedValue({...current, hasCheckCompleted: false, checkFailureReason: "version_info"})
    await session.open({initializeRuntime: false})
    await jest.advanceTimersByTimeAsync(1100)
    expect(session.snapshot().state.screen).toBe("check_failed")
    expect(session.chain.isOtaAutoChainActive()).toBe(true)
    jest.mocked(ports.checkForUpdates).mockResolvedValue(current)
    session.check()
    await jest.advanceTimersByTimeAsync(1100)
    expect(session.snapshot().state.completedUpdate).toBe(true)
  })

  it("rejects stale check results after disconnect and cannot restart from an observer", async () => {
    const {session, ports, device} = make()
    let resolve!: (value: OtaCheckCurrentGlassesResult) => void
    jest.mocked(ports.checkForUpdates).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    await session.open({initializeRuntime: false})
    device({connected: false, ready: false})
    resolve(offer)
    await jest.advanceTimersByTimeAsync(2000)
    expect(session.snapshot().state.screen).toBe("check_failed")
    expect(ports.installSession.attach).not.toHaveBeenCalled()
  })

  it("delegates retry to the existing coordinator and refuses finish during reboot verification", async () => {
    const {session, ports, install} = make()
    await session.open({initialPage: "progress", initializeRuntime: false})
    session.retryInstall()
    expect(ports.installSession.retry).toHaveBeenCalledTimes(1)
    install({versionChangePhase: "verifying"})
    expect(await session.finish()).toEqual({kind: "none"})
    expect(ports.installSession.finish).not.toHaveBeenCalled()
  })
})
