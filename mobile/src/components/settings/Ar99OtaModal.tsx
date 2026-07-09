import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {ActivityIndicator, Modal, Platform, TouchableOpacity, View} from "react-native"

import BluetoothSdk, {Ar99OtaStatusEvent} from "@mentra/bluetooth-sdk"
import {toolkit} from "@mentra/island"

import {Text} from "@/components/ignite"
import {
  Ar99VersionInfo,
  checkAr99OtaVersion,
  clearAr99OtaFiles,
  downloadAr99Firmware,
} from "@/services/ar99Ota"
import {useAppTheme} from "@/contexts/ThemeContext"

type OtaPhase =
  | "unsupported"
  | "checking"
  | "no_update"
  | "confirm"
  | "downloading"
  | "transferring"
  | "paused"
  | "success"
  | "failed"

interface Ar99OtaModalProps {
  visible: boolean
  onClose: () => void
}

const DEVICE_INFO_WAIT_MS = 5000
const DEVICE_INFO_POLL_MS = 250

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function readAr99DeviceInfo() {
  const info = toolkit.glasses.info()
  return {
    firmwareVersion: info.firmwareVersion.trim(),
    serialNumber: info.serialNumber.trim(),
  }
}

async function waitForAr99DeviceInfo() {
  const deadline = Date.now() + DEVICE_INFO_WAIT_MS
  let info = readAr99DeviceInfo()
  while ((!info.firmwareVersion || !info.serialNumber) && Date.now() < deadline) {
    await sleep(DEVICE_INFO_POLL_MS)
    info = readAr99DeviceInfo()
  }
  return info
}

export function Ar99OtaModal({visible, onClose}: Ar99OtaModalProps) {
  const {theme} = useAppTheme()
  const [phase, setPhase] = useState<OtaPhase>("checking")
  const [progress, setProgress] = useState(0)
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [currentVersion, setCurrentVersion] = useState("")
  const [serialNumber, setSerialNumber] = useState("")
  const [versionInfo, setVersionInfo] = useState<Ar99VersionInfo | null>(null)
  const [errorMessage, setErrorMessage] = useState("")
  const filePathRef = useRef<string | null>(null)

  const busy = phase === "checking" || phase === "downloading" || phase === "transferring" || phase === "paused"
  const forceUpdate = versionInfo?.forceUpdate === true
  const canDismiss = !busy

  const cleanupDownloadedFile = useCallback(async () => {
    filePathRef.current = null
    await clearAr99OtaFiles().catch(() => {})
  }, [])

  const checkVersion = useCallback(async () => {
    if (Platform.OS !== "android") {
      setPhase("unsupported")
      setProgress(0)
      setOffset(0)
      setTotal(0)
      setErrorMessage("")
      setVersionInfo(null)
      return
    }
    setPhase("checking")
    setProgress(0)
    setOffset(0)
    setTotal(0)
    setErrorMessage("")
    setVersionInfo(null)
    try {
      void toolkit.glasses.requestVersionInfo().catch((error) => {
        console.warn("AR99 OTA: requestVersionInfo failed; using cached device info", error)
      })
      const {firmwareVersion, serialNumber: sn} = await waitForAr99DeviceInfo()
      setCurrentVersion(firmwareVersion)
      setSerialNumber(sn)
      if (!firmwareVersion || !sn) {
        throw new Error("AR99 device information is not ready.")
      }
      const result = await checkAr99OtaVersion(firmwareVersion, sn)
      setVersionInfo(result)
      setPhase(result.hasUpdate ? "confirm" : "no_update")
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to check firmware update.")
      setPhase("failed")
    }
  }, [])

  useEffect(() => {
    if (visible) {
      void checkVersion()
    }
  }, [checkVersion, visible])

  useEffect(() => {
    if (!visible) return
    const subscription = BluetoothSdk.addListener("ar99_ota_status", async (event: Ar99OtaStatusEvent) => {
      const nativePhase = event.phase
      if (nativePhase === "transferring" || nativePhase === "preparing") {
        setPhase("transferring")
        setProgress(event.progress ?? 0)
        setOffset(event.offset ?? 0)
        setTotal(event.total ?? 0)
      } else if (nativePhase === "paused") {
        setPhase("paused")
        setProgress((current) => event.progress ?? current)
        setOffset(event.offset ?? 0)
        setTotal(event.total ?? 0)
      } else if (nativePhase === "success") {
        setProgress(100)
        setOffset(event.total ?? event.offset ?? 0)
        setTotal(event.total ?? 0)
        if (versionInfo?.currentVersion) {
          setCurrentVersion(versionInfo.currentVersion)
        }
        setPhase("success")
        await cleanupDownloadedFile()
      } else if (nativePhase === "failed" || nativePhase === "cancelled") {
        setOffset(event.offset ?? 0)
        setTotal(event.total ?? 0)
        setErrorMessage(event.errorMessage || event.error_message || "AR99 OTA failed.")
        setPhase("failed")
        await cleanupDownloadedFile()
      }
    })
    return () => subscription.remove()
  }, [cleanupDownloadedFile, versionInfo?.currentVersion, visible])

  const startUpgrade = useCallback(async () => {
    if (!versionInfo?.firmwareUrl) return
    setErrorMessage("")
    try {
      setPhase("downloading")
      setProgress(0)
      setOffset(0)
      setTotal(0)
      const path = await downloadAr99Firmware(
        versionInfo.firmwareUrl,
        versionInfo.currentVersion,
        versionInfo.fileMd5,
        setProgress,
      )
      filePathRef.current = path
      setPhase("transferring")
      setProgress(0)
      setOffset(0)
      setTotal(0)
      const started = await BluetoothSdk.startAr99OtaFromFile(path)
      if (!started) {
        throw new Error("Unable to start AR99 OTA.")
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Firmware update failed.")
      setPhase("failed")
      await cleanupDownloadedFile()
    }
  }, [cleanupDownloadedFile, versionInfo])

  const close = useCallback(() => {
    if (!canDismiss) return
    onClose()
  }, [canDismiss, onClose])

  const title = useMemo(() => {
    switch (phase) {
      case "checking":
        return "Checking firmware"
      case "unsupported":
        return "Firmware update unavailable"
      case "no_update":
        return "Firmware is up to date"
      case "confirm":
        return "Firmware update available"
      case "downloading":
        return "Downloading firmware"
      case "transferring":
        return "Updating AR99"
      case "paused":
        return "Waiting for reconnect"
      case "success":
        return "Update complete"
      case "failed":
        return "Update failed"
    }
  }, [phase])

  const progressDetail = useMemo(() => {
    if (phase === "downloading") {
      return "Downloading firmware package"
    }
    if ((phase === "transferring" || phase === "paused") && total > 0) {
      return `${formatBytes(offset)} / ${formatBytes(total)}`
    }
    if (phase === "paused") {
      return "Waiting for glasses to reconnect"
    }
    return ""
  }, [offset, phase, total])

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View className="flex-1 justify-center px-6" style={{backgroundColor: "rgba(0,0,0,0.45)"}}>
        <View className="rounded-2xl bg-background p-5" style={{gap: theme.spacing.s4}}>
          <Text className="text-lg font-semibold text-foreground" text={title} />

          {phase === "checking" && <ActivityIndicator color={theme.colors.foreground} />}

          {phase === "unsupported" && (
            <Text className="text-sm text-muted-foreground" text="AR99 firmware update is only supported on Android." />
          )}

          {phase === "no_update" && (
            <Text className="text-sm text-muted-foreground" text={`Current version: ${currentVersion || "--"}`} />
          )}

          {phase === "confirm" && versionInfo && (
            <View style={{gap: theme.spacing.s2}}>
              <Text className="text-sm text-secondary-foreground" text={`Current: ${currentVersion || "--"}`} />
              <Text className="text-sm text-secondary-foreground" text={`Latest: ${versionInfo.currentVersion || "--"}`} />
              {!!serialNumber && <Text className="text-xs text-muted-foreground" text={`SN: ${serialNumber}`} />}
              {!!versionInfo.changeLog && (
                <Text className="text-sm text-muted-foreground" text={versionInfo.changeLog.trim()} />
              )}
            </View>
          )}

          {(phase === "downloading" || phase === "transferring" || phase === "paused") && (
            <View style={{gap: theme.spacing.s2}}>
              <View
                className="h-2 w-full overflow-hidden rounded-full"
                style={{backgroundColor: theme.colors.border}}>
                <View
                  className="h-2 rounded-full"
                  style={{
                    backgroundColor: theme.colors.primary,
                    width: `${Math.max(0, Math.min(100, progress))}%`,
                  }}
                />
              </View>
              <Text className="text-sm text-muted-foreground" text={`${Math.max(0, Math.min(100, progress))}%`} />
              {!!progressDetail && <Text className="text-sm text-muted-foreground" text={progressDetail} />}
              {phase === "paused" && (
                <Text className="text-sm text-muted-foreground" text="Keep the app open and reconnect the glasses." />
              )}
            </View>
          )}

          {phase === "success" && <Text className="text-sm text-muted-foreground" text="The AR99 firmware update finished." />}

          {phase === "failed" && <Text className="text-sm text-destructive" text={errorMessage || "Firmware update failed."} />}

          <View className="flex-row justify-end gap-3">
            {phase === "confirm" && canDismiss && (
              <ModalButton label={forceUpdate ? "Close" : "Later"} onPress={close} muted />
            )}
            {phase === "confirm" && <ModalButton label="Upgrade" onPress={startUpgrade} />}
            {phase === "no_update" && <ModalButton label="Done" onPress={close} />}
            {phase === "unsupported" && <ModalButton label="Done" onPress={close} />}
            {phase === "success" && <ModalButton label="Done" onPress={close} />}
            {phase === "failed" && <ModalButton label="Retry" onPress={checkVersion} muted />}
            {phase === "failed" && canDismiss && <ModalButton label="Close" onPress={close} />}
          </View>
        </View>
      </View>
    </Modal>
  )
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function ModalButton({label, muted = false, onPress}: {label: string; muted?: boolean; onPress: () => void}) {
  const {theme} = useAppTheme()
  return (
    <TouchableOpacity
      className="rounded-full px-4 py-2"
      onPress={onPress}
      style={{backgroundColor: muted ? theme.colors.muted : theme.colors.foreground}}>
      <Text className={muted ? "text-foreground text-sm" : "text-background text-sm"} text={label} />
    </TouchableOpacity>
  )
}
