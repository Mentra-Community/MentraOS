import {useEffect} from "react"

import {installRunningUpdatePromptBridge} from "@/services/miniapps/runningUpdatePromptBridge"

/** Shows the engine's "Update {name}?" prompts for running miniapps and their failure notices. */
export function RunningUpdatePrompt() {
  useEffect(() => installRunningUpdatePromptBridge(), [])
  return null
}
