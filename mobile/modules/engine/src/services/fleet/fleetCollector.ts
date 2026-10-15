/**
 * The Fleet collector: what the engine observes about the phone, its glasses and its miniapps, as Fleet records in
 * the durable queue.
 *
 * It listens to the engine's own state (the glasses store, the running-miniapp registry, the native built-ins
 * executing, the app state) and to `fleetEvents` (launches and photo stages, emitted by lifecycle hooks), never to UI
 * screens. It writes records; the uploader (a separate piece) delivers them. One collector run belongs to one
 * `start()`: its partition and collector-session ID are fixed for its life, and everything it holds is dropped by
 * `stop()`.
 *
 * Usage is measured as sessions: an activity (the engine running, the Mentra App in the foreground, glasses
 * connected, one miniapp executing) opens a session when it begins and closes it when it ends. A session's
 * `elapsedMs` is cumulative monotonic time, and each checkpoint packs every open session, so a session that is
 * cut off simply ends at its last checkpoint. Checkpoints come every 60 s while glasses are connected or the Mentra
 * App is in the foreground, every 15 minutes otherwise (only the engine active, or miniapps executing in the
 * background without glasses, such as Notify), and at once when a session ends. The slower cadence reports the same
 * time, only less often; what it risks is the time since the last checkpoint if the process dies. A session also
 * ends when it reaches the longest time one record may carry (7 days), and a new one carries on from there.
 *
 * Snapshots come at start, after a change worth one (glasses connecting or disconnecting, and while they are connected
 * a battery move of 5 points, a charging change or a new version), and with the first checkpoint 15 minutes or more
 * after the last snapshot, so the two share a wake-up and an upload. On the 15-minute cadence that snapshot is
 * written only if it would say something new. A phone retrying glasses that are away moves between scanning,
 * connecting and disconnected every few seconds, all day: none of that is a change worth a snapshot, or something
 * new. A phone with no glasses connected and the Mentra App in the background so writes about 100 records a day, a
 * checkpoint every 15 minutes, whether or not miniapps execute in the background or its glasses are being retried.
 *
 * Time counts only while the collector was watching. The monotonic clock (React Native's `performance.now()`, the C++
 * steady clock) runs while the device is awake on both platforms, but not the same way through sleep, and the rules
 * below handle both:
 * - On Android it is CLOCK_MONOTONIC, which pauses in deep sleep. A sleep shows as the wall clock running ahead of
 *   it: the sessions end at the monotonic time that was observed, and the jump is a gap.
 * - On iOS libc++'s steady clock reads CLOCK_MONOTONIC_RAW, which keeps counting through sleep. A sleep shows as a
 *   checkpoint overdue by the monotonic clock: nothing ran, so the sessions end at their last checkpoint, and the
 *   span since it is a gap.
 * On either platform, a checkpoint overdue by the monotonic clock means the process was suspended while that clock
 * ran, and a wall-clock jump the monotonic clock did not share is a clock that was changed.
 *
 * Nothing here may break or slow the paths it watches: every entry point catches its own failures, and nothing
 * thrown by the queue, the clock or a store reaches a caller.
 */
import * as Application from "expo-application"
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
import {nativeMiniappExecution} from "../NativeMiniappExecution"
import {fleetEvents, type FleetLaunchEvent, type FleetPhotoEvent} from "./fleetEvents"
import {newId, phoneDeviceId} from "./fleetIds"
import type {FleetQueue} from "./fleetQueue"
import {glassesBinding, glassesPeripheral, isSimulatedGlasses} from "./glassesIdentity"

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
/**
 * How far the wall clock may part from the monotonic clock between checkpoints, and how late a checkpoint may be,
 * before the collector stops believing the span between two checkpoints.
 */
const CLOCK_DRIFT_LIMIT_MS = 2 * 60_000
const BATTERY_SNAPSHOT_STEP = 5
const MAX_TEXT = 128
/** A session cannot outlast several caps between two checkpoints; this only bounds a loop. */
const MAX_CAP_TURNS = 8
const FLEET_ID = /^[A-Za-z0-9._:-]+$/

/**
 * Glasses models that have no battery reporting. Their battery is `unsupported`, not `unknown`, and a record made
 * while they are connected does not claim `glasses_battery`. Every model the Bluetooth SDK connects today reports one
 * (G1, G2, Mentra Live, Mentra Display, Mach1, Z100, NIMO and AR99 all set the glasses' `batteryLevel`), so the list
 * is empty; a model that comes without one is named here, as `deviceModel` names it.
 */
const MODELS_WITHOUT_BATTERY: ReadonlySet<string> = new Set<string>()

/**
 * What the phone measures without glasses. With glasses connected it measures all of them, less the battery of glasses
 * that cannot report one.
 */
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

/** Glasses are connected, and they are not the simulated ones, which are no part of any fleet. */
function realGlassesConnected(): boolean {
  const s = useGlassesStore.getState()
  return s.connection.state === "connected" && !isSimulatedGlasses(s.deviceModel)
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
    // The native application's own version and build number: expo-constants no longer has them.
    appVersion: text(Application.nativeApplicationVersion ?? Constants.expoConfig?.version) ?? "unknown",
    appBuild: text(Application.nativeBuildVersion) ?? "unknown",
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
  /** What told this pair from another of its model (see `glassesPeripheral`), or null if it showed nothing. */
  peripheral: string | null
  binding: FleetDeviceBinding
  firmware: Firmware
}

/** The battery of the pair `known` describes: it goes when a new connection starts or another pair is identified. */
interface BatteryReading {
  level: number
  charging: boolean
  /** When the collector saw this value. It is not refreshed by later snapshots or uploads. */
  observedAt: number
}

/** What the last snapshot said, so a change worth a new snapshot can be told from one that is not. */
interface SnapshotMarks {
  known: boolean
  /** The glasses were connected. The states short of it (scanning, connecting, disconnected) are all "not". */
  linked: boolean
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
  modelsWithoutBattery: ReadonlySet<string>
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
  private snapshotDebounce: number | null = null
  /** When the last snapshot was written (monotonic), and what it said, so a repeat of it can be skipped. */
  private lastSnapshotMono = 0
  private lastSnapshotKey: string | null = null

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
      nativeMiniappExecution.subscribe(() => this.guard("miniapp change", () => this.onStateChange())),
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
    this.checkpointTimer = this.snapshotDebounce = null
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

  /** Notes what the glasses store says now: the connection, the glasses' identity and versions, and the battery. */
  private trackGlasses(wall: number): void {
    const s = useGlassesStore.getState()
    const state = mapConnection(s.connection.state)
    if (state !== this.connection.state) {
      // Glasses that start connecting are not assumed to be the pair that was last here: a new connection is
      // identified afresh, from what the glasses say, before anything is attributed to a device. Only a new
      // connection forgets: while one is tearing down the native layer clears the identity (model first) before it
      // reports disconnected, and the departing pair is still the pair its last records are about.
      if (this.connection.state === "disconnected") this.forgetGlasses()
      this.connection = {state, observedAt: wall}
    }
    // The pair first: a battery reading belongs to the pair it was seen on, and another pair starts without one.
    this.rememberGlasses(s)
    const simulated = isSimulatedGlasses(s.deviceModel)
    if (this.batteryUnsupported()) {
      // Glasses that cannot report a battery have no reading: a level in the store is not theirs.
      this.battery = null
    } else if (
      // A battery value in the store is only believed while real glasses are connected; afterwards the last reading
      // keeps the time it was seen.
      s.connection.state === "connected" &&
      !simulated &&
      (!this.battery || this.battery.level !== s.batteryLevel || this.battery.charging !== s.charging)
    ) {
      this.battery = {level: s.batteryLevel, charging: s.charging, observedAt: wall}
    }
  }

  /** Nothing seen of the glasses so far is about the pair that comes next: not its identity, versions or battery. */
  private forgetGlasses(): void {
    this.known = null
    this.battery = null
  }

  private rememberGlasses(s: GlassesState): void {
    const model = text(s.deviceModel)
    if (!model) return
    const binding = glassesBinding(s, this.phoneId)
    if (!binding) {
      // The store names glasses that are no device (the simulated ones): the pair remembered before is not them.
      this.forgetGlasses()
      return
    }
    const peripheral = glassesPeripheral(s)
    // What was learned about the pair before this carries over only if it is the same pair: the same address or
    // name, or the same serial. A second pair of the same model starts from nothing.
    const before = this.known
    const samePair =
      before !== null &&
      before.model === model &&
      ((peripheral !== null && peripheral === before.peripheral) ||
        (binding.kind === "serial" && before.binding.kind === "serial" && before.binding.serial === binding.serial))
    // Another pair, swapped in with no disconnect between: the last reading was the other pair's battery.
    if (before !== null && !samePair) this.battery = null
    // A serial seen once for this pair is not given up for a provisional stand-in.
    const kept =
      samePair && before.binding.kind === "serial" && binding.kind === "provisional" ? before.binding : binding
    this.known = {
      model,
      peripheral: peripheral ?? (samePair ? before.peripheral : null),
      binding: kept,
      firmware: samePair ? {...before.firmware, ...firmwareOf(s)} : firmwareOf(s),
    }
  }

  /** The pair known here is a model without battery reporting. */
  private batteryUnsupported(): boolean {
    return this.known !== null && this.env.modelsWithoutBattery.has(this.known.model)
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
    if (realGlassesConnected()) wanted.set("glasses_connection", {activity: "glasses_connection"})
    // Local miniapps execute while their JS context runs; native built-ins as the apps store derives it.
    for (const name of [...miniappRunningRegistry.getAll(), ...nativeMiniappExecution.getAll()]) {
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

  /** 60-second checkpoints while glasses are connected or the Mentra App is in the foreground; 15 minutes otherwise. */
  private isFast(): boolean {
    for (const session of this.sessions.values()) {
      if (session.activity === "glasses_connection" || session.activity === "app_foreground") return true
    }
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
      this.guard("snapshot", () => this.periodicSnapshot())
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

  /**
   * Reports every open session, those in `ending` as ended and removed. Writes at once and sets the next checkpoint.
   * A session that has run for the longest time one record may carry ends there, and a new one carries on.
   */
  private writeCheckpoint(ending: ReadonlySet<string>): void {
    const wall = this.env.now()
    const mono = this.env.monotonic()
    const entries: UsageSession[] = []
    for (const open of [...this.sessions.values()]) {
      let session = open
      for (
        let turn = 0;
        turn < MAX_CAP_TURNS && mono - session.startedMono >= FLEET_LIMITS.maxSessionElapsedMs;
        turn += 1
      ) {
        const capped = this.entryFor(session, mono, wall, true)
        if (capped) entries.push(capped)
        session = this.successorOf(session)
        this.sessions.set(session.key, session)
      }
      const entry = this.entryFor(session, mono, wall, ending.has(session.key))
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

  /** The session that carries on from one that reached the cap: the same activity, from the cap on. */
  private successorOf(session: Session): Session {
    const cap = FLEET_LIMITS.maxSessionElapsedMs
    return {
      ...session,
      id: newId(),
      startedWall: session.startedWall + cap,
      startedMono: session.startedMono + cap,
      reportedElapsedMs: null,
    }
  }

  /**
   * The session as a checkpoint entry, `ended` or not, or null if it cannot be reported yet (glasses not identified).
   * Its time is what the monotonic clock measured, never less than it already reported, never more than the wall
   * clock had given it by `wallLimit`, and never more than a session may report.
   */
  private entryFor(session: Session, mono: number, wallLimit: number, ended: boolean): UsageSession | null {
    let binding: FleetDeviceBinding | undefined
    if (session.activity === "glasses_connection") {
      // Fixed at the first report, so a serial that arrives later never splits a connection into two devices.
      binding = session.binding ??= this.currentBinding() ?? undefined
      if (!binding) return null
    }
    const floor = session.reportedElapsedMs ?? 0
    let elapsedMs = Math.floor(mono - session.startedMono)
    if (!Number.isFinite(elapsedMs)) elapsedMs = floor
    const wallSinceStart = Math.floor(wallLimit - session.startedWall)
    if (Number.isFinite(wallSinceStart)) elapsedMs = Math.min(elapsedMs, Math.max(wallSinceStart, 0))
    elapsedMs = Math.min(Math.max(elapsedMs, floor), FLEET_LIMITS.maxSessionElapsedMs)
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
   * Whether the span since the last checkpoint can be believed, and what to do if it cannot. Returns true if it
   * handled a break (the sessions have then been closed and started again).
   *
   * The monotonic clock runs while the device is awake; through sleep it pauses on Android and keeps counting on iOS
   * (see the file header). A timer that was due by it and did not fire means the process was not running. Two things
   * can be wrong with the span:
   * - The checkpoint is overdue by the monotonic clock: nothing here was running while that clock ran (the process
   *   was suspended, or on iOS the device also slept). None of it was observed, so the sessions end at their last
   *   checkpoint.
   * - The wall clock parted from the monotonic clock: the device slept with a clock that pauses in sleep (Android),
   *   or somebody changed the clock. The monotonic time was observed and counts, so the sessions end at it; only the
   *   jump itself is a gap.
   * The first wins: a reporter that was not running observed nothing, whatever the wall clock did.
   */
  private checkClock(): boolean {
    const wall = this.env.now()
    const mono = this.env.monotonic()
    if (this.checkpointTimer !== null && mono - this.checkpointDueMono > CLOCK_DRIFT_LIMIT_MS) {
      this.closeAtLastCheckpoint(wall, mono)
      return true
    }
    const monoDelta = mono - this.anchorMono
    const drift = wall - this.anchorWall - monoDelta
    if (Math.abs(drift) > CLOCK_DRIFT_LIMIT_MS) {
      this.closeAtObservedTime(wall, mono, monoDelta, drift)
      return true
    }
    return false
  }

  /** The reporter was silent: only what it had reported before counts, and everything since is a gap. */
  private closeAtLastCheckpoint(wall: number, mono: number): void {
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
    this.emitGap("reporter_stopped", from, Math.max(wall, from), wall)
    this.startAgain(wall, mono)
  }

  /** The wall clock jumped: the awake time counts, ending where the monotonic clock says it did, and the jump is the gap. */
  private closeAtObservedTime(wall: number, mono: number, monoDelta: number, drift: number): void {
    // Where the observation ended on the timeline the last checkpoint was written on.
    const observedUntil = this.anchorWall + Math.max(monoDelta, 0)
    const closed: UsageSession[] = []
    for (const session of this.sessions.values()) {
      const entry = this.entryFor(session, mono, observedUntil, true)
      if (entry) closed.push(entry)
    }
    this.sessions.clear()
    this.emitCheckpoints(closed, observedUntil)
    // Sleep shows as the wall clock running ahead while the app was away; anything else is the clock being changed.
    const reason: GapReason = drift > 0 && this.leftForeground ? "reporter_stopped" : "clock_untrusted"
    this.emitGap(reason, Math.min(observedUntil, wall), Math.max(observedUntil, wall), wall)
    this.startAgain(wall, mono)
  }

  private emitGap(reason: GapReason, from: number, to: number, observedAt: number): void {
    this.emit(observedAt, (base) => ({
      ...base,
      kind: "coverage_gap",
      payload: {reason, from: iso(from), to: iso(to)},
    }))
  }

  /** After a break: the clocks are re-anchored, and the activities still going on start again as new sessions. */
  private startAgain(wall: number, mono: number): void {
    this.anchorWall = wall
    this.anchorMono = mono
    this.leftForeground = !isForeground()
    this.openMissing()
    this.arm(this.cadence())
    this.scheduleSnapshot()
  }

  // --- snapshots -----------------------------------------------------------------------------------------------

  private batteryPayload(wall: number): BatteryPayload {
    if (this.batteryUnsupported()) return {state: "unsupported", observedAt: iso(wall)}
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
      linked: this.connection.state === "connected",
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

  /**
   * The 15-minute snapshot. It has no timer of its own: it is written with the checkpoint that falls due 15 minutes or
   * more after the last snapshot, so the two share a wake-up and an upload. On the 15-minute cadence it is written
   * only if it would say something the last snapshot did not.
   */
  private periodicSnapshot(): void {
    if (this.env.monotonic() - this.lastSnapshotMono < SNAPSHOT_INTERVAL_MS) return
    this.takeSnapshot(!this.isFast())
  }

  /**
   * Glasses connecting or disconnecting is worth a snapshot; while they are connected, so are their identification, a
   * battery move of 5 points or a charging change, and a new version.
   *
   * Moves among the states short of connected are not: a phone retrying glasses that are away goes scanning,
   * connecting and disconnected every few seconds, all day, and forgets and finds the glasses' identity with each
   * attempt. Their battery and versions are only read while they are connected.
   *
   * A disconnect is written at once, while what is known is still the pair that left: the retry that follows within
   * moments starts a new connection, which forgets them. Only a snapshot in the last two seconds holds it back to the
   * usual debounce, so a link that flaps is still one snapshot every two seconds at most.
   */
  private evaluateSnapshotTriggers(): void {
    const last = this.marks
    if (!last) return
    const now = this.currentMarks()
    if (now.linked !== last.linked) {
      const disconnected = !now.linked
      if (disconnected && this.env.monotonic() - this.lastSnapshotMono >= SNAPSHOT_DEBOUNCE_MS) this.takeSnapshot()
      else this.scheduleSnapshot()
      return
    }
    if (!now.linked) return
    const changed =
      now.known !== last.known ||
      (now.known &&
        (now.batteryMeasured !== last.batteryMeasured ||
          (now.batteryMeasured &&
            (Math.abs(now.level - last.level) >= BATTERY_SNAPSHOT_STEP || now.charging !== last.charging)) ||
          (now.versions !== "" && now.versions !== last.versions)))
    if (changed) this.scheduleSnapshot()
  }

  /** Writes a snapshot; with `onlyIfNew`, only if it would say something the last one did not. */
  private takeSnapshot(onlyIfNew = false): void {
    const phone = phoneInfo()
    if (!phone) {
      if (this.snapshotDebounce !== null) BgTimer.clearTimeout(this.snapshotDebounce)
      this.snapshotDebounce = null
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
    // What the snapshot says, leaving out the time a battery with no reading is stamped with (it is now): an unknown
    // one, or one the glasses cannot report. Of glasses that are not connected only that is new: retrying them changes
    // the state short of connected, its time, and what is known of them, with every attempt.
    const key = JSON.stringify([
      phone,
      this.connection.state !== "connected"
        ? "not connected"
        : [
            binding && glasses ? binding : null,
            glasses && !this.battery ? {...glasses, battery: {state: glasses.battery?.state}} : glasses,
          ],
    ])
    if (onlyIfNew && key === this.lastSnapshotKey) return
    if (this.snapshotDebounce !== null) BgTimer.clearTimeout(this.snapshotDebounce)
    this.snapshotDebounce = null
    this.emit(wall, (base) => ({
      ...base,
      kind: "snapshot",
      ...(glasses && binding ? {deviceBinding: binding} : {}),
      payload: {phone, ...(glasses ? {glasses} : {})},
    }))
    this.marks = this.currentMarks()
    this.lastSnapshotMono = this.env.monotonic()
    this.lastSnapshotKey = key
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
    if (!realGlassesConnected()) return [...PHONE_CAPABILITIES]
    // Glasses that cannot report a battery leave nothing to measure about it.
    if (this.batteryUnsupported()) return FLEET_CAPABILITIES.filter((capability) => capability !== "glasses_battery")
    return [...FLEET_CAPABILITIES]
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
 * The collector over `deps.queue`, which must be the app's shared queue (`createFleetQueue()`); the clocks and the
 * models without battery reporting are injectable for tests. It collects nothing until `start`.
 */
export function createFleetCollector(deps: {
  queue: FleetQueue
  now?: () => number
  monotonic?: () => number
  modelsWithoutBattery?: ReadonlySet<string>
}): FleetCollector {
  const env: Env = {
    queue: deps.queue,
    now: deps.now ?? Date.now,
    monotonic: deps.monotonic ?? (() => performance.now()),
    modelsWithoutBattery: deps.modelsWithoutBattery ?? MODELS_WITHOUT_BATTERY,
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
