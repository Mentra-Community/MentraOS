/**
 * Managed miniapp settings on the phone (design: design_docs/platform/enterprise/managed-miniapp-settings/spec.md):
 * the one place a miniapp's configuration is put together from its layers.
 *
 * - **shipped**: each key's `default` in the installed bundle's `miniapp.json` `configuration`;
 * - **deployment**: the deployment manifest's `miniapps.configuration` (bootstrap's `getMiniappConfiguration`);
 * - **workspace**: the values on the miniapp's Fleet assignment, which the assignment reconciler hands over from each
 *   complete desired state (`setWorkspace`).
 *
 * A workspace layer is kept per package with the account it came for, in the `mentra-fleet` store beside the pins,
 * and counts only while that account is signed in. It takes effect once every file it names is in the miniapp's blob
 * store as `configuration/<sha256>`, downloaded through Core and checked against its hash; until then the previous
 * layer stays. A cached file the blob cache evicted is fetched again when the miniapp next connects (`ensureFiles`).
 * Whenever what a miniapp reads may have changed, `notify` asks the runtime to push it (`CONFIGURATION_UPDATE`).
 */
import {
  configurationFileKey,
  mergeConfiguration,
  readConfigurationDeclaration,
  type MergedConfiguration,
} from "@mentra/cloud-protocol/miniapp-configuration"

import {sha256Hex} from "../utils/sha256"
import type {FleetKeyValueStore} from "./fleet/fleetQueue"

export const MINIAPP_CONFIGURATION_STORE_PREFIX = "miniapp.configuration.v1/"

export interface ConfigurationAccount {
  coreUrl: string
  mentraUserId: string
}

interface StoredLayer extends ConfigurationAccount {
  values: Record<string, unknown>
}

export interface MiniappConfigurationDeps {
  store(): FleetKeyValueStore
  /** The account signed in now, or null. */
  account(): ConfigurationAccount | null
  /** A file's bytes from the account's workspace, unchecked. */
  fetchFile(sha256: string): Promise<Uint8Array>
  files: {
    has(packageName: string, key: string): boolean
    store(packageName: string, key: string, bytes: Uint8Array, mimeType: string): Promise<void>
  }
  /** The package's configuration may have changed: push it to the miniapp if it runs. */
  notify(packageName: string): void
}

/** Every `{sha256, type}` a set of values names: a file value is an object with its SHA-256. */
function filesIn(value: unknown, found = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) for (const item of value) filesIn(item, found)
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.sha256 === "string" && /^[0-9a-f]{64}$/.test(record.sha256)) {
      found.set(record.sha256, typeof record.type === "string" && record.type ? record.type : "application/octet-stream")
    } else for (const item of Object.values(record)) filesIn(item, found)
  }
  return found
}

const sameAccount = (a: ConfigurationAccount | null, b: ConfigurationAccount) =>
  a !== null && a.mentraUserId === b.mentraUserId && a.coreUrl.replace(/\/+$/, "") === b.coreUrl.replace(/\/+$/, "")

export function createMiniappConfiguration(deps: MiniappConfigurationDeps) {
  const key = (packageName: string) => `${MINIAPP_CONFIGURATION_STORE_PREFIX}${packageName}`
  /** Per package, the change being applied: one at a time, in order. */
  const queues = new Map<string, Promise<void>>()

  function stored(packageName: string): StoredLayer | null {
    try {
      const raw = deps.store().getString(key(packageName))
      return raw ? (JSON.parse(raw) as StoredLayer) : null
    } catch {
      return null
    }
  }

  function workspaceLayer(packageName: string): Record<string, unknown> | undefined {
    const layer = stored(packageName)
    return layer && sameAccount(deps.account(), layer) ? layer.values : undefined
  }

  /** Download each file the values name that the miniapp's store lacks; throws when one can't be had. */
  async function fetchMissing(packageName: string, values: Record<string, unknown>): Promise<void> {
    for (const [sha256, mimeType] of filesIn(values)) {
      const blobKey = configurationFileKey(sha256)
      if (deps.files.has(packageName, blobKey)) continue
      const bytes = await deps.fetchFile(sha256)
      if ((await sha256Hex(bytes)) !== sha256) throw new Error(`configuration file ${sha256} does not match its hash`)
      await deps.files.store(packageName, blobKey, bytes, mimeType)
    }
  }

  function enqueue(packageName: string, work: () => Promise<void>): Promise<void> {
    const next = (queues.get(packageName) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      console.warn(`[miniappConfiguration] ${packageName}: ${error instanceof Error ? error.message : String(error)}`)
    })
    queues.set(packageName, next)
    return next
  }

  return {
    /**
     * The workspace's values for the package from a complete desired state, or null when it sets none. Applied once
     * its files are in; a failure keeps the previous layer, and the next desired state tries again.
     */
    setWorkspace(packageName: string, values: Record<string, unknown> | null, account: ConfigurationAccount): Promise<void> {
      return enqueue(packageName, async () => {
        const current = stored(packageName)
        if (values === null || Object.keys(values).length === 0) {
          if (!current) return
          deps.store().remove(key(packageName))
          deps.notify(packageName)
          return
        }
        const next: StoredLayer = {coreUrl: account.coreUrl, mentraUserId: account.mentraUserId, values}
        if (current && JSON.stringify(current) === JSON.stringify(next)) return
        await fetchMissing(packageName, values)
        deps.store().set(key(packageName), JSON.stringify(next))
        deps.notify(packageName)
      })
    },

    /** Every package holding a workspace layer, whichever account's. */
    workspacePackages(): string[] {
      try {
        return deps
          .store()
          .getAllKeys()
          .filter((k) => k.startsWith(MINIAPP_CONFIGURATION_STORE_PREFIX))
          .map((k) => k.slice(MINIAPP_CONFIGURATION_STORE_PREFIX.length))
      } catch {
        return []
      }
    },

    /** What the miniapp reads, from its installed `miniapp.json` and the layers held now. */
    merged(packageName: string, manifest: unknown, deployment: Record<string, unknown>): MergedConfiguration {
      return mergeConfiguration(readConfigurationDeclaration(manifest), {
        deployment,
        workspace: workspaceLayer(packageName),
      })
    },

    /** Fetch again the workspace's files the blob cache dropped, then push the values. */
    ensureFiles(packageName: string): void {
      const values = workspaceLayer(packageName)
      if (!values || [...filesIn(values).keys()].every((sha) => deps.files.has(packageName, configurationFileKey(sha)))) return
      void enqueue(packageName, async () => {
        await fetchMissing(packageName, values)
        deps.notify(packageName)
      })
    },
  }
}

export type MiniappConfiguration = ReturnType<typeof createMiniappConfiguration>
