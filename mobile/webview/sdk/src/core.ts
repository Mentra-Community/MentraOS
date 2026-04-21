import {getBridge} from "./bridge"
import type {DisplayTextArgs} from "./types"

/**
 * Core module providing basic MentraOS functions
 */
export class CoreModule {
  /**
   * Display text on the smartglasses
   */
  displayText(text: string): void {
    getBridge().send({
      type: "core_fn",
      payload: {
        fn: "displayText",
        text: text,
      },
    })
  }
}

// Global core module instance
let coreModuleInstance: CoreModule | null = null

/**
 * Get the global CoreModule instance
 */
export function getCoreModule(): CoreModule {
  if (!coreModuleInstance) {
    coreModuleInstance = new CoreModule()
  }
  return coreModuleInstance
}
