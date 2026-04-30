/**
 * G2 Dashboard Menu Utilities
 *
 * Maps MentraOS mini-apps to the G2 glasses' native swipe menu.
 * RN is responsible for: which miniapps go in the menu, and whether they're running.
 * G2.swift is responsible for: name truncation, running indicators, padding, numeric IDs, wire format.
 */

import {sortAppsByLastOpenTime, SYSTEM_APPS, useAppletStatusStore, type ClientAppletInterface} from "@/stores/applets"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {DeviceTypes} from "@/../../cloud/packages/types/src"
// import CoreModule from "core"

export interface GlassesMenuItem {
  packageName: string
  name: string
  running?: boolean
}

const MAX_MENU_ITEMS = 10

/**
 * Build menu items from a list of miniapps (capped at MAX_MENU_ITEMS).
 */
export function buildMenuItems(apps: {packageName: string; name: string}[]): GlassesMenuItem[] {
  return apps.slice(0, MAX_MENU_ITEMS).map((app) => ({
    packageName: app.packageName,
    name: app.name,
  }))
}

/**
 * Auto-populate the dashboard menu with the most recently used compatible miniapps.
 * Used when the user hasn't explicitly configured their menu.
 */
export async function getDefaultMenuApps(allApps: ClientAppletInterface[]): Promise<GlassesMenuItem[]> {
  const candidates = allApps.filter(
    (app) => !app.hidden && app.compatibility?.isCompatible !== false && !SYSTEM_APPS.includes(app.packageName),
  )

  // sortAppsByLastOpenTime returns ascending (oldest first), reverse for most recent first
  const sorted = await sortAppsByLastOpenTime(candidates)
  sorted.reverse()

  return buildMenuItems(sorted)
}

/**
 * Filter a saved menu list against current miniapp compatibility.
 * Returns only items whose miniapps are still installed and compatible.
 */
export function filterCompatibleMenuItems(
  savedItems: GlassesMenuItem[],
  allApps: ClientAppletInterface[],
): GlassesMenuItem[] {
  return savedItems.filter((item) => {
    const app = allApps.find((a) => a.packageName === item.packageName)
    return app && app.compatibility?.isCompatible !== false
  })
}

/**
 * Sync the G2 dashboard menu to glasses.
 * Reads the saved menu setting, resolves running state, sends to native.
 * G2.swift handles all display formatting (truncation, indicators, padding, IDs).
 *
 * This is the SINGLE codepath for sending menu data to glasses.
 * Triggered by: glasses connect, applet store changes, settings screen save.
 */
// export async function syncDashboardMenu() {
//   const defaultWearable = useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
//   if (defaultWearable !== DeviceTypes.G2) return
//   if (!useGlassesStore.getState().fullyBooted) return
//   const savedMenuApps = useSettingsStore.getState().getSetting(SETTINGS.menu_apps.key) as
//     | GlassesMenuItem[]
//     | null
//   const allApps = useAppletStatusStore.getState().apps
//   let menuItems: GlassesMenuItem[]
//   if (savedMenuApps && savedMenuApps.length > 0) {
//     menuItems = filterCompatibleMenuItems(savedMenuApps, allApps)
//   } else {
//     menuItems = await getDefaultMenuApps(allApps)
//   }
//   // Send to native: [{name, packageName, running}]
//   // G2.swift handles truncation, running prefix, padding, numeric IDs
//   const itemsForNative = menuItems.map((item) => {
//     const app = allApps.find((a) => a.packageName === item.packageName)
//     return {
//       name: item.name,
//       packageName: item.packageName,
//       running: app?.running ?? false,
//     }
//   })
//   useSettingsStore.getState().setSetting(SETTINGS.menu_apps.key, itemsForNative)
//   console.log(`GLASSES_MENU: Synced ${itemsForNative.length} miniapps to G2 dashboard menu`)
// }
