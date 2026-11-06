import React from "react"

import {
  MentraLiveOtaFlow,
  useMentraLiveOta,
  type MentraLiveOtaController,
  type MentraLiveOtaScreen,
} from "@mentra/engine/ota"
import {otaLocalNetwork, otaServer} from "@mentra/engine/bluetooth-sdk/ota-transport"
import {
  MentraLivePairingFlow,
  MentraLivePairingPages,
  useMentraLivePairing,
  type MentraLivePairingController,
  type MentraLivePairingGlasses,
  type MentraLivePairingPageOverrides,
  type MentraLivePairingPageProps,
  type MentraLivePairingState,
} from "@mentra/engine/pairing"

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
    case "battery_required":
      return "Charge required"
    case "wifi_required":
      return "Wi-Fi required"
    case "up_to_date":
      return "Up to date"
    case "dev_build":
    case "unofficial_client":
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
  const completionLabel = controller.state.completedUpdate ? "Updated" : ""
  return React.createElement(React.Fragment, null, screenLabel(controller.state.screen), releaseLabel, completionLabel)
}

// Prove the curated low-level transport types resolve without a private import.
export const lowLevelOtaTransportAvailability = () => ({
  localNetwork: otaLocalNetwork.isAvailable(),
  stopServer: otaServer.stop,
})

// Pairing: the stock flow, one page replaced, and a fully custom flow over the hook.
export function StockPairingConsumer({onDone, onLeave}: {onDone: () => void; onLeave: () => void}) {
  return <MentraLivePairingFlow initialPage="prep" onExit={onLeave} onFinished={onDone} />
}

const pairingPages: MentraLivePairingPageOverrides = {
  scan: ({state, controller}: MentraLivePairingPageProps<"scan">) =>
    React.createElement(
      React.Fragment,
      null,
      state.glasses.map((glasses: MentraLivePairingGlasses) => glasses.label).join(", "),
      state.scanning ? null : String(controller.scanAgain),
    ),
}

export function OverriddenPairingConsumer({onDone, onLeave}: {onDone: () => void; onLeave: () => void}) {
  const controller = useMentraLivePairing({onExit: onLeave, onFinished: onDone})
  return <MentraLivePairingPages controller={controller} pages={pairingPages} />
}

function pairingLabel(state: MentraLivePairingState): string {
  switch (state.page) {
    case "prep":
      return "Power on"
    case "scan":
      return `${state.status}: ${state.glasses.length}`
    case "connecting":
      return `Pairing ${state.device.name}${state.booting ? " (booting)" : ""}`
    case "pair_audio":
      return `Pair audio for ${state.deviceName}`
    case "forget_ios_pairing":
      return `Forget ${state.deviceName}`
    case "success":
      return "Paired"
    case "failure":
      return state.error
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

export function CustomPairingConsumer({onDone, onLeave}: {onDone: () => void; onLeave: () => void}) {
  const controller: MentraLivePairingController = useMentraLivePairing({
    initialPage: "scan",
    onExit: onLeave,
    onFinished: onDone,
  })
  return React.createElement(React.Fragment, null, pairingLabel(controller.state))
}
