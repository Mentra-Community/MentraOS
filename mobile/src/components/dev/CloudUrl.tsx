import {useState} from "react"
import {TextInput, View} from "react-native"

import {Button, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {cloudClient, resolvedEndpoints} from "@/services/cloudClient"
import {devServerHost, METRO_AUTO} from "@/utils/cloudClient/devHost"
import showAlert from "@/utils/AlertUtils"

const CLOUD_DEV_CORE_URL = "https://core.dev.us-west-2.mentraglass.com"
const CLOUD_DEV_RUNTIME_URL = "https://runtime.dev.us-west-2.mentraglass.com"
const CLOUD_DEBUG_CORE_URL = "https://core.debug.us-west-2.mentraglass.com"
const CLOUD_DEBUG_RUNTIME_URL = "https://runtime.debug.us-west-2.mentraglass.com"
const CLOUD_STAGING_CORE_URL = "https://core.staging.us-west-2.mentraglass.com"
const CLOUD_STAGING_RUNTIME_URL = "https://runtime.staging.us-west-2.mentraglass.com"

const LOCAL_CORE_PORT = 3000
const LOCAL_RUNTIME_PORT = 3001

/**
 * What a saved value means for the healthz test: the METRO_AUTO sentinel
 * resolves to the CURRENT Metro host (the laptop serving this dev bundle), so
 * the sentinel is what gets persisted while the probe hits the live address.
 */
function resolveForTest(value: string, port: number, metroHost: string | undefined): string | null {
  if (value !== METRO_AUTO) return value
  return metroHost ? `http://${metroHost}:${port}` : null
}

async function testEndpoint(url: string): Promise<{ok: boolean; status?: number; error?: string}> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`${url}/healthz`, {method: "GET", signal: controller.signal})
    clearTimeout(timeoutId)
    return {ok: response.ok, status: response.status}
  } catch (error: unknown) {
    clearTimeout(timeoutId)
    if (error instanceof Error && error.name === "AbortError") {
      return {ok: false, error: "Connection timed out"}
    }
    return {ok: false, error: error instanceof Error ? error.message : "Unknown error"}
  }
}

export default function CloudUrl() {
  const {theme} = useAppTheme()
  const [coreUrl, setCoreUrl] = useSetting(SETTINGS.cloud_core_url.key)
  const [runtimeUrl, setRuntimeUrl] = useSetting(SETTINGS.cloud_runtime_url.key)
  const [coreInput, setCoreInput] = useState("")
  const [runtimeInput, setRuntimeInput] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  // The dev laptop's live address (only present in Metro-served dev builds).
  // Drives the "Local (auto)" preset; when absent the preset is hidden.
  const metroHost = devServerHost()
  // What the client will actually connect to with every layer applied (the
  // override settings may be empty or hold the metro-auto sentinel).
  const active = resolvedEndpoints()
  const describeOverride = (value: unknown): string => {
    if (typeof value !== "string" || value.trim().length === 0) return ""
    return value.trim() === METRO_AUTO ? " (auto: this laptop)" : ""
  }

  const handleSave = async () => {
    const core = coreInput.trim().replace(/\/+$/, "")
    const runtime = runtimeInput.trim().replace(/\/+$/, "")

    if (!core || !runtime) {
      showAlert("Empty URL", "Please enter both Core and Runtime URLs or reset to default.", [{text: "OK"}])
      return
    }

    const isHttp = (u: string) => u.startsWith("http://") || u.startsWith("https://")
    const isValid = (u: string) => u === METRO_AUTO || isHttp(u)
    if (!isValid(core) || !isValid(runtime)) {
      showAlert("Invalid URL", `Both URLs must start with http:// or https:// (or be "${METRO_AUTO}").`, [{text: "OK"}])
      return
    }

    const coreTestUrl = resolveForTest(core, LOCAL_CORE_PORT, metroHost)
    const runtimeTestUrl = resolveForTest(runtime, LOCAL_RUNTIME_PORT, metroHost)
    if (!coreTestUrl || !runtimeTestUrl) {
      showAlert("No Metro host", "metro-auto needs a Metro-served dev build (no dev server detected).", [{text: "OK"}])
      return
    }

    setIsSaving(true)
    try {
      const coreResult = await testEndpoint(coreTestUrl)
      if (!coreResult.ok) {
        showAlert(
          "Core Failed",
          `Could not verify Core at ${coreTestUrl}/healthz${
            coreResult.status ? ` (status ${coreResult.status})` : coreResult.error ? `: ${coreResult.error}` : ""
          }.`,
          [{text: "OK"}],
        )
        return
      }

      const runtimeResult = await testEndpoint(runtimeTestUrl)
      if (!runtimeResult.ok) {
        showAlert(
          "Runtime Failed",
          `Could not verify Runtime at ${runtimeTestUrl}/healthz${
            runtimeResult.status
              ? ` (status ${runtimeResult.status})`
              : runtimeResult.error
                ? `: ${runtimeResult.error}`
                : ""
          }.`,
          [{text: "OK"}],
        )
        return
      }

      // Persist what the user chose, not what it resolved to: saving the
      // METRO_AUTO sentinel is what lets "my laptop" keep working when the
      // laptop's LAN IP changes — resolution happens live on every connect.
      await setCoreUrl(core)
      await setRuntimeUrl(runtime)
      cloudClient.reconnect()

      showAlert("Success", "Cloud V2 endpoints saved and verified. Reconnecting with the new URLs.", [{text: "OK"}])
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = () => {
    setCoreUrl(null)
    setRuntimeUrl(null)
    setCoreInput("")
    setRuntimeInput("")
    cloudClient.reconnect()
    showAlert("Success", "Reset Cloud V2 endpoints to env/default.", [{text: "OK"}])
  }

  const applyPreset = (core: string, runtime: string) => {
    setCoreInput(core)
    setRuntimeInput(runtime)
  }

  return (
    <GlassView className="bg-primary-foreground rounded-2xl px-6 py-4">
      <View className="flex-1">
        <Text className="flex-wrap text-base text-foreground">Cloud V2</Text>
        <Text className="mt-1 flex-wrap text-xs text-muted-foreground">
          New audio/captions cloud; the v1 backend URL above is the legacy cloud. Override the Cloud V2 core and runtime
          endpoints. Leave blank to use env/default.
        </Text>

        <Text className="mt-3.5 text-[13px] font-semibold text-foreground">Core URL</Text>
        <Text className="mt-1 flex-wrap text-xs text-muted-foreground">
          Currently using: {active.core}
          {describeOverride(coreUrl)}
        </Text>
        <TextInput
          className="mt-1.5 mb-1 rounded-xl border border-primary bg-background px-3 py-2.5 text-sm text-foreground"
          placeholder="e.g., http://192.168.1.100:3000"
          placeholderTextColor={theme.colors.textDim}
          value={coreInput}
          onChangeText={setCoreInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!isSaving}
        />

        <Text className="mt-3.5 text-[13px] font-semibold text-foreground">Runtime URL</Text>
        <Text className="mt-1 flex-wrap text-xs text-muted-foreground">
          Currently using: {active.runtime}
          {describeOverride(runtimeUrl)}
        </Text>
        <TextInput
          className="mt-1.5 mb-1 rounded-xl border border-primary bg-background px-3 py-2.5 text-sm text-foreground"
          placeholder="e.g., http://192.168.1.100:3001"
          placeholderTextColor={theme.colors.textDim}
          value={runtimeInput}
          onChangeText={setRuntimeInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!isSaving}
        />

        <View className="mt-3 flex-row justify-between">
          <Button
            text={isSaving ? "Testing..." : "Save & Test"}
            onPress={handleSave}
            disabled={isSaving}
            preset="alternate"
            flexContainer={false}
          />
          <Button text="Reset" onPress={handleReset} disabled={isSaving} preset="alternate" flexContainer={false} />
        </View>

        {/* Paired env presets — a tap sets BOTH inputs so they never drift. */}
        <View className="mt-3 flex-row flex-wrap justify-between gap-3">
          <Button
            compact
            text="Cloud Dev"
            onPress={() => applyPreset(CLOUD_DEV_CORE_URL, CLOUD_DEV_RUNTIME_URL)}
            flexContainer={false}
            flex
          />
          <Button
            compact
            text="Cloud Debug"
            onPress={() => applyPreset(CLOUD_DEBUG_CORE_URL, CLOUD_DEBUG_RUNTIME_URL)}
            flexContainer={false}
            flex
          />
          <Button
            compact
            text="Cloud Staging"
            onPress={() => applyPreset(CLOUD_STAGING_CORE_URL, CLOUD_STAGING_RUNTIME_URL)}
            flexContainer={false}
            flex
          />
          {/* Only offered when a Metro dev server is actually detectable.
              Fills both fields with the metro-auto sentinel: the SAVED value
              is "my laptop", resolved live on every connect, so it follows
              the laptop across networks instead of freezing today's IP. */}
          {metroHost && (
            <Button
              compact
              text={`Local (auto: ${metroHost})`}
              onPress={() => applyPreset(METRO_AUTO, METRO_AUTO)}
              flexContainer={false}
              flex
            />
          )}
        </View>
      </View>
    </GlassView>
  )
}
