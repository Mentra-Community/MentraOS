import BluetoothSdk, {DeviceModels} from "@mentra/bluetooth-sdk"
import type {
  PhotoCaptureMetadata,
  PhotoRequestParams,
  PhotoSize,
  PhotoStatusEvent,
} from "@mentra/bluetooth-sdk"
import PhotoReceiver from "@mentra/bluetooth-sdk/photo-receiver"
import * as MediaLibrary from "expo-media-library"
import type {ReactNode} from "react"
import {useCallback, useEffect, useRef, useState} from "react"
// The SDK example intentionally uses plain React Native primitives outside the mobile app shell.
// eslint-disable-next-line no-restricted-imports
import {
  ActivityIndicator,
  Button,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native"

type TabId = "connection" | "camera"

const PHOTO_SIZE_OPTIONS: {key: PhotoSize; label: string}[] = [
  {key: "low", label: "Low (960×720)"},
  {key: "medium", label: "Medium (1440×1088)"},
  {key: "high", label: "High (3264×2448)"},
  {key: "max", label: "Max (4032×3024)"},
]

const SCAN_MODE_PRESET = {
  size: "max" as const,
  aeExposureDivisor: 3,
  isoCap: 800,
  noiseReduction: false,
  ispDigitalGain: 0,
  ispAnalogGain: "low" as const,
  edgeEnhancement: false,
  zsl: false,
  mfnr: false,
  compress: "none" as const,
  sound: false,
}

type CaptureResult = {
  fileUri: string
  byteCount: number
  requestId: string
  captureMetadata?: PhotoCaptureMetadata
  photoResponse?: Record<string, unknown>
}

export default function App() {
  const [tab, setTab] = useState<TabId>("camera")
  const [photoSize, setPhotoSize] = useState<PhotoSize>("max")
  const [scanMode, setScanMode] = useState(false)
  const [zsl, setZsl] = useState(true)
  const [mfnr, setMfnr] = useState(true)
  const [aeDivisor, setAeDivisor] = useState<3 | 5>(3)
  const [isoCap, setIsoCap] = useState(800)
  const [capturing, setCapturing] = useState(false)
  const [lastCapture, setLastCapture] = useState<CaptureResult | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const receiverStarted = useRef(false)
  const uploadUrlRef = useRef<string | null>(null)
  const pendingRequestId = useRef<string | null>(null)
  const metadataRef = useRef<PhotoCaptureMetadata | undefined>(undefined)
  const uploadedUriRef = useRef<string | null>(null)

  const scanFields = useCallback((): Partial<PhotoRequestParams> => {
    if (!scanMode) {
      return {size: "medium", compress: "none", sound: true, zsl, mfnr}
    }
    return {
      ...SCAN_MODE_PRESET,
      aeExposureDivisor: aeDivisor,
      isoCap,
      zsl,
      mfnr,
    }
  }, [scanMode, aeDivisor, isoCap, zsl, mfnr])

  useEffect(() => {
    const statusSub = BluetoothSdk.addListener("photo_status", (event: PhotoStatusEvent) => {
      if (pendingRequestId.current && event.requestId === pendingRequestId.current) {
        setStatusMessage(event.status)
        if (event.captureMetadata) {
          metadataRef.current = event.captureMetadata
        }
      }
    })
    const uploadSub = PhotoReceiver.addListener("photoUpload", event => {
      if (!pendingRequestId.current) return
      if (event.requestId && event.requestId !== pendingRequestId.current) return
      uploadedUriRef.current = event.fileUri
      setLastCapture({
        fileUri: event.fileUri,
        byteCount: event.byteCount,
        requestId: pendingRequestId.current,
        captureMetadata: metadataRef.current,
      })
    })
    return () => {
      statusSub.remove()
      uploadSub.remove()
    }
  }, [])

  const ensureReceiver = async () => {
    if (receiverStarted.current && uploadUrlRef.current) {
      return uploadUrlRef.current
    }
    const result = await PhotoReceiver.startPhotoReceiver()
    receiverStarted.current = true
    uploadUrlRef.current = result.uploadUrl
    return result.uploadUrl
  }

  const handlePhotoSizeChange = async (size: PhotoSize) => {
    await BluetoothSdk.setPhotoCaptureDefaults({size})
    setPhotoSize(size)
  }

  const pushScanButtonPreset = useCallback(async () => {
    await BluetoothSdk.setPhotoCaptureDefaults({
      size: "max",
      zsl: false,
      mfnr: false,
      noiseReduction: false,
      edgeEnhancement: false,
      ispDigitalGain: 0,
      ispAnalogGain: "low",
      aeExposureDivisor: aeDivisor,
      isoCap,
      compress: "none",
      sound: false,
    })
  }, [aeDivisor, isoCap])

  const handleScanModeChange = async (enabled: boolean) => {
    setScanMode(enabled)
    if (enabled) {
      setZsl(false)
      setMfnr(false)
      return
    }
    try {
      await BluetoothSdk.setPhotoCaptureDefaults({
        size: photoSize,
        zsl: true,
        mfnr: true,
        resetCaptureTuning: true,
      })
      setZsl(true)
      setMfnr(true)
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "failed to sync scan preset")
    }
  }

  useEffect(() => {
    if (!scanMode) {
      return
    }
    void pushScanButtonPreset().catch(err => {
      setStatusMessage(err instanceof Error ? err.message : "failed to sync scan preset")
    })
  }, [aeDivisor, isoCap, pushScanButtonPreset, scanMode])

  const handleTakePhoto = async () => {
    setCapturing(true)
    setStatusMessage("starting")
    metadataRef.current = undefined
    uploadedUriRef.current = null
    const requestId = `scan-${Date.now()}`
    pendingRequestId.current = requestId
    try {
      const webhookUrl = await ensureReceiver()
      const fields = scanFields()
      const response = await BluetoothSdk.requestPhoto({
        requestId,
        webhookUrl,
        authToken: null,
        ...fields,
        size: fields.size ?? "medium",
        compress: fields.compress ?? "none",
        sound: fields.sound ?? true,
        // Always send explicit booleans so the glasses never inherit an ambiguous default.
        zsl: fields.zsl ?? zsl,
        mfnr: fields.mfnr ?? mfnr,
      })
      setLastCapture({
        fileUri: uploadedUriRef.current ?? "",
        byteCount: response.fileSizeBytes ?? 0,
        requestId,
        captureMetadata: metadataRef.current,
        photoResponse: response as unknown as Record<string, unknown>,
      })
      setStatusMessage("complete")
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "capture failed")
    } finally {
      pendingRequestId.current = null
      setCapturing(false)
    }
  }

  const handleSaveToRoll = async () => {
    if (!lastCapture?.fileUri) return
    const permission = await MediaLibrary.requestPermissionsAsync()
    if (!permission.granted) {
      setStatusMessage("Photo library permission denied")
      return
    }
    await MediaLibrary.saveToLibraryAsync(lastCapture.fileUri)
    setStatusMessage("Saved to camera roll")
  }

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.header}>Mentra Bluetooth SDK Example</Text>
      <View style={styles.tabBar}>
        <TabButton label="Connection" active={tab === "connection"} onPress={() => setTab("connection")} />
        <TabButton label="Camera" active={tab === "camera"} onPress={() => setTab("camera")} />
      </View>
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        {tab === "connection" ? (
          <Group name="Connection">
            <Button
              title="Scan and connect Mentra Live"
              onPress={async () => {
                const devices = await BluetoothSdk.scan(DeviceModels.MentraLive)
                if (devices[0]) {
                  await BluetoothSdk.connect(devices[0])
                }
              }}
            />
            <Button title="Disconnect" onPress={() => BluetoothSdk.disconnect()} />
          </Group>
        ) : (
          <>
            <Group name={`Button photo quality (${photoSize})`}>
              <Text style={styles.hint}>Hardware button capture size (not used when Scan Mode is on).</Text>
              {PHOTO_SIZE_OPTIONS.map(option => (
                <View key={option.key} style={styles.buttonSpacing}>
                  <Button
                    title={option.key === photoSize ? `${option.label} (selected)` : option.label}
                    onPress={() => handlePhotoSizeChange(option.key)}
                  />
                </View>
              ))}
            </Group>
            <Group name="Scan Mode capture">
              <View style={styles.row}>
                <View style={styles.labelBlock}>
                  <Text style={styles.label}>ZSL</Text>
                  <Text style={styles.hintInline}>Zero-shutter-lag preview buffering. Off for scan mode.</Text>
                </View>
                <Switch value={zsl} disabled={scanMode} onValueChange={setZsl} />
              </View>
              <View style={styles.row}>
                <View style={styles.labelBlock}>
                  <Text style={styles.label}>MFNR</Text>
                  <Text style={styles.hintInline}>Multi-frame noise reduction capture. Off for scan mode.</Text>
                </View>
                <Switch value={mfnr} disabled={scanMode} onValueChange={setMfnr} />
              </View>
              <View style={styles.row}>
                <View style={styles.labelBlock}>
                  <Text style={styles.label}>Scan Mode</Text>
                  <Text style={styles.hintInline}>
                    Document / barcode tuning — max res, darker exposure, edge & ZSL/MFNR off.
                  </Text>
                </View>
                <Switch value={scanMode} onValueChange={(enabled) => void handleScanModeChange(enabled)} />
              </View>
              {scanMode ? (
                <>
                  <Text style={styles.hint}>
                    Preset: max, AE÷{aeDivisor}, ISO cap {isoCap}, compress none, sound off. Sends granular
                    requestPhoto fields only (never scanMode:true).
                  </Text>
                  <View style={styles.row}>
                    <Text style={styles.label}>AE divisor</Text>
                    <View style={styles.inlineButtons}>
                      <Button title={aeDivisor === 3 ? "÷3 (on)" : "÷3"} onPress={() => setAeDivisor(3)} />
                      <Button title={aeDivisor === 5 ? "÷5 (on)" : "÷5"} onPress={() => setAeDivisor(5)} />
                    </View>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.label}>ISO cap</Text>
                    <View style={styles.inlineButtons}>
                      <Button title={isoCap === 800 ? "800 (on)" : "800"} onPress={() => setIsoCap(800)} />
                      <Button title={isoCap === 400 ? "400 (on)" : "400"} onPress={() => setIsoCap(400)} />
                    </View>
                  </View>
                </>
              ) : (
                <Text style={styles.hint}>Off — Take Photo uses medium size and default camera tuning.</Text>
              )}
              <View style={styles.buttonSpacing}>
                {capturing ? (
                  <ActivityIndicator />
                ) : (
                  <Button
                    title={scanMode ? "Take Scan Photo" : "Take Photo"}
                    onPress={handleTakePhoto}
                  />
                )}
              </View>
              {statusMessage ? <Text style={styles.status}>Status: {statusMessage}</Text> : null}
            </Group>
            {lastCapture?.fileUri ? (
              <Group name="Last capture">
                <Image source={{uri: lastCapture.fileUri}} style={styles.preview} resizeMode="contain" />
                <Text style={styles.meta}>
                  {lastCapture.byteCount > 0 ? `${(lastCapture.byteCount / 1024).toFixed(1)} KB` : "Size pending"}
                </Text>
                {lastCapture.captureMetadata ? (
                  <Text style={styles.meta}>{formatMetadata(lastCapture.captureMetadata)}</Text>
                ) : null}
                <Button title="Save to camera roll" onPress={handleSaveToRoll} />
              </Group>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

function TabButton(props: {label: string; active: boolean; onPress: () => void}) {
  return (
    <Pressable
      onPress={props.onPress}
      style={[styles.tabButton, props.active ? styles.tabButtonActive : null]}>
      <Text style={[styles.tabLabel, props.active ? styles.tabLabelActive : null]}>{props.label}</Text>
    </Pressable>
  )
}

function formatMetadata(meta: PhotoCaptureMetadata): string {
  const parts: string[] = []
  if (meta.width != null && meta.height != null) {
    parts.push(`${meta.width}×${meta.height}`)
  }
  if (meta.exposureTimeNs != null) parts.push(`exp ${meta.exposureTimeNs} ns`)
  if (meta.iso != null) parts.push(`ISO ${meta.iso}`)
  if (meta.edgeMode != null) parts.push(`edge ${meta.edgeMode}`)
  if (meta.mfnrApplied != null) parts.push(`mfnr ${meta.mfnrApplied}`)
  if (meta.zsl != null) parts.push(`zsl ${meta.zsl}`)
  if (meta.noiseReductionWarning) parts.push(`NR: ${meta.noiseReductionWarning}`)
  if (meta.ispDigitalGainWarning) parts.push(`digital gain: ${meta.ispDigitalGainWarning}`)
  if (meta.ispAnalogGainWarning) parts.push(`analog gain: ${meta.ispAnalogGainWarning}`)
  return parts.join(" · ") || JSON.stringify(meta, null, 2)
}

function Group(props: {name: string; children: ReactNode}) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupHeader}>{props.name}</Text>
      {props.children}
    </View>
  )
}

const styles = {
  header: {
    fontSize: 30,
    margin: 20,
    marginBottom: 8,
  },
  tabBar: {
    flexDirection: "row" as const,
    marginHorizontal: 20,
    marginBottom: 8,
    backgroundColor: "#ddd",
    borderRadius: 10,
    padding: 4,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center" as const,
  },
  tabButtonActive: {
    backgroundColor: "#fff",
  },
  tabLabel: {
    fontSize: 16,
    color: "#666",
  },
  tabLabelActive: {
    color: "#000",
    fontWeight: "600" as const,
  },
  groupHeader: {
    fontSize: 20,
    marginBottom: 20,
  },
  group: {
    margin: 20,
    marginTop: 8,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 20,
  },
  buttonSpacing: {
    marginBottom: 10,
  },
  container: {
    flex: 1,
    backgroundColor: "#eee",
  },
  scrollContent: {
    paddingBottom: 40,
  },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    marginBottom: 12,
  },
  labelBlock: {
    flex: 1,
    marginRight: 12,
  },
  label: {
    fontSize: 16,
    fontWeight: "600" as const,
  },
  hintInline: {
    fontSize: 13,
    color: "#666",
    marginTop: 4,
  },
  hint: {
    fontSize: 14,
    color: "#444",
    marginBottom: 12,
  },
  status: {
    fontSize: 14,
    color: "#333",
  },
  preview: {
    width: "100%" as const,
    height: 240,
    backgroundColor: "#111",
    marginBottom: 12,
  },
  meta: {
    fontSize: 13,
    color: "#333",
    marginBottom: 8,
  },
  inlineButtons: {
    flexDirection: "row" as const,
  },
}
