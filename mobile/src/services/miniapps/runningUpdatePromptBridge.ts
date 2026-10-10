import {engine, type PendingRunningUpdatePrompt, type RunningUpdateFailure} from "@mentra/engine"

import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

const UPDATE_BUTTON_INDEX = 1

/** "Update {name}?" for a running miniapp. Anything but Update (including a dismissal) is "Not now". */
export async function presentRunningUpdatePrompt(prompt: PendingRunningUpdatePrompt): Promise<void> {
  let choice = -1
  try {
    choice = await showAlert({
      title: translate("home:miniappUpdatePromptTitle", {name: prompt.displayName}),
      message: translate("home:miniappUpdatePromptMessage", {name: prompt.displayName, version: prompt.version}),
      buttons: [
        {text: translate("home:miniappUpdatePromptNotNow"), style: "cancel"},
        {text: translate("home:miniappUpdatePromptUpdate")},
      ],
      options: {allowDismiss: true},
    })
  } finally {
    prompt.answer(choice === UPDATE_BUTTON_INDEX ? "update" : "not_now")
  }
}

/** An accepted update failed and the miniapp is back on its installed version. */
export function presentRunningUpdateFailure(failure: RunningUpdateFailure): void {
  void showAlert({
    title: translate("home:miniappUpdateFailedTitle", {name: failure.displayName}),
    message: translate("home:miniappUpdateFailedMessage", {version: failure.installedVersion}),
    buttons: [{text: translate("common:ok")}],
  })
}

/** The Mentra App owns the running-miniapp update prompt. Returns an unsubscribe. */
export function installRunningUpdatePromptBridge(): () => void {
  const unsubscribePrompt = engine.miniapps.onUpdatePrompt((prompt) => {
    void presentRunningUpdatePrompt(prompt)
  })
  const unsubscribeFailure = engine.miniapps.onUpdateFailed(presentRunningUpdateFailure)
  return () => {
    unsubscribePrompt()
    unsubscribeFailure()
  }
}
