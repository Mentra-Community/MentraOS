import {getBridge} from "./bridge"
import type {DisplayTextArgs, SetMicStateArgs, MicState} from "./types"

/**
 * Core module providing basic MentraOS functions
 */
export class CoreModule {
  /**
   * Display text on the smartglasses
   */
  displayText(text: string): void
  displayText(args: DisplayTextArgs): void
  displayText(textOrArgs: string | DisplayTextArgs): void {
    const args: DisplayTextArgs = typeof textOrArgs === "string" ? {text: textOrArgs} : textOrArgs

    getBridge().send({
      type: "core_fn",
      payload: {
        fn: "displayText",
        args,
      },
    })
  }

  /**
   * Set the microphone state
   */
  setMicState(state: MicState): void
  setMicState(args: SetMicStateArgs): void
  setMicState(stateOrArgs: MicState | SetMicStateArgs): void {
    const args: SetMicStateArgs = typeof stateOrArgs === "string" ? {state: stateOrArgs} : stateOrArgs

    getBridge().send({
      type: "core_fn",
      payload: {
        fn: "setMicState",
        args,
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
