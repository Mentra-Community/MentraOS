// The service is the one sender of hotspot commands; apps never see them.
// eslint-disable-next-line no-restricted-imports
import PrivateBluetoothSdkModule from "../_private/BluetoothSdkModule"
import {
  isConnectedGlassesConnectionStatus,
  isEnabledHotspotStatus,
  isReadyGlassesConnectionStatus,
  type GlassesConnectionStatus,
  type HotspotStatus,
} from "../BluetoothSdk.types"
import {glassesConnection, onGlassesConnection, watchGlassesConnection} from "./connection"
import * as native from "./native"

/**
 * The glasses Wi-Fi service: the one owner of the phone-to-glasses Wi-Fi link.
 *
 * Photo fetches, gallery sync, hotspot OTA, Mentra Call, the managed relay and every fast link
 * hold the link here and use the binding it gives them; none of them sends a hotspot command or
 * joins a network itself. The link is shared: the first holder brings it up (Wi-Fi Direct on
 * Android with glasses that advertise it, else the glasses' hotspot, then the phone's one native
 * join), later holders get the same binding, and the last release takes it down. A link that is up stays
 * up for [RELEASE_LINGER_MS] after its last release, and a hold meanwhile takes it as it is: a
 * miniapp that restarts, or a fetch that follows a photo, doesn't take the link down and wait for
 * it to come back.
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
  purpose?: native.JoinPurpose
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
  /** Idempotent. The link goes down [RELEASE_LINGER_MS] after nobody holds it, unless someone holds it again. */
  release(): Promise<void>
}

/** Bringing the link up failed: the glasses did not enable it, or the phone did not join it. */
export class GlassesWifiError extends Error {
  /** The native join's code, e.g. `SOFTAP_UNAVAILABLE`, when it has one. */
  readonly code?: string
  constructor(readonly stage: "enable" | "join", readonly cause: unknown) {
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
/** How long a link that is up stays up after its last release, for a hold that follows at once. */
export const RELEASE_LINGER_MS = 5_000

const SESSION_REFRESH_CODES = new Set(["wifi_session_restarted", "wifi_session_changed"])

type Holder = {options: GlassesWifiHoldOptions; listeners: Set<(event: GlassesWifiEvent) => void>}
type Link = "hotspot" | "wifi_direct"

const holders = new Set<Holder>()
let binding: GlassesWifiBinding | null = null
let bringingUp: Promise<GlassesWifiBinding> | null = null
let takingDown: Promise<void> | null = null
/** Cancels the teardown waiting out [RELEASE_LINGER_MS] after the last release, while it waits. */
let cancelLinger: (() => void) | null = null
/** The radio of the link up or coming up. */
let linkType: Link | null = null
let lostAt: number | null = null
/** Why the link ended, while it stays down; ready() rejects with it. */
let endedReason: string | null = null
let releasedAt = Number.NEGATIVE_INFINITY
let commands: Promise<unknown> = Promise.resolve()
let watching: (() => void) | null = null
let cancelRestore: (() => void) | null = null
let cancelDeadline: (() => void) | null = null
const upListeners = new Set<(up: boolean) => void>()
let reclaiming: {remove(): void} | null = null

/** The link's binding; whoever listens hears it go up and down. */
function setBinding(next: GlassesWifiBinding | null): void {
  const changed = (binding === null) !== (next === null)
  binding = next
  if (!changed) return
  for (const listener of upListeners) {
    try {
      listener(next !== null)
    } catch (error) {
      console.warn("[GlassesWifi] A link listener failed", error)
    }
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Run `callback` after `ms`, also in the background; the returned function cancels it. */
function after(ms: number, callback: () => void): () => void {
  let cancelled = false
  void native.delay(ms).then(() => {
    if (!cancelled) callback()
  })
  return () => {
    cancelled = true
  }
}

/**
 * One hotspot command at a time, re-sent once when a restarting ASG dropped it. ASG answers a
 * same-state command with its current status, so a re-send never cycles the AP.
 */
function setHotspot(enabled: boolean): Promise<HotspotStatus> {
  const send = async () => {
    try {
      return await PrivateBluetoothSdkModule.setHotspotState(enabled)
    } catch (error) {
      const code = (error as {code?: string} | null)?.code
      if (!code || !SESSION_REFRESH_CODES.has(code)) throw error
      await native.delay(500)
      return await PrivateBluetoothSdkModule.setHotspotState(enabled)
    }
  }
  const run = commands.then(send, send)
  commands = run.catch(() => undefined)
  return run
}

/** Hold the glasses Wi-Fi link, bringing it up if nobody holds it yet. */
export async function holdGlassesWifi(options: GlassesWifiHoldOptions): Promise<GlassesWifiHold> {
  const holder: Holder = {options, listeners: new Set()}
  // A link waiting out its last release is still up: this hold takes it as it is.
  stopLinger()
  if (takingDown) await takingDown
  holders.add(holder)
  watchLateHotspots()
  await watch()
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
          signal?.removeEventListener("abort", onAbort)
        }
        const listener = (event: GlassesWifiEvent) => {
          if (event.type === "lost") return
          done()
          if (event.type === "restored") resolve(event.binding)
          else reject(new Error(event.reason))
        }
        const onAbort = () => {
          done()
          reject(new Error("Glasses Wi-Fi wait cancelled"))
        }
        holder.listeners.add(listener)
        signal?.addEventListener("abort", onAbort, {once: true})
      })
    },
    release() {
      released ??= release(holder)
      return released
    },
  }
}

/**
 * The radio, chosen once per bring-up from the platform and the glasses' capability: Wi-Fi Direct
 * on Android with glasses that advertise `wifi_direct_version`, the hotspot otherwise.
 */
async function chooseLink(): Promise<Link> {
  return (await native.wifiDirectAvailable()) ? "wifi_direct" : "hotspot"
}

const purpose = (): native.JoinPurpose =>
  [...holders].some((holder) => holder.options.purpose === "incoming-server") ? "incoming-server" : "outgoing-client"

function bringUp(first: Holder | null): Promise<GlassesWifiBinding> {
  const attempt = (async () => {
    const report = (line: string) => first?.options.report?.(line)
    linkType = await chooseLink()
    console.log(`[GlassesWifi] Bringing up the ${linkType} link`)
    const joined = linkType === "wifi_direct" ? await joinWifiDirect(report) : await joinHotspot(first, report)
    const wasLost = lostAt !== null
    setBinding(joined)
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

async function joinHotspot(first: Holder | null, report: (line: string) => void): Promise<GlassesWifiBinding> {
  const status = await enableHotspot(report).catch((error) => {
    throw new GlassesWifiError("enable", error)
  })
  assertWanted()
  await beforeJoin(first, status.ssid)
  assertWanted()
  return await joinWithRetry(status, first, report).catch((error) => {
    throw error instanceof GlassesWifiError ? error : new GlassesWifiError("join", error)
  })
}

/** The native join asks the glasses for their group over Bluetooth and joins it, with no prompt. */
async function joinWifiDirect(report: (line: string) => void): Promise<GlassesWifiBinding> {
  assertWanted()
  const joined = await native.joinWifiDirect(purpose()).catch((error) => {
    throw new GlassesWifiError("join", error)
  })
  if (!joined.gateway) throw new GlassesWifiError("join", new Error("The glasses reported no group address"))
  report(`Joined the glasses' Wi-Fi Direct group ${joined.ssid}`)
  // A group has no password the consumers need: the phone joined it with the one the glasses sent.
  return {ssid: joined.ssid, password: "", gateway: joined.gateway, phoneIpv4: joined.localAddress}
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
    await native.delay(1_000)
    status = await setHotspot(true)
  }
  if (!isEnabledHotspotStatus(status) || !status.password) {
    throw new Error(`The glasses hotspot did not start (state=${status.state})`)
  }
  report(`Glasses report hotspot ${status.ssid} enabled`)
  await native.delay(BROADCAST_WAIT_MS)
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
  const joining = native.joinHotspot(status.ssid, status.password, {
    gateway: status.localIp,
    frequency: status.frequency,
    purpose: purpose(),
    onPermissionRequired: (answer) => first?.options.onPermissionRequired?.(answer),
  })
  // The join has no time limit, so a person can take their time with the phone's prompt. Keep
  // the AP up meanwhile: a repeated enable restarts the glasses' idle clock.
  let keepAlive = () => {}
  const scheduleKeepAlive = () => {
    keepAlive = after(JOIN_KEEPALIVE_MS, () => {
      setHotspot(true).then(
        (current) => {
          if (current.state !== "enabled") void native.leave().catch(() => undefined)
        },
        (error) => console.warn("[GlassesWifi] Keeping the hotspot up during the join failed", error),
      )
      scheduleKeepAlive()
    })
  }
  scheduleKeepAlive()
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
    keepAlive()
  }
}

async function release(holder: Holder): Promise<void> {
  if (!holders.delete(holder)) return
  console.log(`[GlassesWifi] ${holder.options.consumer} released the link (${holders.size} left)`)
  if (holders.size > 0) return
  // A link that is up waits a little before it goes down. One still coming up, lost or ended goes
  // down now: giving it back is what stops a bring-up nobody wants any more.
  if (binding && !bringingUp && lostAt === null && endedReason === null) {
    cancelLinger = after(RELEASE_LINGER_MS, () => {
      cancelLinger = null
      if (holders.size === 0) void startTakeDown()
    })
    return
  }
  await startTakeDown()
}

function startTakeDown(): Promise<void> {
  stopLinger()
  takingDown ??= takeDown().finally(() => {
    takingDown = null
  })
  return takingDown
}

function stopLinger(): void {
  cancelLinger?.()
  cancelLinger = null
}

async function takeDown(): Promise<void> {
  unwatch()
  if (bringingUp) {
    void native.leave().catch(() => undefined)
    await bringingUp.catch(() => undefined)
  }
  setBinding(null)
  lostAt = null
  endedReason = null
  await native.leave().catch((error) => console.warn("[GlassesWifi] Leaving the glasses network failed", error))
  releasedAt = Date.now()
  // Leaving the Wi-Fi Direct group above also told the glasses to remove it.
  const down = linkType
  linkType = null
  if (down === "wifi_direct") return
  // Glasses away now get their AP turned off on return, by the late-hotspot watch, or by their idle stop.
  if (!isConnectedGlassesConnectionStatus(glassesConnection())) return
  for (let attempt = 1; attempt <= 2; attempt++) {
    const status = await setHotspot(false).catch(() => null)
    if (status?.state === "disabled") return
    // A just-replaced ASG can drop the first command while its command path settles.
    await native.delay(500)
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
  // Lost while waiting out its last release: nobody is left to restore it for.
  if (cancelLinger && holders.size === 0) {
    console.log(`[GlassesWifi] The link went down after its last release: ${reason}`)
    void startTakeDown()
    return
  }
  if (!binding || holders.size === 0) return
  console.warn(`[GlassesWifi] The link went down: ${reason}`)
  setBinding(null)
  lostAt = Date.now()
  void native.leave().catch(() => undefined)
  notify({type: "lost", reason})
  scheduleRestore()
  // Glasses that never come back still end the link at the deadline.
  cancelDeadline?.()
  cancelDeadline = after(RESTORE_DEADLINE_MS + 1, () => {
    cancelDeadline = null
    void restore()
  })
}

/** Ask for the link again once the glasses are ready, until it is back or the deadline passes. */
function scheduleRestore(delayMs = 0): void {
  cancelRestore?.()
  cancelRestore = after(delayMs, () => {
    cancelRestore = null
    void restore()
  })
}

async function restore(): Promise<void> {
  if (binding || bringingUp || holders.size === 0 || lostAt === null) return
  if (Date.now() - lostAt > RESTORE_DEADLINE_MS) {
    lostAt = null
    endedReason = "the glasses did not bring the link back"
    notify({type: "ended", reason: endedReason})
    return
  }
  if (!isReadyGlassesConnectionStatus(glassesConnection())) return // the connection watch calls again
  try {
    await bringUp(null)
  } catch (error) {
    console.warn("[GlassesWifi] Bringing the link back failed; trying again", error)
    scheduleRestore(5_000)
  }
}

async function watch(): Promise<void> {
  if (watching) return
  const unsubscribeStatus = onGlassesConnection(onConnection)
  const networkLost = native.onLost(() => lose("the phone left the glasses network"))
  const hotspot = PrivateBluetoothSdkModule.addListener("hotspot_status_change", (event) => {
    if (linkType === "hotspot" && event.state !== "enabled" && !bringingUp) lose("the glasses turned their hotspot off")
  })
  watching = () => {
    unsubscribeStatus()
    networkLost()
    hotspot.remove()
  }
  await watchGlassesConnection()
}

function onConnection(next: GlassesConnectionStatus): void {
  if (!isConnectedGlassesConnectionStatus(next)) {
    // A join still waiting cannot finish without the glasses: end it, as a loss does.
    if (bringingUp) void native.leave().catch(() => undefined)
    lose("the glasses left Bluetooth")
  } else if (lostAt !== null && isReadyGlassesConnectionStatus(next)) scheduleRestore()
}

function unwatch(): void {
  watching?.()
  watching = null
  cancelRestore?.()
  cancelRestore = null
  cancelDeadline?.()
  cancelDeadline = null
}

/**
 * Hold the link only if it is up now (someone else brought it up): for a use that is just as well
 * served over Bluetooth, like a file fetch, and must not bring the link up itself. Null when it
 * is down, coming up or going down.
 */
export async function holdGlassesWifiIfUp(consumer: string): Promise<GlassesWifiHold | null> {
  if ((holders.size === 0 && !cancelLinger) || !binding || lostAt !== null || bringingUp || takingDown) return null
  return holdGlassesWifi({consumer})
}

/** Whether anyone holds the link now. */
function held(): boolean {
  return holders.size > 0 || takingDown !== null || cancelLinger !== null
}

/**
 * Turn off a hotspot that came up with no holder soon after the last release: a hotspot command
 * can wait in the BLE queue past its caller and reach the glasses after the release (OS-2133).
 * An AP the glasses start on their own, long after any phone use, is left alone. Watched from the
 * first hold on, since only a release opens the window.
 */
function watchLateHotspots(): void {
  if (reclaiming) return
  reclaiming = PrivateBluetoothSdkModule.addListener("hotspot_status_change", (event) => {
    if (event.state !== "enabled" || held() || Date.now() - releasedAt >= LATE_ENABLE_WINDOW_MS) return
    console.warn("[GlassesWifi] An enabled hotspot has no holder after a release; turning it off")
    void setHotspot(false).catch((error) => console.warn("[GlassesWifi] Could not turn off the late hotspot", error))
  })
}

/** Whether the glasses Wi-Fi link is up now, for whoever holds it. */
export function glassesWifiUp(): boolean {
  return binding !== null
}

/** Hear the glasses Wi-Fi link go up and down, whoever holds it. */
export function onGlassesWifiUp(listener: (up: boolean) => void): () => void {
  upListeners.add(listener)
  return () => {
    upListeners.delete(listener)
  }
}
