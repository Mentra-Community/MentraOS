/**
 * G2 Dashboard Menu Utilities
 *
 * Maps MentraOS mini-apps to the G2 glasses' native swipe menu.
 * RN is responsible for: which miniapps go in the menu, and whether they're running.
 * G2.swift is responsible for: name truncation, running indicators, padding, numeric IDs, wire format.
 */

import {sortAppsByLastOpenTime, useAppStatusStore, type ClientApp} from "@mentra/island"

import {SYSTEM_APPS} from "@/constants/miniapps"

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
export async function getDefaultMenuApps(allApps: ClientApp[]): Promise<GlassesMenuItem[]> {
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
  allApps: ClientApp[],
): GlassesMenuItem[] {
  return savedItems.filter((item) => {
    const app = allApps.find((a) => a.packageName === item.packageName)
    return app && app.compatibility?.isCompatible !== false
  })
}