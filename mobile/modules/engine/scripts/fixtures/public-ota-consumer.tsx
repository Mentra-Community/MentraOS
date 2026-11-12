import React from "react"
import {PermissionsAndroid, Platform, Pressable, Text, View} from "react-native"

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

// Pairing: the docs' examples (bluetooth-sdk/pairing.mdx) and a fully custom flow over the hook.
type PairMentraLiveProps = {
  onDone: () => void
  onLeave: () => void
}

export function PairMentraLive({onDone, onLeave}: PairMentraLiveProps) {
  return <MentraLivePairingFlow initialPage="prep" onExit={onLeave} onFinished={onDone} />
}

async function requestBluetoothPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true
  // Android 12 added Bluetooth permissions; older versions scan with location.
  const permissions =
    Number(Platform.Version) >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
  const results = await PermissionsAndroid.requestMultiple(permissions)
  return Object.values(results).every((result) => result === PermissionsAndroid.RESULTS.GRANTED)
}

export function BrandedPairMentraLive({onDone, onLeave}: PairMentraLiveProps) {
  return (
    <MentraLivePairingFlow
      initialPage="prep"
      onExit={onLeave}
      onFinished={onDone}
      prepareScan={requestBluetoothPermissions}
      theme={{background: "#FFFFFF", foreground: "#111111", primary: "#0057FF", buttonBackground: "#0057FF"}}
    />
  )
}

function ScanPage({state, controller}: MentraLivePairingPageProps<"scan">) {
  return (
    <View>
      {state.glasses.map((glasses: MentraLivePairingGlasses) => (
        <Pressable key={glasses.id} onPress={() => controller.select(glasses)}>
          <Text>Mentra Live {glasses.label}</Text>
        </Pressable>
      ))}
      {!state.scanning && (
        <Pressable onPress={controller.scanAgain}>
          <Text>Scan again</Text>
        </Pressable>
      )}
      <Pressable onPress={controller.back}>
        <Text>Cancel</Text>
      </Pressable>
    </View>
  )
}

const pairingPages: MentraLivePairingPageOverrides = {scan: ScanPage}

export function PairMentraLiveWithOwnScan({onDone, onLeave}: PairMentraLiveProps) {
  const pairing = useMentraLivePairing({onExit: onLeave, onFinished: onDone})
  return <MentraLivePairingPages controller={pairing} pages={pairingPages} />
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
