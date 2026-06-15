/**
 * AppGrid — the home-screen grid layout computation extracted from AppsGrid.
 *
 * Pure: given the apps, the saved order map, and the view flags, it returns the
 * ordered list (with placeholder "@empty" slots inserted so apps can be dragged
 * to any cell) plus the next order map to persist. The dummy-applet template and
 * the priority sort are injected so this module stays free of the app store and
 * its native dependencies, keeping it unit-testable.
 *
 * Lifted from the AppsGrid useMemo, which already worked on a local copy of the
 * order map (no mutation of React state during render), so the home grid renders
 * and reorders exactly as before.
 */
import type {ClientApp} from "../types/applet"
import type {OrderMap} from "../stores/apps"

const GRID_COLUMNS = 4
const MIN_APPS = 20

export interface ComputeAppGridDeps {
  /** The placeholder applet template spread into each empty slot. */
  dummyApplet: ClientApp
  /** Sort comparator for apps with no explicit order (priority + name). */
  sortByPriority: (a: ClientApp, b: ClientApp) => number
}

export interface ComputeAppGridInput {
  apps: ClientApp[]
  orderMap: OrderMap
  showAllApps: boolean
  searchQuery?: string
}

export interface ComputeAppGridResult {
  /** Apps in render order, including the inserted "@empty" placeholder slots. */
  orderedApps: ClientApp[]
  /** The order map to persist — a fresh copy; the input is never mutated. */
  nextOrderMap: OrderMap
}

export function computeAppGrid(input: ComputeAppGridInput, deps: ComputeAppGridDeps): ComputeAppGridResult {
  const {apps, orderMap, showAllApps, searchQuery} = input
  const {dummyApplet, sortByPriority} = deps

  let filteredApps = apps.filter((app) => {
    if (showAllApps) {
      return true
    }
    if (app.hidden) {
      return false
    }
    return true
  })

  if (searchQuery && searchQuery.trim() !== "") {
    const query = searchQuery.toLowerCase().trim()
    filteredApps = filteredApps.filter(
      (app) => app.name?.toLowerCase().includes(query) || app.packageName?.toLowerCase().includes(query),
    )
  }

  // Local working copy — never mutate the input order map.
  const workingOrderMap: OrderMap = {...orderMap}

  // Add dummy "@empty" apps so real apps can be placed anywhere in the grid.
  const totalItems = filteredApps.length
  const remainder = totalItems % GRID_COLUMNS
  let emptySlots = GRID_COLUMNS - remainder
  if (remainder === 0) {
    emptySlots = 0
  }
  while (emptySlots + totalItems < MIN_APPS) {
    emptySlots += GRID_COLUMNS
  }
  if (emptySlots < GRID_COLUMNS) {
    emptySlots += GRID_COLUMNS
  }

  if (!showAllApps) {
    const orderedPackages = new Set(
      filteredApps.filter((app) => workingOrderMap[app.packageName] !== undefined).map((app) => app.packageName),
    )
    const usedIndices = new Set<number>()
    orderedPackages.forEach((pkg) => usedIndices.add(workingOrderMap[pkg]))

    if (usedIndices.size > 0) {
      const highestRealIndex = Math.max(...usedIndices)
      let maxIndex = filteredApps.length + emptySlots
      for (let i = 0; i <= highestRealIndex; i++) {
        if (!usedIndices.has(i)) {
          filteredApps.push({...dummyApplet, packageName: `@empty${i}`})
          workingOrderMap[`@empty${i}`] = i
          emptySlots -= 1
          maxIndex = filteredApps.length + emptySlots
        }
      }

      // Add the remaining dummy apps after the highest positioned real app.
      for (let i = highestRealIndex + 1; i <= maxIndex - 1; i++) {
        filteredApps.push({...dummyApplet, packageName: `@empty${i}`})
        workingOrderMap[`@empty${i}`] = i
        emptySlots -= 1
      }
    }
  }

  if (showAllApps) {
    emptySlots = Math.min(emptySlots, GRID_COLUMNS * 2)
    for (let i = 0; i < emptySlots; i++) {
      const index = filteredApps.length + i + 100
      filteredApps.push({...dummyApplet, packageName: `@empty${index}`})
      workingOrderMap[`@empty${index}`] = index
    }
  }

  // Assign unpositioned real apps to the first available empty slots.
  const unpositioned = filteredApps.filter(
    (app) => !app.packageName.startsWith("@empty") && workingOrderMap[app.packageName] === undefined,
  )
  if (unpositioned.length > 0) {
    const dummySlots = filteredApps
      .filter((app) => app.packageName.startsWith("@empty") && workingOrderMap[app.packageName] !== undefined)
      .sort((a, b) => workingOrderMap[a.packageName] - workingOrderMap[b.packageName])

    for (const app of unpositioned) {
      const dummy = dummySlots.shift()
      if (dummy) {
        workingOrderMap[app.packageName] = workingOrderMap[dummy.packageName]
        delete workingOrderMap[dummy.packageName]
        const idx = filteredApps.indexOf(dummy)
        if (idx !== -1) filteredApps.splice(idx, 1)
      }
    }
  }

  filteredApps.sort((a, b) => {
    const aIndex = workingOrderMap[a.packageName]
    const bIndex = workingOrderMap[b.packageName]
    if (aIndex === undefined && bIndex === undefined) {
      return sortByPriority(a, b)
    }
    if (aIndex === undefined) return 1
    if (bIndex === undefined) return -1
    return aIndex - bIndex
  })

  if (showAllApps) {
    filteredApps.sort(sortByPriority)
  }

  return {orderedApps: filteredApps, nextOrderMap: workingOrderMap}
}
