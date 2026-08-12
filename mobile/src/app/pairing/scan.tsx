import BluetoothSdk, {type Device, type DeviceModel} from "@mentra/bluetooth-sdk"
import {engine} from "@mentra/engine"
import {useLocalSearchParams} from "expo-router"
import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {ActivityIndicator, Image, Platform, ScrollView, TouchableOpacity, View} from "react-native"

import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Icon, Button, Header, Screen, Text} from "@/components/ignite"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import Divider from "@/components/ui/Divider"
import {Group} from "@/components/ui/Group"
import GlassView from "@/components/ui/GlassView"
import {focusEffectPreventBack, usePushUnder} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"
import {routePairingKickoffFailure} from "@/utils/PairingUtils"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {AR99_MODEL_OPTIONS, getAr99DisplayName, getAr99ImageSource, getGlassesOpenImage} from "@/utils/getGlassesImage"

const normalizeProjectName = (value?: string | null) => value?.trim().toUpperCase() ?? ""
const SUPPORTED_AR99_PROJECT_NAMES = new Set<string>(AR99_MODEL_OPTIONS.map((option) => option.projectName))

const PAIRING_SCAN_TIMEOUT_MS = 15_000

export default function SelectGlassesBluetoothScreen() {
  const {deviceModel, ar99ProjectName} = useLocalSearchParams() as {deviceModel: DeviceModel; ar99ProjectName?: string}
  const {theme} = useAppTheme()
  const {goBack, replace, push} = useNavigationStore.getState()
  const pushUnder = usePushUnder()
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const bluetoothClassicConnected = useEngineSnapshot(engine.pairing.readiness, (onChange) =>
    engine.pairing.onReadiness(onChange),
  ).bluetoothClassicConnected
  const searchResults = useEngineSnapshot(engine.pairing.searchResults, (onChange) =>
    engine.pairing.onFound(onChange),
  )
  const [rememberedSearchResults, setRememberedSearchResults] = useState<Device[]>(searchResults)
  const [scanTimedOut, setScanTimedOut] = useState(false)
  const connectingRef = useRef(false)
  const scanGenerationRef = useRef(0)
  const [scanGeneration, setScanGeneration] = useState(0)
  const isMentraLivePairingScan = deviceModel === DeviceTypes.LIVE

  const selectedDisplayName = useMemo(() => {
    return deviceModel === DeviceTypes.AR99 ? getAr99DisplayName(ar99ProjectName) : deviceModel
  }, [ar99ProjectName, deviceModel])

  const selectedImage = useMemo(() => {
    return deviceModel === DeviceTypes.AR99 ? getAr99ImageSource(ar99ProjectName) : getGlassesOpenImage(deviceModel)
  }, [ar99ProjectName, deviceModel])

  const matchesSelectedModel = useCallback(
    (result: Device) => {
      if (deviceModel !== DeviceTypes.AR99) {
        return result.model === deviceModel
      }
      if (result.model !== DeviceTypes.AR99) return false

      const resultProjectName = normalizeProjectName(result.projectName)
      if (!SUPPORTED_AR99_PROJECT_NAMES.has(resultProjectName)) return false

      const selectedProjectName = normalizeProjectName(ar99ProjectName)
      if (!selectedProjectName) return false
      return resultProjectName === selectedProjectName
    },
    [ar99ProjectName, deviceModel],
  )

  useEffect(() => {
    // Two-phase identity: reaching the scan screen marks the chosen model as the
    // PENDING selection. Promotion to `paired` only happens natively when pairing
    // succeeds; until then the home card renders a finish-pairing affordance.
    engine.pairing.markPendingSelection(deviceModel)
  }, [deviceModel])

  const backOutRanRef = useRef(false)
  const runBackOutCleanup = () => {
    if (backOutRanRef.current) return false
    backOutRanRef.current = true
    // Non-destructive back-out: abandonAttempt decides from the LIVE hydrated
    // default-device read — a re-pair's existing pairing survives, and so does
    // a pairing that PROMOTED while this flow was open (glasses can finish
    // pairing even when the user backs out of the UI). Only a genuinely
    // unpaired attempt forgets. The pending marker survives either way.
    void engine.pairing.abandonAttempt().catch((error) => {
      console.warn("Pairing scan back-out cleanup failed:", error)
    })
    return true
  }

  focusEffectPreventBack((event) => {
    if (event && event.actionType !== "GO_BACK" && event.actionType !== "POP") {
      return
    }
    if (runBackOutCleanup()) {
      goBack()
    }
  }, true)

  const handleBackOut = () => {
    if (runBackOutCleanup()) {
      goBack()
    }
  }

  const startScanAttempt = useCallback(async () => {
    const generation = scanGenerationRef.current + 1
    scanGenerationRef.current = generation
    setScanGeneration(generation)
    connectingRef.current = false
    setScanTimedOut(false)
    setRememberedSearchResults([])
    try {
      await engine.pairing.scan(deviceModel)
    } catch (error) {
      if (generation === scanGenerationRef.current) {
        console.error("Failed to start glasses scan:", error)
      }
    }
  }, [deviceModel])

  const visibleResults = useMemo(
    () => rememberedSearchResults.filter((r) => r.name !== "NOTREQUIREDSKIP" && matchesSelectedModel(r)),
    [rememberedSearchResults, matchesSelectedModel],
  )

  // Secure Mentra Live ads with pairingMode=false are nearby but not pairable yet.
  // Legacy firmware (no secure flag) stays pairable even when pairingMode is unset/false.
  const isLivePairable = (device: Device) =>
    device.pairingMode !== false || device.securePairingCapable === false

  useEffect(() => {
    void startScanAttempt()
  }, [startScanAttempt])

  useEffect(() => {
    const skipDevice = searchResults.find((result) => result.name === "NOTREQUIREDSKIP")
    if (skipDevice) {
      void triggerGlassesPairingGuide(skipDevice)
    }
    // triggerGlassesPairingGuide is intentionally not memoized; run only when results change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchResults])

  const pairableResults = useMemo(
    () => visibleResults.filter((device) => isLivePairable(device)),
    [visibleResults],
  )
  const hasNearbyNotInPairingMode = useMemo(
    () =>
      isMentraLivePairingScan &&
      visibleResults.some((device) => device.pairingMode === false && device.securePairingCapable !== false),
    [isMentraLivePairingScan, visibleResults],
  )

  useEffect(() => {
    // Timeout only when no pairable Mentra Live appeared; non-pairing nearby units still count
    // as "seen" for the empty-state hint but must not auto-connect.
    if (!isMentraLivePairingScan || scanTimedOut || pairableResults.length > 0) {
      return
    }

    const generation = scanGeneration
    const timer = setTimeout(() => {
      if (generation !== scanGenerationRef.current || connectingRef.current) {
        return
      }
      setScanTimedOut(true)
      void BluetoothSdk.stopScan()
    }, PAIRING_SCAN_TIMEOUT_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [isMentraLivePairingScan, pairableResults.length, scanGeneration, scanTimedOut])

  const triggerGlassesPairingGuide = async (device: Device) => {
    if (isMentraLivePairingScan && !isLivePairable(device)) {
      showAlert(
        translate("pairing:notInPairingModeAlertTitle"),
        translate("pairing:notInPairingModeAlertMessage"),
        [{text: "OK"}],
      )
      return
    }

    if (Platform.OS === "android") {
      const hasLocationPermission = await requestFeaturePermissions(PermissionFeatures.LOCATION)
      if (!hasLocationPermission) {
        // Leave the auto-connect spinner and expose the in-place retry controls.
        connectingRef.current = false
        setScanTimedOut(true)
        void BluetoothSdk.stopScan()
        showAlert(
          "Location Permission Required",
          "Location permission is required to scan for and connect to smart glasses on Android. This is a requirement of the Android Bluetooth system.",
          [{text: "OK"}],
        )
        return
      }
    }

    const hasMicPermission = await requestFeaturePermissions(PermissionFeatures.MICROPHONE)
    if (!hasMicPermission) {
      connectingRef.current = false
      setScanTimedOut(true)
      void BluetoothSdk.stopScan()
      showAlert(
        "Microphone Permission Required",
        "Microphone permission is required to connect to smart glasses. Voice control and audio features are essential for the AR experience.",
        [{text: "OK"}],
      )
      return
    }

    await startPairing(device)
  }

  const startPairing = async (device: Device) => {
    const deviceTypesWithBtClassic = [DeviceTypes.LIVE]
    const resolvedProjectName = deviceModel === DeviceTypes.AR99 ? device.projectName ?? ar99ProjectName : undefined
    if (Platform.OS === "android" || bluetoothClassicConnected || !deviceTypesWithBtClassic.includes(device.model as DeviceTypes)) {
      setTimeout(() => {
        engine.pairing.pair(device).catch((error) => {
          console.error("Failed to connect to glasses:", error)
          routePairingKickoffFailure(device.model)
        })
      }, 2000)
      push("/pairing/loading", {
        deviceModel: device.model,
        deviceName: device.name,
        ar99ProjectName: resolvedProjectName,
        securePairingCapable: device.securePairingCapable,
      })
      return
    }

    replace("/pairing/btclassic", {device: JSON.stringify(device)})
    pushUnder("/pairing/loading", {
      deviceModel: device.model,
      deviceName: device.name,
      ar99ProjectName: resolvedProjectName,
      securePairingCapable: device.securePairingCapable,
    })
  }

  const filterDeviceName = (deviceName: string) => {
    let newName = deviceName.replace("MENTRA_LIVE_BLE_", "")
    newName = newName.replace("MENTRA_LIVE_BT_", "")
    newName = newName.replace("Mentra_Live_", "")
    newName = newName.replace("MENTRA_LIVE_", "")
    newName = newName.replace("MENTRA_DISPLAY_", "")
    return newName
  }

  const getAr99ResultDisplayName = (device: Device) => getAr99DisplayName(device.projectName ?? ar99ProjectName)

  const formatAr99Subtitle = (device: Device) => {
    const rawName = filterDeviceName(device.name)
    const normalizedProjectName = normalizeProjectName(device.projectName ?? ar99ProjectName)
    const deviceDisplayName = getAr99ResultDisplayName(device)

    if (normalizedProjectName === "AR99") {
      const serial = rawName.replace(/^SN:\s*/i, "").trim()
      return `${deviceDisplayName}-${serial || rawName}`
    }

    return rawName
  }

  const formatLiveSubtitle = (device: Device) => {
    const base = filterDeviceName(device.name)
    const parts: string[] = [base]
    if (device.pairingCode) {
      parts.push(translate("pairing:pairingCodeLabel", {code: device.pairingCode}))
    }
    if (device.securePairingCapable === false) {
      parts.push(translate("pairing:legacyFirmwareLabel"))
    } else if (device.pairingMode === false) {
      parts.push(translate("pairing:notInPairingModeLabel"))
    }
    return parts.join(" · ")
  }

  useEffect(() => {
    setRememberedSearchResults((prev) => {
      const combined = [...prev]
      for (const result of searchResults) {
        if (!matchesSelectedModel(result)) {
          continue
        }
        const existingIndex = combined.findIndex((r) => r.id === result.id)
        if (existingIndex >= 0) {
          combined[existingIndex] = result
        } else {
          combined.push(result)
        }
      }
      return combined
    })
  }, [searchResults, matchesSelectedModel])

  useEffect(() => {
    if (!isMentraLivePairingScan || scanTimedOut || connectingRef.current || visibleResults.length !== 1) {
      return
    }
    if (!isLivePairable(visibleResults[0])) {
      return
    }

    connectingRef.current = true
    void triggerGlassesPairingGuide(visibleResults[0])
  }, [isMentraLivePairingScan, scanTimedOut, visibleResults])

  const handleTryAgain = () => {
    // Restart scan in place — do not pop back to prep.
    void startScanAttempt()
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header leftIcon="chevron-left" onLeftPress={handleBackOut} RightActionComponent={<MentraLogoStandalone />} />
      <View className="flex-1 justify-center">
        <GlassView className="gap-6 rounded-3xl p-6 bg-primary-foreground" transparent={false}>
          <Image source={selectedImage} className="h-[90px] w-[156px] mx-auto" resizeMode="contain" />
          <Text
            className="text-center text-xl font-semibold text-text-dim"
            text={
              scanTimedOut
                ? translate("pairing:noGlassesFound")
                : translate("pairing:scanningForGlassesModel", {model: selectedDisplayName})
            }
          />

          {scanTimedOut ? (
            <View className="gap-4 py-4">
              <Text
                className="text-center text-sm text-muted-foreground"
                tx={
                  hasNearbyNotInPairingMode
                    ? "pairing:nearbyNotInPairingModeHint"
                    : "pairing:noGlassesFoundHint"
                }
              />
              {visibleResults.length > 0 ? (
                <ScrollView className="max-h-[220px] -mr-4 pr-4" contentContainerClassName="my-2">
                  <Group>
                    {visibleResults.map((res: Device) => {
                      const deviceTitle =
                        deviceModel === DeviceTypes.AR99 ? getAr99ResultDisplayName(res) : selectedDisplayName
                      const deviceSubtitle = isMentraLivePairingScan
                        ? formatLiveSubtitle(res)
                        : filterDeviceName(res.name)
                      return (
                        <View
                          key={res.id}
                          className="flex-row items-center justify-between px-4 py-3 bg-primary-foreground">
                          <TouchableOpacity className="flex-1" onPress={() => triggerGlassesPairingGuide(res)}>
                            <View className="flex-1 px-2.5 flex-col">
                              <Text text={deviceTitle} className="flex-wrap text-sm font-semibold" numberOfLines={2} />
                              <Text text={deviceSubtitle} className="text-xs text-muted-foreground" numberOfLines={2} />
                            </View>
                          </TouchableOpacity>
                          <Icon name="chevron-right" size={24} color={theme.colors.text} />
                        </View>
                      )
                    })}
                  </Group>
                </ScrollView>
              ) : null}
              <Button preset="primary" tx="pairing:tryAgain" onPress={handleTryAgain} className="w-full" />
            </View>
          ) : visibleResults.length === 0 ||
            (isMentraLivePairingScan && visibleResults.length === 1 && isLivePairable(visibleResults[0])) ? (
            <View className="justify-center min-h-20 py-4">
              <ActivityIndicator size="large" color={theme.colors.foreground} />
            </View>
          ) : (
            <ScrollView className="max-h-[300px] -mr-4 pr-4" contentContainerClassName="my-4">
              <Group>
                {visibleResults.map((res: Device) => {
                  const deviceTitle = deviceModel === DeviceTypes.AR99 ? getAr99ResultDisplayName(res) : selectedDisplayName
                  const deviceSubtitle =
                    deviceModel === DeviceTypes.AR99
                      ? formatAr99Subtitle(res)
                      : isMentraLivePairingScan
                        ? formatLiveSubtitle(res)
                        : filterDeviceName(res.name)
                  return (
                    <View key={res.id} className="flex-row items-center justify-between px-4 py-3 bg-primary-foreground">
                      <TouchableOpacity className="flex-1" onPress={() => triggerGlassesPairingGuide(res)}>
                        <View className="flex-1 px-2.5 flex-col">
                          <Text text={deviceTitle} className="flex-wrap text-sm font-semibold" numberOfLines={2} />
                          <Text text={deviceSubtitle} className="text-xs text-muted-foreground" numberOfLines={2} />
                        </View>
                      </TouchableOpacity>
                      <Icon name="chevron-right" size={24} color={theme.colors.text} />
                    </View>
                  )
                })}
              </Group>
            </ScrollView>
          )}
          {!scanTimedOut && (
            <>
              <Divider />
              <View className="flex-row justify-end">
                <Button preset="primary" compact tx="common:cancel" onPress={handleBackOut} className="min-w-[100px]" />
              </View>
            </>
          )}
        </GlassView>
      </View>
      <Button
        preset="secondary"
        tx="pairing:needMoreHelp"
        onPress={() => setShowTroubleshootingModal(true)}
        className="w-full"
      />
      <GlassesTroubleshootingModal
        isVisible={showTroubleshootingModal}
        onClose={() => setShowTroubleshootingModal(false)}
        deviceModel={deviceModel}
      />
    </Screen>
  )
}
