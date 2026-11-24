import BluetoothSdk, {isEnabledHotspotStatus, type HotspotStatus} from "@mentra/bluetooth-sdk"

import {useGlassesStore} from "../stores/glasses"
import {BgTimer} from "../utils/timers"
import {isGlassesConnected, isGlassesReady} from "./GlassesReadiness"
import {localNetworkTransport} from "./asg/localNetworkTransport"

/**
 * The glasses Wi-Fi service: the one owner of the phone-to-glasses Wi-Fi link.
 *
 * Gallery sync, hotspot OTA, Mentra Call and the managed relay hold the link here and use the
 * binding it gives them; none of them sends a hotspot command or joins a network itself. The link
 * is shared: the first holder brings it up (the glasses' hotspot, then the phone's one native
 * join), later holders get the same binding, and the last release takes it down.
 *
 * When the link goes down (the phone leaves the network, the glasses turn the AP off, restart, or
 * leave Bluetooth), holders hear `lost`; the service asks for the link again once the glasses are
 * back and ready, and holders hear `restored` with the new binding. Glasses that do not come back
 * within [RESTORE_DEADLINE_MS] end it: holders hear `ended` and still release.
 */

export type GlassesWifiBinding = {
  ssid: string
  password: string
  /** The glasses' address on the link. */
  gateway: string
  /** The phone's address on the link, when the native join reports it. */
  phoneIpv4?: string
  frequency?: number
}

export type GlassesWifiEvent =
  | {type: "lost"; reason: string}
  | {type: "restored"; binding: GlassesWifiBinding}
  | {type: "ended"; reason: string}

export type GlassesWifiHoldOptions = {
  /** Who holds it, for logs. */
  consumer: string
  /** "incoming-server" when the glasses connect to the phone (OTA, video); it adds the VPN check. */
  purpose?: "outgoing-client" | "incoming-server"
  /** Aborting it while the link comes up gives the hold back. */
  signal?: AbortSignal
  /** Runs once the glasses report the network and before the first join, e.g. an explanation. */
  beforeJoin?: (ssid: string) => Promise<void>
  /** iOS: the join waited a few seconds for Local Network access, which may have been denied. */
  onPermissionRequired?: (systemAnswer: string) => void
  /** Narration for a consumer that shows its steps. */
  report?: (line: string) => void
}

export interface GlassesWifiHold {
  /** The link as it is now; after `lost`, the last one until `restored`. */
  readonly binding: GlassesWifiBinding
  onChange(listener: (event: GlassesWifiEvent) => void): () => void
  /** The binding once the link is up: now, or when it is restored. Rejects when it ends or on abort. */
  ready(signal?: AbortSignal): Promise<GlassesWifiBinding>
  /** Idempotent. The link goes down once nobody holds it. */
  release(): Promise<void>
}

/** Bringing the link up failed, at the glasses' hotspot or at the phone's join. */
export class GlassesWifiError extends Error {
  /** The native join's code, e.g. `SOFTAP_UNAVAILABLE`, when it has one. */
  readonly code?: string
  constructor(readonly stage: "hotspot" | "join", readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "GlassesWifiError"
    const code = (cause as {code?: unknown} | null)?.code
    if (typeof code === "string") this.code = code
  }
}

/** How often an enable is re-sent while a join waits: the glasses stop an AP unused for 120 s. */
export const JOIN_KEEPALIVE_MS = 30_000
/** The glasses report the AP enabled before its SSID is in the phone's scan. */
export const BROADCAST_WAIT_MS = 3_000
/** How long holders wait for glasses that restarted or left before the link ends. */
export const RESTORE_DEADLINE_MS = 3 * 60_000
/** How long after the last release an enabled report is taken as a late enable to undo (OS-2133). */
export const LATE_ENABLE_WINDOW_MS = 60_000

const SESSION_REFRESH_CODES = new Set(["wifi_session_restarted", "wifi_session_changed"])
const owner = Symbol("glasses-wifi")

type Holder = {options: GlassesWifiHoldOptions; listeners: Set<(event: GlassesWifiEvent) => void>}

const holders = new Set<Holder>()
let binding: GlassesWifiBinding | null = null
let bringingUp: Promise<GlassesWifiBinding> | null = null
let takingDown: Promise<void> | null = null
let lostAt: number | null = null
/** Why the link ended, while it stays down; ready() rejects with it. */
let endedReason: string | null = null
let releasedAt = Number.NEGATIVE_INFINITY
let commands: Promise<unknown> = Promise.resolve()
let watching: (() => void) | null = null
let restoreTimer: number | null = null
let deadlineTimer: number | null = null

const sleep = (ms: number) => new Promise<void>((resolve) => BgTimer.setTimeout(resolve, ms))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * One hotspot command at a time, re-sent once when a restarting ASG dropped it. ASG answers a
 * same-state command with its current status, so a re-send never cycles the AP.
 */
function setHotspot(enabled: boolean): Promise<HotspotStatus> {
  const send = async () => {
    try {
      return await BluetoothSdk.setHotspotState(enabled)
    } catch (error) {
      const code = (error as {code?: string} | null)?.code
      if (!code || !SESSION_REFRESH_CODES.has(code)) throw error
      await sleep(500)
      return await BluetoothSdk.setHotspotState(enabled)
    }
  }
  const run = commands.then(send, send)
  commands = run.catch(() => undefined)
  return run
}

/** Hold the glasses Wi-Fi link, bringing it up if nobody holds it yet. */
export async function holdGlassesWifi(options: GlassesWifiHoldOptions): Promise<GlassesWifiHold> {
  const holder: Holder = {options, listeners: new Set()}
  if (takingDown) await takingDown
  holders.add(holder)
  watch()
  // A cancelled hold settles at once, whatever the link is doing; giving it back stops the
  // bring-up when nobody else wants the link (the join waits on the person answering a prompt).
  let abort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Glasses Wi-Fi hold cancelled"))
  })
  aborted.catch(() => undefined)
  options.signal?.addEventListener("abort", abort, {once: true})
  let current: GlassesWifiBinding
  try {
    if (options.signal?.aborted) throw new Error("Glasses Wi-Fi hold cancelled")
    current = binding ?? (await Promise.race([bringingUp ?? bringUp(holder), aborted]))
  } catch (error) {
    // Not awaited: the teardown waits for the bring-up to settle, and the next hold waits for it.
    void release(holder).catch((cause) => console.warn("[GlassesWifi] Giving back a failed hold failed", cause))
    throw error
  } finally {
    options.signal?.removeEventListener("abort", abort)
  }
  console.log(`[GlassesWifi] ${options.consumer} holds the link (${holders.size} holder(s))`)
  let released: Promise<void> | null = null
  return {
    get binding() {
      return binding ?? current
    },
    onChange(listener) {
      holder.listeners.add(listener)
      return () => holder.listeners.delete(listener)
    },
    ready(signal) {
      if (binding) return Promise.resolve(binding)
      if (endedReason) return Promise.reject(new Error(endedReason))
      return new Promise((resolve, reject) => {
        const done = () => {
          holder.listeners.delete(listener)
          signal?.removeEventListener("abort", abort)
        }
        const listener = (event: GlassesWifiEvent) => {
          if (event.type === "lost") return
          done()
          if (event.type === "restored") resolve(event.binding)
          else reject(new Error(event.reason))
        }
        const abort = () => {
          done()
          reject(new Error("Glasses Wi-Fi wait cancelled"))
        }
        holder.listeners.add(listener)
        signal?.addEventListener("abort", abort, {once: true})
      })
    },
    release() {
      released ??= release(holder)
      return released
    },
  }
}

function bringUp(first: Holder | null): Promise<GlassesWifiBinding> {
  const attempt = (async () => {
    const report = (line: string) => first?.options.report?.(line)
    const status = await enableHotspot(report).catch((error) => {
      throw new GlassesWifiError("hotspot", error)
    })
    assertWanted()
    await beforeJoin(first, status.ssid)
    assertWanted()
    const joined = await joinWithRetry(status, first, report).catch((error) => {
      throw error instanceof GlassesWifiError ? error : new GlassesWifiError("join", error)
    })
    const wasLost = lostAt !== null
    binding = joined
    lostAt = null
    endedReason = null
    if (wasLost) notify({type: "restored", binding: joined})
    return joined
  })()
  bringingUp = attempt
  const settled = () => {
    if (bringingUp === attempt) bringingUp = null
  }
  attempt.then(settled, settled)
  return attempt
}

async function enableHotspot(report: (line: string) => void) {
  let status = await setHotspot(true).catch(async (error) => {
    // An unanswered enable may still land: ask again rather than turn it off.
    if (!/timed out waiting for glasses response|glasses did not answer/i.test(message(error))) throw error
    report("Glasses did not answer; asking again")
    return setHotspot(true)
  })
  if (!isEnabledHotspotStatus(status)) {
    // A start racing the previous stop reports disabled: turn it off and start again once.
    report("Glasses hotspot did not start; turning it off and trying again")
    await setHotspot(false).catch(() => undefined)
    await sleep(1_000)
    status = await setHotspot(true)
  }
  if (!isEnabledHotspotStatus(status) || !status.password) {
    throw new Error(`The glasses hotspot did not start (state=${status.state})`)
  }
  report(`Glasses report hotspot ${status.ssid} enabled`)
  await sleep(BROADCAST_WAIT_MS)
  return status
}

async function joinWithRetry(
  status: Extract<HotspotStatus, {state: "enabled"}>,
  first: Holder | null,
  report: (line: string) => void,
): Promise<GlassesWifiBinding> {
  try {
    return await join(status, first)
  } catch (error) {
    // Leaving the phone's previous Wi-Fi can make Android's first join fail as Unavailable.
    // Cycle the AP and join again from an idle radio.
    if (!/SOFTAP_UNAVAILABLE/.test(`${(error as {code?: string})?.code} ${message(error)}`)) throw error
    if (holders.size === 0) throw error
    report("Phone couldn't join; cycling the glasses hotspot and trying again")
    await setHotspot(false)
    const again = await enableHotspot(report)
    return await join(again, first)
  }
}

/**
 * The first holder's step before the join, such as gallery's one-time explanation. It belongs to
 * that holder: once it cancels, the bring-up stops waiting for it and goes on for anyone else.
 */
async function beforeJoin(first: Holder | null, ssid: string): Promise<void> {
  const step = first?.options.beforeJoin
  const signal = first?.options.signal
  if (!step || signal?.aborted) return
  let onAbort = () => {}
  const cancelled = new Promise<void>((resolve) => {
    onAbort = resolve
    signal?.addEventListener("abort", onAbort, {once: true})
  })
  try {
    await Promise.race([
      step(ssid).catch((error) => {
        if (!signal?.aborted) throw error
      }),
      cancelled,
    ])
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

/** A bring-up nobody holds any more stops before it starts a join, which has no time limit. */
function assertWanted(): void {
  if (holders.size === 0) throw new Error("Glasses Wi-Fi hold cancelled")
}

async function join(
  status: Extract<HotspotStatus, {state: "enabled"}>,
  first: Holder | null,
): Promise<GlassesWifiBinding> {
  assertWanted()
  const incoming = [...holders].some((holder) => holder.options.purpose === "incoming-server")
  const joining = localNetworkTransport.connect(owner, status.ssid, status.password, {
    gateway: status.localIp,
    frequency: status.frequency,
    purpose: incoming ? "incoming-server" : "outgoing-client",
    onPermissionRequired: (answer) => first?.options.onPermissionRequired?.(answer),
  })
  // The join has no time limit, so a person can take their time with the phone's prompt. Keep
  // the AP up meanwhile: a repeated enable restarts the glasses' idle clock.
  const keepAlive = BgTimer.setInterval(() => {
    setHotspot(true).then(
      (current) => {
        if (current.state !== "enabled") void localNetworkTransport.disconnect(owner).catch(() => undefined)
      },
      (error) => console.warn("[GlassesWifi] Keeping the hotspot up during the join failed", error),
    )
  }, JOIN_KEEPALIVE_MS)
  try {
    const phoneIpv4 = await joining
    return {
      ssid: status.ssid,
      password: status.password,
      gateway: status.localIp,
      phoneIpv4,
      frequency: status.frequency,
    }
  } finally {
    BgTimer.clearInterval(keepAlive)
  }
}

async function release(holder: Holder): Promise<void> {
  if (!holders.delete(holder)) return
  console.log(`[GlassesWifi] ${holder.options.consumer} released the link (${holders.size} left)`)
  if (holders.size > 0) return
  takingDown = takeDown().finally(() => {
    takingDown = null
  })
  await takingDown
}

async function takeDown(): Promise<void> {
  unwatch()
  if (bringingUp) {
    void localNetworkTransport.disconnect(owner).catch(() => undefined)
    await bringingUp.catch(() => undefined)
  }
  binding = null
  lostAt = null
  endedReason = null
  await localNetworkTransport
    .disconnect(owner, true)
    .catch((error) => console.warn("[GlassesWifi] Leaving the glasses network failed", error))
  releasedAt = Date.now()
  // Glasses away now get their AP turned off on return, by reclaimLateHotspot, or by their idle stop.
  if (!isGlassesConnected(useGlassesStore.getState().connection)) return
  for (let attempt = 1; attempt <= 2; attempt++) {
    const status = await setHotspot(false).catch(() => null)
    if (status?.state === "disabled") return
    // A just-replaced ASG can drop the first command while its command path settles.
    await sleep(500)
  }
  console.warn("[GlassesWifi] The glasses did not confirm their hotspot is off")
}

function notify(event: GlassesWifiEvent): void {
  for (const holder of holders) {
    for (const listener of holder.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.warn(`[GlassesWifi] ${holder.options.consumer} failed handling ${event.type}`, error)
      }
    }
  }
}

function lose(reason: string): void {
  if (!binding || holders.size === 0) return
  console.warn(`[GlassesWifi] The link went down: ${reason}`)
  binding = null
  lostAt = Date.now()
  void localNetworkTransport.disconnect(owner).catch(() => undefined)
  notify({type: "lost", reason})
  scheduleRestore()
  // Glasses that never come back still end the link at the deadline.
  if (deadlineTimer !== null) BgTimer.clearTimeout(deadlineTimer)
  deadlineTimer = BgTimer.setTimeout(() => {
    deadlineTimer = null
    void restore()
  }, RESTORE_DEADLINE_MS + 1)
}

/** Ask for the link again once the glasses are ready, until it is back or the deadline passes. */
function scheduleRestore(delayMs = 0): void {
  if (restoreTimer !== null) BgTimer.clearTimeout(restoreTimer)
  restoreTimer = BgTimer.setTimeout(() => {
    restoreTimer = null
    void restore()
  }, delayMs)
}

async function restore(): Promise<void> {
  if (binding || bringingUp || holders.size === 0 || lostAt === null) return
  if (Date.now() - lostAt > RESTORE_DEADLINE_MS) {
    lostAt = null
    endedReason = "the glasses did not bring the link back"
    notify({type: "ended", reason: endedReason})
    return
  }
  if (!isGlassesReady(useGlassesStore.getState().connection)) return // the store watch calls again
  try {
    await bringUp(null)
  } catch (error) {
    console.warn("[GlassesWifi] Bringing the link back failed; trying again", error)
    scheduleRestore(5_000)
  }
}

function watch(): void {
  if (watching) return
  const unsubscribeStore = useGlassesStore.subscribe(
    (state) => state.connection,
    (connection) => {
      if (!isGlassesConnected(connection)) {
        // A join still waiting cannot finish without the glasses: end it, as a loss does.
        if (bringingUp) void localNetworkTransport.disconnect(owner).catch(() => undefined)
        lose("the glasses left Bluetooth")
      } else if (lostAt !== null && isGlassesReady(connection)) scheduleRestore()
    },
  )
  const networkLost = localNetworkTransport.onLost(() => lose("the phone left the glasses network"))
  const hotspot = BluetoothSdk.addListener("hotspot_status_change", (event) => {
    if (event.state !== "enabled" && !bringingUp) lose("the glasses turned their hotspot off")
  })
  watching = () => {
    unsubscribeStore()
    networkLost()
    hotspot.remove()
  }
}

function unwatch(): void {
  watching?.()
  watching = null
  if (restoreTimer !== null) BgTimer.clearTimeout(restoreTimer)
  restoreTimer = null
  if (deadlineTimer !== null) BgTimer.clearTimeout(deadlineTimer)
  deadlineTimer = null
}

/** Whether anyone holds the link now. */
export function glassesWifiHeld(): boolean {
  return holders.size > 0 || takingDown !== null
}

/**
 * Turn off a hotspot that came up with no holder soon after the last release: a hotspot command
 * can wait in the BLE queue past its caller and reach the glasses after the release (OS-2133).
 * An AP the glasses start on their own, long after any phone use, is left alone.
 */
export async function reclaimLateHotspot(): Promise<boolean> {
  if (glassesWifiHeld() || Date.now() - releasedAt >= LATE_ENABLE_WINDOW_MS) return false
  console.warn("[GlassesWifi] An enabled hotspot has no holder after a release; turning it off")
  await setHotspot(false)
  return true
}
