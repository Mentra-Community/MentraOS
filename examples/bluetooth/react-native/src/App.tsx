import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  type ImageSourcePropType,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  PermissionsAndroid,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import BluetoothSdk, {
  type BatteryStatusEvent,
  type ButtonPressEvent,
  type CompatibleGlassesSearchStopEvent,
  type CoreStatus,
  type DeviceSearchResult,
  type GlassesStatus,
  type LogEvent,
  type PhotoResponseEvent,
} from "@mentra/bluetooth-sdk";
import type { ReactNode } from "react";

type BluetoothStatus = CoreStatus;

declare const process: {
  env?: {
    EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL?: string;
  };
};

const DEFAULT_WEBHOOK_URL =
  process.env?.EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL ?? "";
const PHOTO_APP_ID = "com.mentra.examples.reactnative";
const PHOTO_POLL_ATTEMPTS = 45;
const ANDROID_12_API_LEVEL = 31;
const UNKNOWN_GLASSES_IMAGE = require("../assets/glasses/unknown_wearable.png");
const GLASSES_IMAGE_BY_MODEL: Record<string, ImageSourcePropType> = {
  "Mentra Live": require("../assets/glasses/mentra_live.png"),
  mentra_live: require("../assets/glasses/mentra_live.png"),
  "Mentra Display": require("../assets/glasses/mentra_display.png"),
  "Even Realities G1": require("../assets/glasses/even_realities_g1.png"),
  evenrealities_g1: require("../assets/glasses/even_realities_g1.png"),
  g1: require("../assets/glasses/even_realities_g1.png"),
  "Even Realities G2": require("../assets/glasses/even_realities_g2.png"),
  evenrealities_g2: require("../assets/glasses/even_realities_g2.png"),
  g2: require("../assets/glasses/even_realities_g2.png"),
  "Vuzix Z100": require("../assets/glasses/vuzix_z100.png"),
  "Vuzix-z100": require("../assets/glasses/vuzix_z100.png"),
  "Vuzix Ultralite": require("../assets/glasses/vuzix_z100.png"),
  "Mentra Mach1": require("../assets/glasses/vuzix_z100.png"),
  Mach1: require("../assets/glasses/vuzix_z100.png"),
};

export default function App() {
  const [glassesStatus, setGlassesStatus] = useState<Partial<GlassesStatus>>(
    {},
  );
  const [bluetoothStatus, setBluetoothStatus] = useState<
    Partial<BluetoothStatus>
  >({});
  const [events, setEvents] = useState<string[]>([]);
  const [webhookUrl, setWebhookUrl] = useState(DEFAULT_WEBHOOK_URL);
  const [cameraStatus, setCameraStatus] = useState(
    "Camera: enter the local webhook /upload URL",
  );
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState("No actions yet.");
  const [permissionStatus, setPermissionStatus] = useState(
    Platform.OS === "android"
      ? "Permissions: not requested"
      : "Permissions: iOS prompts as needed",
  );
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const activePhotoRequestIdRef = useRef<string | null>(null);
  const pollGenerationRef = useRef(0);
  const discoveredDevices = bluetoothStatus.searchResults ?? [];

  useEffect(() => {
    const removeGlasses = BluetoothSdk.onGlassesStatus((changed) => {
      setGlassesStatus((current) => ({ ...current, ...changed }));
    });

    const removeBluetooth = BluetoothSdk.onCoreStatus((changed) => {
      setBluetoothStatus((current) => ({ ...current, ...changed }));
    });

    const buttonSub = BluetoothSdk.addListener(
      "button_press",
      (event: ButtonPressEvent) => {
        addEvent(`Button ${event.buttonId}: ${event.pressType}`);
      },
    );

    const batterySub = BluetoothSdk.addListener(
      "battery_status",
      (event: BatteryStatusEvent) => {
        addEvent(`Battery ${event.level}%${event.charging ? " charging" : ""}`);
      },
    );

    const photoSub = BluetoothSdk.addListener(
      "photo_response",
      (event: PhotoResponseEvent) => {
        handlePhotoResponse(event);
      },
    );

    const scanStopSub = BluetoothSdk.addListener(
      "compatible_glasses_search_stop",
      (event: CompatibleGlassesSearchStopEvent) => {
        addEvent(`Scan stopped for ${event.device_model ?? "glasses"}.`);
      },
    );

    const logSub = BluetoothSdk.addListener("log", (event: LogEvent) => {
      addEvent(event.message);
    });

    if (DEFAULT_WEBHOOK_URL) {
      addEvent("Loaded webhook URL from EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL.");
    }

    void ensureAndroidPermissions("startup").catch((error) => {
      addEvent(`Permission request failed: ${formatError(error)}`);
    });

    return () => {
      removeGlasses();
      removeBluetooth();
      buttonSub.remove();
      batterySub.remove();
      photoSub.remove();
      scanStopSub.remove();
      logSub.remove();
      activePhotoRequestIdRef.current = null;
      pollGenerationRef.current += 1;
    };
  }, []);

  function addEvent(message: string) {
    setEvents((current) => [message, ...current].slice(0, 12));
  }

  async function runAction(label: string, action: () => Promise<void> | void) {
    setActiveAction(label);
    setLastAction(`Running: ${label}`);
    addEvent(`Started: ${label}`);

    try {
      await action();
      setLastAction(`Requested: ${label}`);
      addEvent(`Requested: ${label}`);
    } catch (error) {
      const message = formatError(error);
      setLastAction(`Failed: ${label} - ${message}`);
      addEvent(`${label} failed: ${message}`);
    } finally {
      setActiveAction((current) => (current === label ? null : current));
    }
  }

  async function ensureAndroidPermissions(reason: string) {
    if (Platform.OS !== "android") {
      return true;
    }

    const permissions = androidRuntimePermissions();
    const results = await PermissionsAndroid.requestMultiple(permissions);
    const denied = permissions.filter(
      (permission) =>
        results[permission] !== PermissionsAndroid.RESULTS.GRANTED,
    );

    if (denied.length > 0) {
      setPermissionStatus(`Permissions: missing ${denied.length}`);
      addEvent(`Android permissions denied for ${reason}: ${denied.join(", ")}`);
      return false;
    }

    setPermissionStatus("Permissions: granted");
    addEvent(`Android permissions granted for ${reason}.`);
    return true;
  }

  async function scanForMentraLive() {
    if (!(await ensureAndroidPermissions("scan"))) {
      throw new Error("Bluetooth permissions are required to scan.");
    }

    await BluetoothSdk.findCompatibleDevices("Mentra Live");
  }

  async function applyDisplaySettings() {
    try {
      await BluetoothSdk.updateCore({
        brightness: 60,
        dashboard_height: 4,
        dashboard_depth: 6,
      });
      addEvent("Applied brightness and dashboard position.");
    } catch (error) {
      addEvent(`Settings failed: ${formatError(error)}`);
    }
  }

  async function connectFirstOrDefault() {
    if (!(await ensureAndroidPermissions("connect"))) {
      throw new Error("Bluetooth permissions are required to connect.");
    }

    const firstDevice = discoveredDevices[0];

    if (firstDevice) {
      await connectDiscoveredDevice(firstDevice);
      return;
    }

    const currentBluetoothStatus = BluetoothSdk.getCoreStatus() as Partial<
      BluetoothStatus
    > &
      Record<string, unknown>;
    const defaultWearable = stringValue(currentBluetoothStatus.default_wearable);
    const defaultDeviceName = stringValue(currentBluetoothStatus.device_name);

    if (!defaultWearable || !defaultDeviceName) {
      throw new Error(
        "Scan has not found glasses yet, and there is no saved default device.",
      );
    }

    addEvent("No scan result yet. Trying saved default device.");
    await BluetoothSdk.connectDefault();
  }

  async function connectDiscoveredDevice(device: DeviceSearchResult) {
    if (!(await ensureAndroidPermissions("connect"))) {
      throw new Error("Bluetooth permissions are required to connect.");
    }

    addEvent(`Connecting to ${device.deviceName}...`);
    await BluetoothSdk.connectDiscoveredDevice(device);
  }

  async function requestWebhookPhoto() {
    if (!(await ensureAndroidPermissions("photo"))) {
      throw new Error("Camera and Bluetooth permissions are required for photos.");
    }

    const uploadUrlText = webhookUrl.trim();
    let statusUrl: string;

    try {
      statusUrl = photoStatusUrl(uploadUrlText, "");
    } catch {
      setCameraStatus(
        "Camera: enter a webhook URL like http://<computer-ip>:8787/upload",
      );
      addEvent("Webhook photo skipped because the upload URL is invalid.");
      return;
    }

    const requestId = `photo-${Date.now()}`;
    statusUrl = photoStatusUrl(uploadUrlText, requestId);
    activePhotoRequestIdRef.current = requestId;
    pollGenerationRef.current += 1;
    const pollGeneration = pollGenerationRef.current;

    setPhotoPreviewUrl(null);
    setCameraStatus(`Camera: webhook upload requested (${requestId})`);
    addEvent(`Photo request id: ${requestId}`);
    addEvent(`Requested webhook photo upload: ${requestId} -> ${uploadUrlText}.`);

    try {
      await BluetoothSdk.photoRequest(
        requestId,
        PHOTO_APP_ID,
        "medium",
        uploadUrlText,
        "",
        "medium",
        false,
        true,
      );
    } catch (error) {
      setCameraStatus(`Camera: request failed - ${formatError(error)}`);
      addEvent(`Photo request failed: ${formatError(error)}`);
      activePhotoRequestIdRef.current = null;
      return;
    }

    await pollPhotoPreview(requestId, statusUrl, pollGeneration);
  }

  function handlePhotoResponse(event: PhotoResponseEvent) {
    const activeRequestId = activePhotoRequestIdRef.current;

    if (activeRequestId && event.requestId !== activeRequestId) {
      addEvent(
        `Ignoring stale photo response for ${event.requestId}; active request is ${activeRequestId}.`,
      );
      return;
    }

    if (event.success === false) {
      const errorCode = event.errorCode ?? "unknown_error";
      const errorMessage = event.errorMessage ?? "no details";
      setCameraStatus(
        `Camera: glasses reported ${errorCode}; waiting for upload or timeout`,
      );
      addEvent(`Photo response error: ${errorCode} - ${errorMessage}`);
      return;
    }

    if (activeRequestId && event.requestId === activeRequestId) {
      setCameraStatus("Camera: photo acknowledged; waiting for local upload");
    }

    addEvent(`Photo response: ${event.requestId} success=${event.success}`);
  }

  async function pollPhotoPreview(
    requestId: string,
    statusUrl: string,
    pollGeneration: number,
  ) {
    for (let attempt = 0; attempt < PHOTO_POLL_ATTEMPTS; attempt += 1) {
      if (
        activePhotoRequestIdRef.current !== requestId ||
        pollGenerationRef.current !== pollGeneration
      ) {
        return;
      }

      try {
        const response = await fetch(cacheBustedUrl(statusUrl), {
          cache: "no-store",
          headers: {
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
        });
        if (response.ok) {
          const json = (await response.json()) as { photoUrl?: string };
          if (json.photoUrl) {
            setPhotoPreviewUrl(json.photoUrl);
            setCameraStatus("Camera: loaded photo preview");
            addEvent(`Local webhook photo ready: ${json.photoUrl}`);
            activePhotoRequestIdRef.current = null;
            return;
          }
        }

        if (attempt === 0 || attempt % 10 === 9) {
          addEvent(
            `Waiting for upload ${requestId}: local server returned ${response.status}.`,
          );
        }
      } catch (error) {
        if (attempt === 0 || attempt % 10 === 9) {
          addEvent(`Waiting for local photo server: ${formatError(error)}`);
        }
      }

      await delay(1000);
    }

    if (activePhotoRequestIdRef.current === requestId) {
      setCameraStatus("Camera: timed out waiting for local server upload");
      addEvent(`Timed out polling local photo server for ${requestId}.`);
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboardRoot}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Mentra Bluetooth SDK</Text>
          <Text style={styles.subtitle}>Partner integration example</Text>

          <GlassesPreviewCard
            bluetoothStatus={bluetoothStatus}
            discoveredDevices={discoveredDevices}
            glassesStatus={glassesStatus}
          />

          <Section title="Live Status">
            <StatusRow label="Last action" value={lastAction} />
            <StatusRow
              label="Connection"
              value={formatConnectionStatus(glassesStatus)}
            />
            <StatusRow label="Device" value={formatDeviceLabel(glassesStatus)} />
            <StatusRow label="Battery" value={formatBatteryStatus(glassesStatus)} />
            <StatusRow
              label="Bluetooth"
              value={formatBluetoothSearchStatus(bluetoothStatus)}
            />
            <StatusRow
              label="Discovered"
              value={formatDiscoveredDevices(discoveredDevices)}
            />
            <StatusRow label="Permissions" value={permissionStatus} />
            <StatusRow label="Camera" value={cameraStatus} />
            <StatusRow label="Latest event" value={events[0] ?? "No events yet."} />
          </Section>

          <Section title="Connection">
            <ActionButton
              active={activeAction === "Scan for Mentra Live"}
              title="Scan for Mentra Live"
              onPress={() =>
                void runAction("Scan for Mentra Live", scanForMentraLive)
              }
            />
            <ActionButton
              active={activeAction === "Connect first/default"}
              title="Connect first/default"
              onPress={() =>
                void runAction("Connect first/default", connectFirstOrDefault)
              }
            />
            {discoveredDevices.length > 0 ? (
              <View style={styles.deviceList}>
                <Text style={styles.deviceListTitle}>Discovered devices</Text>
                {discoveredDevices.map((device) => (
                  <ActionButton
                    active={activeAction === `Connect ${device.deviceName}`}
                    key={`${device.deviceModel}-${device.deviceName}`}
                    title={`Connect ${device.deviceName}`}
                    onPress={() =>
                      void runAction(`Connect ${device.deviceName}`, () =>
                        connectDiscoveredDevice(device),
                      )
                    }
                  />
                ))}
              </View>
            ) : (
              <Text style={styles.helper}>
                Scan first. Discovered glasses will appear here as buttons.
              </Text>
            )}
            <ActionButton
              active={activeAction === "Request status"}
              title="Request status"
              onPress={() =>
                void runAction("Request status", () => BluetoothSdk.requestStatus())
              }
            />
            <ActionButton
              active={activeAction === "Connect simulated"}
              title="Connect simulated"
              onPress={() =>
                void runAction("Connect simulated", () =>
                  BluetoothSdk.connectSimulated(),
                )
              }
            />
            <ActionButton
              active={activeAction === "Disconnect"}
              title="Disconnect"
              onPress={() =>
                void runAction("Disconnect", () => BluetoothSdk.disconnect())
              }
            />
          </Section>

          <Section title="Display">
            <ActionButton
              active={activeAction === "Display hello"}
              title="Display hello"
              onPress={() =>
                void runAction("Display hello", () =>
                  BluetoothSdk.displayText({
                    text: "Hello from Mentra",
                    x: 0,
                    y: 0,
                    size: 24,
                  }),
                )
              }
            />
            <ActionButton
              active={activeAction === "Apply display settings"}
              title="Apply display settings"
              onPress={() =>
                void runAction("Apply display settings", applyDisplaySettings)
              }
            />
            <ActionButton
              active={activeAction === "Clear display"}
              title="Clear display"
              onPress={() =>
                void runAction("Clear display", () => BluetoothSdk.clearDisplay())
              }
            />
          </Section>

          <Section title="Webhook Photo Preview">
            <Text style={styles.helper}>
              Run the local webhook server, then paste its LAN /upload URL.
            </Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={setWebhookUrl}
              placeholder="http://192.168.1.42:8787/upload"
              style={styles.input}
              value={webhookUrl}
            />
            <ActionButton
              active={activeAction === "Take photo + upload"}
              title="Take photo + upload"
              onPress={() =>
                void runAction("Take photo + upload", requestWebhookPhoto)
              }
            />
            <Text style={styles.cameraStatus}>{cameraStatus}</Text>
            {photoPreviewUrl ? (
              <Image
                resizeMode="cover"
                source={{ uri: photoPreviewUrl }}
                style={styles.preview}
              />
            ) : null}
          </Section>

          <Section title="Recent Events">
            {events.length === 0 ? (
              <Text>No events yet.</Text>
            ) : (
              events.map((event, index) => (
                <Text key={`${event}-${index}`} style={styles.eventText}>
                  {event}
                </Text>
              ))
            )}
          </Section>

          <Section title="Raw Status">
            <Text style={styles.mono}>
              {JSON.stringify({ glassesStatus, bluetoothStatus }, null, 2)}
            </Text>
          </Section>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function GlassesPreviewCard(props: {
  bluetoothStatus: Partial<BluetoothStatus>;
  discoveredDevices: DeviceSearchResult[];
  glassesStatus: Partial<GlassesStatus>;
}) {
  const model = previewModel(
    props.glassesStatus,
    props.bluetoothStatus,
    props.discoveredDevices,
  );
  const batteryLevel = normalizedBatteryLevel(props.glassesStatus);
  const batteryRemainder = batteryLevel === null ? 1 : 100 - batteryLevel;
  const imageSource = previewImageSource(model);
  const connected = props.glassesStatus.connected === true;
  const fullyBooted = props.glassesStatus.fullyBooted === true;

  return (
    <View style={styles.previewCard}>
      <View style={styles.previewHalo} />
      <Image
        resizeMode="contain"
        source={imageSource}
        style={styles.previewImage}
      />
      <View style={styles.previewDetails}>
        <Text style={styles.previewEyebrow}>Glasses</Text>
        <Text numberOfLines={1} style={styles.previewTitle}>
          {model}
        </Text>
        <View style={styles.previewPillRow}>
          <PreviewPill
            label={formatPreviewConnectionStatus(props.glassesStatus)}
            tone={connected && fullyBooted ? "good" : "neutral"}
          />
          <PreviewPill
            label={formatPreviewBluetoothStatus(
              props.bluetoothStatus,
              props.discoveredDevices.length,
              connected,
            )}
            tone={props.bluetoothStatus.searching ? "busy" : "neutral"}
          />
        </View>
        <View style={styles.previewMetricRow}>
          <Text style={styles.previewMetricLabel}>Battery</Text>
          <Text style={styles.previewMetricValue}>
            {formatBatteryStatus(props.glassesStatus)}
          </Text>
        </View>
        <View style={styles.previewBatteryTrack}>
          <View
            style={[
              styles.previewBatteryFill,
              batteryLevel === null ? styles.previewBatteryFillUnknown : null,
              { flex: batteryLevel ?? 0 },
            ]}
          />
          <View style={{ flex: batteryRemainder }} />
        </View>
        <View style={styles.previewMetricRow}>
          <Text style={styles.previewMetricLabel}>Wi-Fi</Text>
          <Text style={styles.previewMetricValue}>
            {formatWifiStatus(props.glassesStatus)}
          </Text>
        </View>
      </View>
    </View>
  );
}

function PreviewPill(props: { label: string; tone: "busy" | "good" | "neutral" }) {
  return (
    <View
      style={[
        styles.previewPill,
        props.tone === "good" ? styles.previewPillGood : null,
        props.tone === "busy" ? styles.previewPillBusy : null,
      ]}
    >
      <Text style={styles.previewPillText}>{props.label}</Text>
    </View>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      <View style={styles.actions}>{props.children}</View>
    </View>
  );
}

function StatusRow(props: { label: string; value: string }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{props.label}</Text>
      <Text style={styles.statusValue}>{props.value}</Text>
    </View>
  );
}

function ActionButton(props: {
  active: boolean;
  title: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      android_ripple={{ color: "#c8dfd4" }}
      disabled={props.active}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.actionButton,
        pressed ? styles.actionButtonPressed : null,
        props.active ? styles.actionButtonActive : null,
      ]}
    >
      <Text style={styles.actionButtonText}>{props.title}</Text>
      {props.active ? <ActivityIndicator color="#163d2f" size="small" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#f5f1e8",
  },
  keyboardRoot: {
    flex: 1,
  },
  content: {
    padding: 20,
    gap: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#16201b",
  },
  subtitle: {
    fontSize: 16,
    color: "#546158",
  },
  previewCard: {
    backgroundColor: "#17251f",
    borderRadius: 24,
    flexDirection: "row",
    minHeight: 178,
    overflow: "hidden",
    padding: 18,
  },
  previewHalo: {
    backgroundColor: "#d9f2df",
    borderRadius: 140,
    height: 180,
    left: -54,
    opacity: 0.22,
    position: "absolute",
    top: -46,
    width: 180,
  },
  previewImage: {
    alignSelf: "center",
    height: 126,
    marginRight: 12,
    width: "43%",
  },
  previewDetails: {
    flex: 1,
    gap: 9,
    justifyContent: "center",
    minWidth: 0,
  },
  previewEyebrow: {
    color: "#b7cabf",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  previewTitle: {
    color: "#fffaf0",
    fontSize: 22,
    fontWeight: "800",
  },
  previewPillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  previewPill: {
    backgroundColor: "rgba(255, 250, 240, 0.12)",
    borderColor: "rgba(255, 250, 240, 0.14)",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  previewPillBusy: {
    backgroundColor: "rgba(244, 183, 85, 0.22)",
    borderColor: "rgba(244, 183, 85, 0.45)",
  },
  previewPillGood: {
    backgroundColor: "rgba(111, 211, 154, 0.22)",
    borderColor: "rgba(111, 211, 154, 0.45)",
  },
  previewPillText: {
    color: "#fffaf0",
    fontSize: 12,
    fontWeight: "700",
  },
  previewMetricRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  previewMetricLabel: {
    color: "#b7cabf",
    fontSize: 13,
  },
  previewMetricValue: {
    color: "#fffaf0",
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "700",
    textAlign: "right",
  },
  previewBatteryTrack: {
    backgroundColor: "rgba(255, 250, 240, 0.16)",
    borderRadius: 999,
    flexDirection: "row",
    height: 8,
    overflow: "hidden",
  },
  previewBatteryFill: {
    backgroundColor: "#7ee0a5",
  },
  previewBatteryFillUnknown: {
    backgroundColor: "rgba(255, 250, 240, 0.24)",
  },
  section: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "600",
  },
  actions: {
    gap: 10,
  },
  statusRow: {
    alignItems: "flex-start",
    borderBottomColor: "#ece5d6",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 4,
    paddingBottom: 6,
    paddingTop: 2,
  },
  statusLabel: {
    color: "#6f7a72",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    lineHeight: 18,
    textTransform: "uppercase",
    width: 104,
  },
  statusValue: {
    color: "#16201b",
    flex: 1,
    fontSize: 15,
    lineHeight: 18,
  },
  actionButton: {
    alignItems: "center",
    backgroundColor: "#e7f2ed",
    borderColor: "#9dc4b4",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  actionButtonPressed: {
    backgroundColor: "#cfe4da",
    transform: [{ scale: 0.98 }],
  },
  actionButtonActive: {
    backgroundColor: "#d7eadf",
    borderColor: "#3c7d61",
  },
  actionButtonText: {
    color: "#163d2f",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  deviceList: {
    backgroundColor: "#f6fbf8",
    borderColor: "#d5e8df",
    borderRadius: 14,
    borderWidth: 1,
    gap: 10,
    padding: 12,
  },
  deviceListTitle: {
    color: "#163d2f",
    fontSize: 14,
    fontWeight: "700",
  },
  helper: {
    color: "#546158",
    lineHeight: 20,
  },
  input: {
    borderColor: "#cfc7b7",
    borderRadius: 12,
    borderWidth: 1,
    color: "#16201b",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  cameraStatus: {
    color: "#16201b",
    fontWeight: "600",
  },
  preview: {
    aspectRatio: 4 / 3,
    backgroundColor: "#e4dccb",
    borderRadius: 12,
    width: "100%",
  },
  eventText: {
    lineHeight: 20,
  },
  mono: {
    fontFamily: "Courier",
    fontSize: 12,
  },
});

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function photoStatusUrl(uploadUrlText: string, requestId: string) {
  const uploadUrl = new URL(uploadUrlText);
  const scheme = uploadUrl.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    throw new Error("Only http and https webhook URLs are supported.");
  }

  return `${uploadUrl.protocol}//${uploadUrl.host}/uploads/${requestId}.json`;
}

function cacheBustedUrl(url: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}poll=${Date.now()}`;
}

function formatConnectionStatus(status: Partial<GlassesStatus>) {
  if (status.connectionState) {
    return status.connectionState;
  }

  if (typeof status.connected === "boolean") {
    return status.connected ? "Connected" : "Not connected";
  }

  return "Waiting for status";
}

function formatDeviceLabel(status: Partial<GlassesStatus>) {
  return (
    status.bluetoothName ||
    status.deviceModel ||
    status.serialNumber ||
    "Waiting for status"
  );
}

function formatBatteryStatus(status: Partial<GlassesStatus>) {
  const batteryLevel = normalizedBatteryLevel(status);
  if (batteryLevel === null) {
    return "Waiting for status";
  }

  const chargingText = status.charging ? " charging" : "";
  return `${batteryLevel}%${chargingText}`;
}

function formatBluetoothSearchStatus(status: Partial<BluetoothStatus>) {
  const searchingText = status.searching ? "Searching" : "Idle";
  const resultCount = status.searchResults?.length ?? 0;

  return `${searchingText}; ${resultCount} result${resultCount === 1 ? "" : "s"}`;
}

function formatDiscoveredDevices(devices: DeviceSearchResult[]) {
  if (devices.length === 0) {
    return "None yet";
  }

  return devices.map((device) => device.deviceName).join(", ");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function previewModel(
  glassesStatus: Partial<GlassesStatus>,
  bluetoothStatus: Partial<BluetoothStatus>,
  discoveredDevices: DeviceSearchResult[],
) {
  const savedDefault = stringValue(
    (bluetoothStatus as Record<string, unknown>).default_wearable,
  );

  return (
    glassesStatus.deviceModel ||
    discoveredDevices[0]?.deviceModel ||
    savedDefault ||
    "Mentra Live"
  );
}

function previewImageSource(model: string) {
  return GLASSES_IMAGE_BY_MODEL[model] ?? UNKNOWN_GLASSES_IMAGE;
}

function normalizedBatteryLevel(status: Partial<GlassesStatus>) {
  if (typeof status.batteryLevel !== "number" || status.batteryLevel < 0) {
    return null;
  }

  return Math.min(status.batteryLevel, 100);
}

function formatPreviewConnectionStatus(status: Partial<GlassesStatus>) {
  if (status.connected && status.fullyBooted === false) {
    return "Booting";
  }

  return formatConnectionStatus(status);
}

function formatPreviewBluetoothStatus(
  status: Partial<BluetoothStatus>,
  discoveredCount: number,
  connected: boolean,
) {
  if (status.searching) {
    return `Scanning ${discoveredCount}`;
  }

  if (connected) {
    return "Bluetooth linked";
  }

  if (discoveredCount > 0) {
    return `${discoveredCount} found`;
  }

  return "Bluetooth idle";
}

function formatWifiStatus(status: Partial<GlassesStatus>) {
  if (typeof status.wifiConnected !== "boolean") {
    return "Unknown";
  }

  return status.wifiConnected ? status.wifiSsid || "Connected" : "Disconnected";
}

function androidRuntimePermissions() {
  const permissions = [
    PermissionsAndroid.PERMISSIONS.CAMERA,
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ];

  if (Number(Platform.Version) >= ANDROID_12_API_LEVEL) {
    permissions.push(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    );
  } else {
    permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION);
  }

  return permissions;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
