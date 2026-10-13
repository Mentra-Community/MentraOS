/**
 * The Fleet collector: what the engine observes about the phone, its glasses and its miniapps, as Fleet records in
 * the durable queue.
 *
 * It listens to the engine's own state (the glasses store, the running-miniapp registry, the app state) and to
 * `fleetEvents` (launches and photo stages, emitted by lifecycle hooks), never to UI screens. It writes records;
 * the uploader (a separate piece) delivers them. One collector run belongs to one `start()`: its partition and
 * collector-session ID are fixed for its life, and everything it holds is dropped by `stop()`.
 *
 * Usage is measured as sessions: an activity (the engine running, the Mentra App in the foreground, glasses
 * connected, one miniapp executing) opens a session when it begins and closes it when it ends. A session's
 * `elapsedMs` is cumulative monotonic time, and each checkpoint packs every open session, so a session that is
 * cut off simply ends at its last checkpoint. Checkpoints come every 60 s while glasses are connected, a miniapp
 * is executing or the Mentra App is in the foreground, every 15 minutes when only the engine is active, and at
 * once when a session ends.
 *
 * Nothing here may break or slow the paths it watches: every entry point catches its own failures, and nothing
 * thrown by the queue, the clock or a store reaches a caller.
 */
import Constants from "expo-constants"
import * as Device from "expo-device"
import {AppState, Platform} from "react-native"
import {
  FLEET_CAPABILITIES,
  FLEET_LIMITS,
  FLEET_SCHEMA_VERSION,
  type FleetActivity,
  type FleetDeviceBinding,
  type FleetRecord,
} from "@mentra/cloud-protocol"

import {useGlassesStore} from "../../stores/glasses"
import {BgTimer} from "../../utils/timers"
import {miniappRunningRegistry} from "../MiniappRunningRegistry"
import {fleetEvents, type FleetLaunchEvent, type FleetPhotoEvent} from "./fleetEvents"
import {newId, phoneDeviceId} from "./fleetIds"
import type {FleetQueue} from "./fleetQueue"
import {glassesBinding} from "./glassesIdentity"

export interface FleetCollector {
  /** Opens the engine session, the foreground session if the app is active, the glasses and running miniapps, and takes a snapshot. */
  start(ctx: {partition: string; collectorSessionId: string}): void
  /** Checkpoints every open session as ended, into the partition `start` was given, and stops listening. */
  stop(reason: "engine_stopped" | "account_changed" | "not_installed"): void
  /** Writes one packed `usage_checkpoint` for every open session. */
  flushCheckpoint(): void
}

type Capability = (typeof FLEET_CAPABILITIES)[number]
type UsageSession = Extract<FleetRecord, {kind: "usage_checkpoint"}>["payload"]["sessions"][number]
type SnapshotPayload = Extract<FleetRecord, {kind: "snapshot"}>["payload"]
type GlassesPayload = NonNullable<SnapshotPayload["glasses"]>
type ConnectionState = GlassesPayload["connection"]["state"]
type BatteryPayload = NonNullable<GlassesPayload["battery"]>
type Firmware = NonNullable<GlassesPayload["firmware"]>
type GapReason = "clock_untrusted" | "reporter_stopped"

interface RecordBase {
  schemaVersion: typeof FLEET_SCHEMA_VERSION
  recordId: string
  phoneDeviceId: string
  collectorSessionId: string
  sequence: number
  observedAt: string
  capabilities: Capability[]
}

const FAST_CHECKPOINT_MS = 60_000
const IDLE_CHECKPOINT_MS = 15 * 60_000
const SNAPSHOT_INTERVAL_MS = 15 * 60_000
/** State changes this close together are one snapshot. */
const SNAPSHOT_DEBOUNCE_MS = 2_000
/** Wall clock and monotonic clock may differ by this much between checkpoints before neither is believed. */
const CLOCK_DRIFT_LIMIT_MS = 2 * 60_000
const BATTERY_SNAPSHOT_STEP = 5
const MAX_TEXT = 128
const FLEET_ID = /^[A-Za-z0-9._:-]+$/

/** What the phone measures without glasses. With glasses connected it measures all of them. */
const PHONE_CAPABILITIES: Capability[] = [
  "glasses_connection",
  "miniapp_execution",
  "app_foreground",
  "engine_active",
  "photo_operations",
]

function warn(what: string, error: unknown): void {
  // Only the failure's message: an error from here must never carry a package, a serial or a record into the logs.
  console.warn(`FleetCollector: ${what} failed:`, error instanceof Error ? error.message : "unknown error")
}

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().slice(0, MAX_TEXT)
  return trimmed ? trimmed : undefined
}

function iso(wall: number): string {
  return new Date(wall).toISOString()
}

function isForeground(): boolean {
  return AppState.currentState === "active"
}

function mapConnection(state: string): ConnectionState {
  if (state === "connected") return "connected"
  if (state === "disconnected") return "disconnected"
  if (state === "scanning" || state === "connecting" || state === "bonding") return "connecting"
  return "unknown"
}

let packageVersionCache: {engine?: string; sdk?: string} | undefined
function packageVersions(): {engine?: string; sdk?: string} {
  if (packageVersionCache) return packageVersionCache
  const versions: {engine?: string; sdk?: string} = {}
  try {
    versions.engine = text((require("../../../package.json") as {version?: string}).version)
  } catch {
    // Left out of the snapshot.
  }
  try {
    versions.sdk = text((require("@mentra/bluetooth-sdk/package.json") as {version?: string}).version)
  } catch {
    // Left out of the snapshot.
  }
  return (packageVersionCache = versions)
}

/** The phone's part of a snapshot, or null where the contract has no value for this platform. */
function phoneInfo(): SnapshotPayload["phone"] | null {
  const os = Platform.OS
  if (os !== "ios" && os !== "android") return null
  const constants = Constants as typeof Constants & {
    nativeAppVersion?: string | null
    nativeBuildVersion?: string | null
  }
  const osVersion =
    os === "android"
      ? String((Platform.constants as {Release?: string} | undefined)?.Release ?? Platform.Version)
      : String(Platform.Version)
  const model = text(Device.modelName)
  const {engine, sdk} = packageVersions()
  return {
    ...(model ? {model} : {}),
    os,
    osVersion: text(osVersion) ?? "unknown",
    appVersion: text(constants.nativeAppVersion ?? Constants.expoConfig?.version) ?? "unknown",
    appBuild: text(constants.nativeBuildVersion) ?? "unknown",
    ...(engine ? {engineVersion: engine} : {}),
    ...(sdk ? {sdkVersion: sdk} : {}),
  }
}

type GlassesState = ReturnType<typeof useGlassesStore.getState>

/** The glasses fields the collector reacts to, as one string so the store only calls back when one of them changes. */
function glassesFingerprint(s: GlassesState): string {
  // The store runs this on every update, inside the update: it must not throw into whoever is updating the store.
  try {
    return [
      s.connection.state,
      s.connection.state === "connected" && s.connection.fullyBooted ? "1" : "0",
      s.deviceModel,
      s.serialNumber,
      s.bluetoothMacAddress,
      s.leftMacAddress,
      s.bluetoothName,
      s.appVersion,
      s.buildNumber,
      s.mtkFirmwareVersion,
      s.besFirmwareVersion,
      s.androidVersion,
      s.firmwareVersion,
      s.batteryLevel,
      s.charging ? "1" : "0",
    ].join("\u0001")
  } catch {
    return ""
  }
}

/** The glasses' versions that are known (blank ones are left out). The APK version carries its build number. */
function firmwareOf(s: GlassesState): Firmware {
  const apkVersion = text(s.appVersion)
  const apkBuild = text(s.buildNumber)
  const apk = apkVersion && apkBuild ? `${apkVersion} (${apkBuild})` : apkVersion || apkBuild
  const mtk = text(s.mtkFirmwareVersion)
  const bes = text(s.besFirmwareVersion)
  const os = text(s.androidVersion) ?? text(s.firmwareVersion)
  return {
    ...(apk ? {apk: apk.slice(0, MAX_TEXT)} : {}),
    ...(mtk ? {mtk} : {}),
    ...(bes ? {bes} : {}),
    ...(os ? {os} : {}),
  }
}

/**
 * The glasses as last seen in this run. The native layer clears a pair's identity when it disconnects, so the
 * collector keeps what it saw while the glasses were there: a disconnected pair is still described, and still the
 * same device.
 */
interface KnownGlasses {
  model: string
  binding: FleetDeviceBinding
  firmware: Firmware
}

interface BatteryReading {
  level: number
  charging: boolean
  /** When the collector saw this value. It is not refreshed by later snapshots or uploads. */
  observedAt: number
}

/** What the last snapshot said, so a change worth a new snapshot can be told from one that is not. */
interface SnapshotMarks {
  known: boolean
  connection: ConnectionState
  batteryMeasured: boolean
  level: number
  charging: boolean
  versions: string
}

interface Session {
  key: string
  activity: FleetActivity
  id: string
  packageName?: string
  /** Glasses sessions: fixed when the session is first reported, and never changed after. */
  binding?: FleetDeviceBinding
  startedWall: number
  startedMono: number
  /** The elapsed time at the last checkpoint that carried this session; null until it has been reported. */
  reportedElapsedMs: number | null
}

interface SessionSpec {
  activity: FleetActivity
  packageName?: string
}

interface Env {
  queue: FleetQueue
  now: () => number
  monotonic: () => number
}

const NONE: ReadonlySet<string> = new Set()

/** One collector run: everything a `start()` opens, and everything `stop()` closes. */
class CollectorRun {
  private readonly sessions = new Map<string, Session>()
  private readonly cleanups: Array<() => void> = []
  private stopped = false
  private phoneId = ""

  /** The wall and monotonic clocks at the last checkpoint; the clocks are compared across this span. */
  private anchorWall = 0
  private anchorMono = 0
  /** The Mentra App left the foreground since the anchor: a silent gap then looks like suspension. */
  private leftForeground = false

  private checkpointTimer: number | null = null
  private checkpointDueMono = 0
  private snapshotInterval: number | null = null
  private snapshotDebounce: number | null = null

  private known: KnownGlasses | null = null
  private battery: BatteryReading | null = null
  private connection: {state: ConnectionState; observedAt: number} = {state: "disconnected", observedAt: 0}
  private marks: SnapshotMarks | null = null

  constructor(
    private readonly env: Env,
    private readonly partition: string,
    private readonly collectorSessionId: string,
  ) {}

  // --- lifecycle -----------------------------------------------------------------------------------------------

  begin(): void {
    this.phoneId = phoneDeviceId()
    const wall = this.env.now()
    this.anchorWall = wall
    this.anchorMono = this.env.monotonic()
    this.leftForeground = !isForeground()
    this.connection = {state: mapConnection(useGlassesStore.getState().connection.state), observedAt: wall}
    this.trackGlasses(wall)
    this.openMissing()

    this.cleanups.push(
      useGlassesStore.subscribe(glassesFingerprint, () => this.guard("glasses change", () => this.onStateChange())),
      miniappRunningRegistry.subscribe(() => this.guard("miniapp change", () => this.onStateChange())),
      fleetEvents.subscribe({
        launch: (event) => this.guard("launch", () => this.onLaunch(event)),
        photo: (event) => this.guard("photo", () => this.onPhoto(event)),
      }),
    )
    const appState = AppState.addEventListener("change", (state) =>
      this.guard("app state", () => {
        if (state !== "active") this.leftForeground = true
        this.onStateChange()
      }),
    )
    this.cleanups.push(() => appState.remove())

    this.takeSnapshot()
    this.arm(this.cadence())
    this.snapshotInterval = BgTimer.setInterval(
      () => this.guard("snapshot", () => this.takeSnapshot()),
      SNAPSHOT_INTERVAL_MS,
    )
  }

  /** Ends every session in the partition, then stops listening. */
  end(): void {
    if (this.stopped) return
    try {
      if (this.checkClock()) {
        // Whatever the jump left open was just reopened and has nothing confirmed to close.
        this.sessions.clear()
      } else {
        this.writeCheckpoint(new Set(this.sessions.keys()))
      }
    } catch (error) {
      warn("final checkpoint", error)
    }
    this.abort()
  }

  /** Stops listening and drops the timers, without writing anything. */
  abort(): void {
    this.stopped = true
    if (this.checkpointTimer !== null) BgTimer.clearTimeout(this.checkpointTimer)
    if (this.snapshotDebounce !== null) BgTimer.clearTimeout(this.snapshotDebounce)
    if (this.snapshotInterval !== null) BgTimer.clearInterval(this.snapshotInterval)
    this.checkpointTimer = this.snapshotDebounce = this.snapshotInterval = null
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup()
      } catch (error) {
        warn("cleanup", error)
      }
    }
  }

  flush(): void {
    this.guard("checkpoint", () => {
      if (!this.checkClock()) this.writeCheckpoint(NONE)
    })
  }

  private guard(what: string, run: () => void): void {
    if (this.stopped) return
    try {
      run()
    } catch (error) {
      warn(what, error)
    }
  }

  // --- reacting to the engine ----------------------------------------------------------------------------------

  private onStateChange(): void {
    this.trackGlasses(this.env.now())
    if (!this.checkClock()) this.reconcileSessions()
    this.evaluateSnapshotTriggers()
  }

  /** Notes what the glasses store says now: the connection, the battery, and the glasses' identity and versions. */
  private trackGlasses(wall: number): void {
    const s = useGlassesStore.getState()
    const state = mapConnection(s.connection.state)
    if (state !== this.connection.state) this.connection = {state, observedAt: wall}
    // A battery value in the store is only believed while the glasses are connected; afterwards the last reading
    // keeps the time it was seen.
    if (
      s.connection.state === "connected" &&
      (!this.battery || this.battery.level !== s.batteryLevel || this.battery.charging !== s.charging)
    ) {
      this.battery = {level: s.batteryLevel, charging: s.charging, observedAt: wall}
    }
    this.rememberGlasses(s)
  }

  private rememberGlasses(s: GlassesState): void {
    const model = text(s.deviceModel)
    if (!model) return
    const binding = glassesBinding(s, this.phoneId)
    if (!binding) return
    const previous = this.known?.model === model ? this.known : null
    // A serial seen once is not given up for a provisional stand-in.
    const kept = previous?.binding.kind === "serial" && binding.kind === "provisional" ? previous.binding : binding
    this.known = {model, binding: kept, firmware: {...previous?.firmware, ...firmwareOf(s)}}
  }

  private currentBinding(): FleetDeviceBinding | null {
    this.rememberGlasses(useGlassesStore.getState())
    return this.known?.binding ?? null
  }

  // --- sessions ------------------------------------------------------------------------------------------------

  private desiredSessions(): Map<string, SessionSpec> {
    const wanted = new Map<string, SessionSpec>()
    wanted.set("engine_active", {activity: "engine_active"})
    if (isForeground()) wanted.set("app_foreground", {activity: "app_foreground"})
    if (useGlassesStore.getState().connection.state === "connected") {
      wanted.set("glasses_connection", {activity: "glasses_connection"})
    }
    for (const name of miniappRunningRegistry.getAll()) {
      const packageName = text(name)
      if (packageName) wanted.set(`miniapp_execution:${packageName}`, {activity: "miniapp_execution", packageName})
    }
    return wanted
  }

  private open(key: string, spec: SessionSpec): void {
    this.sessions.set(key, {
      key,
      activity: spec.activity,
      id: newId(),
      ...(spec.packageName ? {packageName: spec.packageName} : {}),
      startedWall: this.env.now(),
      startedMono: this.env.monotonic(),
      reportedElapsedMs: null,
    })
  }

  private openMissing(): void {
    for (const [key, spec] of this.desiredSessions()) if (!this.sessions.has(key)) this.open(key, spec)
  }

  /** Makes the open sessions match what is happening now: ends the ones that stopped (checkpointing at once), opens new ones. */
  private reconcileSessions(): void {
    const wanted = this.desiredSessions()
    const ending = new Set<string>()
    for (const key of this.sessions.keys()) if (!wanted.has(key)) ending.add(key)
    // Close first: a session opened in the same breath is not reported until a checkpoint after its identity settles.
    if (ending.size > 0) this.writeCheckpoint(ending)
    for (const [key, spec] of wanted) if (!this.sessions.has(key)) this.open(key, spec)
    this.ensureCadence()
  }

  private isFast(): boolean {
    for (const session of this.sessions.values()) if (session.activity !== "engine_active") return true
    return false
  }

  private cadence(): number {
    return this.isFast() ? FAST_CHECKPOINT_MS : IDLE_CHECKPOINT_MS
  }

  /** The next checkpoint is `delay` from now, replacing any that is pending. */
  private arm(delay: number): void {
    if (this.checkpointTimer !== null) BgTimer.clearTimeout(this.checkpointTimer)
    this.checkpointDueMono = this.env.monotonic() + delay
    const timer: number = BgTimer.setTimeout(() => this.onCheckpointTimer(timer), delay)
    this.checkpointTimer = timer
  }

  private onCheckpointTimer(fired: number): void {
    if (this.stopped || this.checkpointTimer !== fired) return
    try {
      this.flush()
    } finally {
      // A checkpoint that failed part-way must not end the cadence.
      if (!this.stopped && this.checkpointTimer === fired) this.arm(this.cadence())
    }
  }

  /** Activity that needs a 60 s checkpoint brings the next one forward; a 15-minute wait does not outlast it. */
  private ensureCadence(): void {
    if (this.checkpointTimer === null) {
      this.arm(this.cadence())
    } else if (this.isFast() && this.checkpointDueMono - this.env.monotonic() > FAST_CHECKPOINT_MS) {
      this.arm(FAST_CHECKPOINT_MS)
    }
  }

  // --- checkpoints ---------------------------------------------------------------------------------------------

  /** Reports every open session, those in `ending` as ended and removed. Writes at once and sets the next checkpoint. */
  private writeCheckpoint(ending: ReadonlySet<string>): void {
    const wall = this.env.now()
    const mono = this.env.monotonic()
    const entries: UsageSession[] = []
    for (const session of this.sessions.values()) {
      const entry = this.entryFor(session, mono, ending.has(session.key))
      if (entry) entries.push(entry)
    }
    for (const key of ending) this.sessions.delete(key)
    this.anchorWall = wall
    this.anchorMono = mono
    this.leftForeground = !isForeground()
    // A close that closed nothing reportable (a connection that was never identified) is not worth a record.
    if (ending.size === 0 || entries.some((entry) => entry.ended)) this.emitCheckpoints(entries, wall)
    this.arm(this.cadence())
  }

  private entryFor(session: Session, mono: number, ended: boolean): UsageSession | null {
    let binding: FleetDeviceBinding | undefined
    if (session.activity === "glasses_connection") {
      // Fixed at the first report, so a serial that arrives later never splits a connection into two devices.
      binding = session.binding ??= this.currentBinding() ?? undefined
      if (!binding) return null
    }
    const measured = Math.floor(mono - session.startedMono)
    const floor = session.reportedElapsedMs ?? 0
    const elapsedMs = Number.isFinite(measured)
      ? Math.min(Math.max(measured, floor), FLEET_LIMITS.maxSessionElapsedMs)
      : floor
    session.reportedElapsedMs = elapsedMs
    return this.describe(session, elapsedMs, ended, binding)
  }

  private describe(session: Session, elapsedMs: number, ended: boolean, binding?: FleetDeviceBinding): UsageSession {
    return {
      activity: session.activity,
      activitySessionId: session.id,
      ...(session.packageName ? {packageName: session.packageName} : {}),
      ...(binding ? {deviceBinding: binding} : {}),
      startedAt: iso(session.startedWall),
      elapsedMs,
      ended,
    }
  }

  private emitCheckpoints(entries: UsageSession[], observedAt: number): void {
    const size = FLEET_LIMITS.maxSessionsPerCheckpoint
    for (let index = 0; index < entries.length; index += size) {
      const sessions = entries.slice(index, index + size)
      this.emit(observedAt, (base) => ({...base, kind: "usage_checkpoint", payload: {sessions}}))
    }
  }

  // --- clock changes and suspension ----------------------------------------------------------------------------

  /**
   * Whether the clocks or the timers say the collector was not watching for a while. If so, the sessions are closed
   * where they were last confirmed, the unobserved span is recorded as a gap, and the activities still going on
   * start again as new sessions. Returns true if it did.
   */
  private checkClock(): boolean {
    const wall = this.env.now()
    const mono = this.env.monotonic()
    const monoDelta = mono - this.anchorMono
    const drift = wall - this.anchorWall - monoDelta
    let reason: GapReason | null = null
    let to = Math.max(wall, this.anchorWall)
    if (Math.abs(drift) > CLOCK_DRIFT_LIMIT_MS) {
      // The monotonic clock stops while the process sleeps, so a wall clock that ran ahead of it with the app in
      // the background is suspension; any other disagreement is the clock being changed.
      reason = drift > 0 && this.leftForeground ? "reporter_stopped" : "clock_untrusted"
      // A clock set back: the span is what the monotonic clock measured since the last confirmation.
      if (drift < 0) to = this.anchorWall + Math.max(monoDelta, 0)
    } else if (this.checkpointTimer !== null && mono - this.checkpointDueMono > CLOCK_DRIFT_LIMIT_MS) {
      // Both clocks agree, but a checkpoint that was due is minutes late: the process was suspended while awake.
      reason = "reporter_stopped"
    }
    if (!reason) return false

    const from = this.anchorWall
    const closed: UsageSession[] = []
    for (const session of this.sessions.values()) {
      // A session that was never reported has nothing to close.
      if (session.reportedElapsedMs === null) continue
      if (session.activity === "glasses_connection" && !session.binding) continue
      closed.push(this.describe(session, session.reportedElapsedMs, true, session.binding))
    }
    this.sessions.clear()
    this.emitCheckpoints(closed, from)
    const gapReason = reason
    this.emit(wall, (base) => ({
      ...base,
      kind: "coverage_gap",
      payload: {reason: gapReason, from: iso(from), to: iso(to)},
    }))

    this.anchorWall = wall
    this.anchorMono = mono
    this.leftForeground = !isForeground()
    this.openMissing()
    this.arm(this.cadence())
    this.scheduleSnapshot()
    return true
  }

  // --- snapshots -----------------------------------------------------------------------------------------------

  private batteryPayload(wall: number): BatteryPayload {
    const reading = this.battery
    if (!reading || !Number.isFinite(reading.level) || reading.level < 0) {
      return {state: "unknown", observedAt: iso(reading?.observedAt ?? wall)}
    }
    return {
      state: "measured",
      observedAt: iso(reading.observedAt),
      level: Math.min(100, Math.round(reading.level)),
      charging: reading.charging,
    }
  }

  private versionKey(): string {
    const firmware = this.known?.firmware
    return firmware ? [firmware.apk, firmware.mtk, firmware.bes, firmware.os].join("|") : ""
  }

  private currentMarks(): SnapshotMarks {
    const reading = this.battery
    const measured = !!reading && Number.isFinite(reading.level) && reading.level >= 0
    return {
      known: this.known !== null,
      connection: this.connection.state,
      batteryMeasured: measured,
      level: measured ? reading.level : -1,
      charging: measured ? reading.charging : false,
      versions: this.versionKey(),
    }
  }

  /** Asks for a snapshot once the changes around this moment have settled. */
  private scheduleSnapshot(): void {
    if (this.snapshotDebounce !== null) return
    const timer: number = BgTimer.setTimeout(
      () =>
        this.guard("snapshot", () => {
          if (this.snapshotDebounce === timer) this.snapshotDebounce = null
          this.takeSnapshot()
        }),
      SNAPSHOT_DEBOUNCE_MS,
    )
    this.snapshotDebounce = timer
  }

  /** A change in the connection, a battery move of 5 points or a charging change, or a new version, is worth a snapshot. */
  private evaluateSnapshotTriggers(): void {
    const last = this.marks
    if (!last) return
    const now = this.currentMarks()
    let changed = now.known !== last.known
    if (!changed && now.known) {
      changed =
        now.connection !== last.connection ||
        now.batteryMeasured !== last.batteryMeasured ||
        (now.batteryMeasured &&
          (Math.abs(now.level - last.level) >= BATTERY_SNAPSHOT_STEP || now.charging !== last.charging)) ||
        (now.versions !== "" && now.versions !== last.versions)
    }
    if (changed) this.scheduleSnapshot()
  }

  private takeSnapshot(): void {
    if (this.snapshotDebounce !== null) BgTimer.clearTimeout(this.snapshotDebounce)
    this.snapshotDebounce = null
    const phone = phoneInfo()
    if (!phone) {
      console.warn("FleetCollector: no snapshot, this platform has no value in the Fleet contract")
      return
    }
    const wall = this.env.now()
    this.trackGlasses(wall)
    const binding = this.currentBinding()
    const known = this.known
    const glasses: GlassesPayload | null =
      binding && known
        ? {
            model: known.model,
            ...(Object.keys(known.firmware).length > 0 ? {firmware: known.firmware} : {}),
            connection: {state: this.connection.state, observedAt: iso(this.connection.observedAt)},
            battery: this.batteryPayload(wall),
          }
        : null
    this.emit(wall, (base) => ({
      ...base,
      kind: "snapshot",
      ...(glasses && binding ? {deviceBinding: binding} : {}),
      payload: {phone, ...(glasses ? {glasses} : {})},
    }))
    this.marks = this.currentMarks()
  }

  // --- launches and photos -------------------------------------------------------------------------------------

  private onLaunch(event: FleetLaunchEvent): void {
    const packageName = text(event.packageName)
    if (!packageName) return
    if (event.start !== "user" && event.start !== "automatic") return
    if (event.outcome !== "started" && event.outcome !== "failed") return
    const miniappName = text(event.miniappName)
    const versionName = text(event.versionName)
    this.emit(this.env.now(), (base) => ({
      ...base,
      kind: "miniapp_launch",
      payload: {
        packageName,
        ...(miniappName ? {miniappName} : {}),
        ...(versionName ? {versionName} : {}),
        start: event.start,
        outcome: event.outcome,
      },
    }))
  }

  private onPhoto(event: FleetPhotoEvent): void {
    const operationId = event.operationId
    if (typeof operationId !== "string" || operationId.length > MAX_TEXT || !FLEET_ID.test(operationId)) return
    const stage = event.stage
    if (stage !== "requested" && stage !== "captured" && stage !== "delivered" && stage !== "failed") return
    // A photo is always one pair of glasses' photo.
    const binding = this.currentBinding()
    if (!binding) return
    const payload = stage === "failed" ? {stage, failedStage: event.failedStage ?? ("requested" as const)} : {stage}
    this.emit(this.env.now(), (base) => ({
      ...base,
      kind: "photo_operation",
      operationId,
      deviceBinding: binding,
      payload,
    }))
  }

  // --- records -------------------------------------------------------------------------------------------------

  private capabilities(): Capability[] {
    return useGlassesStore.getState().connection.state === "connected"
      ? [...FLEET_CAPABILITIES]
      : [...PHONE_CAPABILITIES]
  }

  private base(observedAt: number): RecordBase {
    return {
      schemaVersion: FLEET_SCHEMA_VERSION,
      recordId: newId(),
      phoneDeviceId: this.phoneId,
      collectorSessionId: this.collectorSessionId,
      sequence: this.env.queue.nextSequence(this.partition, this.collectorSessionId),
      observedAt: iso(observedAt),
      capabilities: this.capabilities(),
    }
  }

  /** Builds a record and queues it in this run's partition. A record that cannot be built or stored is skipped. */
  private emit(observedAt: number, make: (base: RecordBase) => FleetRecord): void {
    try {
      this.env.queue.enqueue(this.partition, make(this.base(observedAt)))
    } catch (error) {
      warn("recording", error)
    }
  }
}

/**
 * The collector over `deps.queue`, which must be the app's shared queue (`createFleetQueue()`); the clocks are
 * injectable for tests. It collects nothing until `start`.
 */
export function createFleetCollector(deps: {
  queue: FleetQueue
  now?: () => number
  monotonic?: () => number
}): FleetCollector {
  const env: Env = {
    queue: deps.queue,
    now: deps.now ?? Date.now,
    monotonic: deps.monotonic ?? (() => performance.now()),
  }
  let current: CollectorRun | null = null

  return {
    start(ctx) {
      try {
        const previous = current
        current = null
        previous?.end()
        const run = new CollectorRun(env, ctx.partition, ctx.collectorSessionId)
        current = run
        try {
          run.begin()
        } catch (error) {
          run.abort()
          if (current === run) current = null
          throw error
        }
      } catch (error) {
        warn("start", error)
      }
    },

    // The reason is the caller's record of why; the collector closes its sessions the same way for each.
    stop(_reason) {
      const run = current
      current = null
      if (!run) return
      try {
        run.end()
      } catch (error) {
        warn("stop", error)
      }
    },

    flushCheckpoint() {
      try {
        current?.flush()
      } catch (error) {
        warn("flush", error)
      }
    },
  }
}
