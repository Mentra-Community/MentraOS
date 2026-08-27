import React from "react"

import {
  MentraLiveOtaFlow,
  useMentraLiveOta,
  type MentraLiveOtaController,
  type MentraLiveOtaScreen,
} from "@mentra/engine/ota"
import {otaLocalNetwork, otaServer} from "@mentra/engine/bluetooth-sdk/ota-transport"

export function StockOtaConsumer({onDone, onSetupWifi}: {onDone: () => void; onSetupWifi: () => void}) {
  return <MentraLiveOtaFlow onFinished={onDone} onOpenWifiSetup={onSetupWifi} />
}

function screenLabel(screen: MentraLiveOtaScreen): string {
  switch (screen) {
    case "initializing":
    case "checking":
      return "Checking"
    case "finishing":
      return "Finishing update"
    case "update_available":
      return "Update available"
    case "wifi_required":
      return "Wi-Fi required"
    case "up_to_date":
      return "Up to date"
    case "dev_build":
      return "OTA disabled"
    case "check_failed":
    case "update_info_unavailable":
    case "failed":
      return "Update failed"
    case "starting":
    case "preparing_hotspot":
      return "Preparing"
    case "updating":
      return "Updating"
    case "restarting":
      return "Restarting"
    case "verifying":
      return "Verifying"
    case "complete":
      return "Complete"
    case "disconnected":
      return "Reconnecting"
    default: {
      const exhaustive: never = screen
      return exhaustive
    }
  }
}

export function customActions(controller: MentraLiveOtaController) {
  return {
    check: controller.check,
    discard: controller.discard,
    finish: controller.finish,
    install: controller.install,
    openWifiSetup: controller.openWifiSetup,
    retryCheck: controller.retryCheck,
    retryInstall: controller.retryInstall,
  }
}

export function CustomOtaConsumer({onDone, onSetupWifi}: {onDone: () => void; onSetupWifi: () => void}) {
  const controller = useMentraLiveOta({onFinished: onDone, onOpenWifiSetup: onSetupWifi})
  const transition = controller.state.releaseTransition
  const releaseLabel = transition ? `${transition.fromVersion ?? "Unknown"} → ${transition.toVersion}` : ""
  return React.createElement(React.Fragment, null, screenLabel(controller.state.screen), releaseLabel)
}

// Prove the curated low-level transport types resolve without a private import.
export const lowLevelOtaTransportAvailability = () => ({
  localNetwork: otaLocalNetwork.isAvailable(),
  stopServer: otaServer.stop,
})
