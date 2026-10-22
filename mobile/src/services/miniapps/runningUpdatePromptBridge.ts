import {engine, type PendingRunningUpdatePrompt, type RunningUpdateFailure} from "@mentra/engine"
import {createElement, type ReactNode} from "react"
import Toast from "react-native-toast-message"

import AppIcon from "@/components/home/AppIcon"
import {showAlert, waitForAlertHost, type AlertButton} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

/** The miniapp's icon, as the board draws it above "Update <name>?". Without one the sheet shows no icon. */
function miniappIcon(packageName: string): ReactNode {
  const app = engine.miniapps.list().find((candidate) => candidate.packageName === packageName)
  return app
    ? createElement(AppIcon, {app, style: {width: 56, height: 56, borderRadius: 13}, disableLoader: true})
    : undefined
}

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
      options: {icon: miniappIcon(prompt.packageName), allowDismiss: true},
    })
    // Anything but the Update button (Not now, a swipe, no answer) is Not now.
    answer = choices[index]?.role === "update" ? "update" : "not_now"
  } finally {
    prompt.answer(answer)
  }
}

/** An accepted update failed and the miniapp is back on its installed version: a toast, as the spec words it. */
export function presentRunningUpdateFailure(failure: RunningUpdateFailure): void {
  Toast.show({
    type: "error",
    text1: translate("fleet:updateFailed", {name: failure.displayName, version: failure.installedVersion}),
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
