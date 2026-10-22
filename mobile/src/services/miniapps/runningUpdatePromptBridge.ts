import {engine, type PendingRunningUpdatePrompt, type RunningUpdateFailure} from "@mentra/engine"

import {showAlert, waitForAlertHost, type AlertButton} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

type PromptChoice = "update" | "not_now"

/**
 * "Update {name}?" for a running miniapp: the Mentra App's standard alert sheet, with Update on top and
 * Not now below as the cancel button, so a swipe, a tap outside and Android back all mean Not now.
 *
 * The sheet answers with the index of the pressed button in this list, and lays the buttons out by their
 * style, not their position. So each button carries its role, and the answer is read through the role: the
 * order of this list and of the sheet can change without Update and Not now swapping.
 */
export async function presentRunningUpdatePrompt(prompt: PendingRunningUpdatePrompt): Promise<void> {
  const choices: Array<{role: PromptChoice; button: AlertButton}> = [
    {role: "not_now", button: {text: translate("fleet:updatePromptNotNow"), style: "cancel"}},
    {role: "update", button: {text: translate("fleet:updatePromptUpdate")}},
  ]
  let answer: PromptChoice = "not_now"
  try {
    // At startup the sheet isn't mounted yet; a system alert would be the wrong surface, and showing
    // nothing would answer Not now for a prompt the user never saw.
    await waitForAlertHost()
    const index = await showAlert({
      title: translate("fleet:updatePromptTitle", {name: prompt.displayName}),
      message: translate("fleet:updatePromptMessage", {name: prompt.displayName}),
      buttons: choices.map(({button}) => button),
      options: {allowDismiss: true},
    })
    // Anything but the Update button (Not now, a swipe, no answer) is Not now.
    answer = choices[index]?.role === "update" ? "update" : "not_now"
  } finally {
    prompt.answer(answer)
  }
}

/** An accepted update failed and the miniapp is back on its installed version. */
export async function presentRunningUpdateFailure(failure: RunningUpdateFailure): Promise<void> {
  await waitForAlertHost()
  await showAlert({
    title: translate("fleet:updateFailedTitle", {name: failure.displayName}),
    message: translate("fleet:updateFailedMessage", {version: failure.installedVersion}),
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
