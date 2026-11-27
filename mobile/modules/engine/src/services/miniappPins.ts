/**
 * The phone's pins: per package, a choice to stay on one version of a miniapp, whatever its URL serves as latest.
 *
 * A pin is a version and the hash that version had when it was chosen (the seal, `MiniappPin`). It is its own record,
 * not part of an install: a phone with nothing installed holds a pin before its first install, and the URL updater
 * has to see a pin before the Fleet reconciler's install of it succeeds, or it would move the package to latest.
 *
 * A record has a slot per party that may pin:
 * - `fleet`: the pin of the assignment that installs the package. The assignment reconciler writes it from each
 *   complete desired state, and clears it when the entry is `latest`, when the assignment goes, and when the phone
 *   leaves its workspace.
 * - `person`: a person's own pin, from a miniapp's settings. Nothing writes it yet. A Fleet pin wins over it while
 *   both are held: a miniapp a workspace assigns is the workspace's to pin.
 *
 * Every path that decides what to install from a miniapp URL reads the pin through `selectInstallTarget`
 * (`miniappInstallTarget.ts`). Records live in the `mentra-fleet` MMKV instance with the reconciler's own state,
 * which logout does not clear, so a pin outlives a sign-out as the assignment reason it belongs to does.
 */
import type {MiniappPin} from "@mentra/cloud-protocol/miniapp-url"

import type {FleetKeyValueStore} from "./fleet/fleetQueue"

/** A Fleet assignment's pin, with the assignment that set it. */
export interface FleetMiniappPin extends MiniappPin {
  assignmentId: string
  assignmentRevision: number
  workspaceId: string
  coreUrl: string
  mentraUserId: string
  /** The assignment's miniapp URL: the `versions` list the pin was sealed against. */
  url: string
}

/** A package's pins. */
export interface MiniappPinRecord {
  fleet?: FleetMiniappPin
  /** A person's own pin. Not written by anything yet. */
  person?: MiniappPin
}

/** The pin that applies to a package's installs, or null for latest. */
export type MiniappPinReader = (packageName: string) => MiniappPin | null

export interface MiniappPins {
  record(packageName: string): MiniappPinRecord | null
  /** The pin that applies: the Fleet slot's, else the person's, else null. */
  pinFor: MiniappPinReader
  /** Every package holding a Fleet pin. */
  fleetPinnedPackages(): string[]
  /** Set the package's Fleet pin, or clear it with null. Never throws: a pin that can't be stored is logged. */
  setFleetPin(packageName: string, pin: FleetMiniappPin | null): void
}

export const MINIAPP_PIN_STORE_PREFIX = "miniapp.pins.v1/"

const SHA256_HEX = /^[0-9a-f]{64}$/

function readPin(value: unknown): MiniappPin | null {
  if (!value || typeof value !== "object") return null
  const {version, sha256} = value as Record<string, unknown>
  if (typeof version !== "string" || version.length === 0) return null
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256.toLowerCase())) return null
  return {version, sha256: sha256.toLowerCase()}
}

export function createMiniappPins(store: () => FleetKeyValueStore): MiniappPins {
  const key = (packageName: string) => `${MINIAPP_PIN_STORE_PREFIX}${packageName}`

  function record(packageName: string): MiniappPinRecord | null {
    let raw: string | undefined
    try {
      raw = store().getString(key(packageName))
    } catch (error) {
      console.warn(`Could not read the pins of ${packageName}`, error)
      return null
    }
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as {fleet?: unknown; person?: unknown}
      const fleetPin = readPin(parsed.fleet)
      const person = readPin(parsed.person)
      const result: MiniappPinRecord = {}
      // A Fleet pin keeps the assignment it came from; one stored without it is still the pin.
      if (fleetPin) result.fleet = {...(parsed.fleet as FleetMiniappPin), ...fleetPin}
      if (person) result.person = person
      return result.fleet || result.person ? result : null
    } catch {
      return null
    }
  }

  function write(packageName: string, next: MiniappPinRecord): void {
    try {
      if (next.fleet || next.person) store().set(key(packageName), JSON.stringify(next))
      else store().remove(key(packageName))
    } catch (error) {
      console.warn(`Could not keep the pins of ${packageName}`, error)
    }
  }

  return {
    record,
    pinFor(packageName) {
      const pins = record(packageName)
      const pin = pins?.fleet ?? pins?.person
      return pin ? {version: pin.version, sha256: pin.sha256} : null
    },
    fleetPinnedPackages() {
      let keys: string[]
      try {
        keys = store().getAllKeys()
      } catch (error) {
        console.warn("Could not list the pinned miniapps", error)
        return []
      }
      return keys
        .filter((k) => k.startsWith(MINIAPP_PIN_STORE_PREFIX))
        .map((k) => k.slice(MINIAPP_PIN_STORE_PREFIX.length))
        .filter((packageName) => record(packageName)?.fleet !== undefined)
    },
    setFleetPin(packageName, pin) {
      const current = record(packageName) ?? {}
      const {fleet: _previous, ...rest} = current
      write(packageName, pin ? {...rest, fleet: {...pin, sha256: pin.sha256.toLowerCase()}} : rest)
    },
  }
}

// The Fleet store (MMKV) loads when a pin is first read, so the modules that only read one (the installer, the URL
// updater, the resolver) don't load native storage where they are imported, in tests among them.
const fleetStore = () => (require("./fleet/fleetStorage") as typeof import("./fleet/fleetStorage")).getFleetStore()

/** The phone's pins. */
export const miniappPins: MiniappPins = createMiniappPins(fleetStore)
