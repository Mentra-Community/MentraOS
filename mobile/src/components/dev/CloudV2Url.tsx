import {useState} from "react"
import {TextInput, View, ViewStyle, TextStyle} from "react-native"

import {Button, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {DEFAULT_CORE_URL, DEFAULT_RUNTIME_URL, reconnectCloudV2} from "@/services/cloudV2Client"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"

const AWS_DEV_CORE_URL = "https://core.us-west-2.dev.mentraglass.com"
const AWS_DEV_RUNTIME_URL = "https://runtime.us-west-2.dev.mentraglass.com"

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

export default function CloudV2Url() {
  const {theme, themed} = useAppTheme()
  const [coreUrl, setCoreUrl] = useSetting(SETTINGS.cloud_v2_core_url.key)
  const [runtimeUrl, setRuntimeUrl] = useSetting(SETTINGS.cloud_v2_runtime_url.key)
  const [coreInput, setCoreInput] = useState("")
  const [runtimeInput, setRuntimeInput] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  const handleSave = async () => {
    const core = coreInput.trim().replace(/\/+$/, "")
    const runtime = runtimeInput.trim().replace(/\/+$/, "")

    if (!core || !runtime) {
      showAlert("Empty URL", "Please enter both Core and Runtime URLs or reset to default.", [{text: "OK"}])
      return
    }

    const isHttp = (u: string) => u.startsWith("http://") || u.startsWith("https://")
    if (!isHttp(core) || !isHttp(runtime)) {
      showAlert("Invalid URL", "Both URLs must start with http:// or https://", [{text: "OK"}])
      return
    }

    setIsSaving(true)
    try {
      const coreResult = await testEndpoint(core)
      if (!coreResult.ok) {
        showAlert(
          "Core Failed",
          `Could not verify Core at ${core}/healthz${
            coreResult.status ? ` (status ${coreResult.status})` : coreResult.error ? `: ${coreResult.error}` : ""
          }.`,
          [{text: "OK"}],
        )
        return
      }

      const runtimeResult = await testEndpoint(runtime)
      if (!runtimeResult.ok) {
        showAlert(
          "Runtime Failed",
          `Could not verify Runtime at ${runtime}/healthz${
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

      await setCoreUrl(core)
      await setRuntimeUrl(runtime)
      reconnectCloudV2()

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
    reconnectCloudV2()
    showAlert("Success", "Reset Cloud V2 endpoints to env/default.", [{text: "OK"}])
  }

  const applyPreset = (core: string, runtime: string) => {
    setCoreInput(core)
    setRuntimeInput(runtime)
  }

  return (
    <GlassView className="bg-primary-foreground rounded-2xl" style={themed($container)}>
      <View style={themed($textContainer)}>
        <Text style={themed($label)}>Cloud V2</Text>
        <Text style={themed($subtitle)}>
          New audio/captions cloud; the v1 backend URL above is the legacy cloud. Override the Cloud V2 core and
          runtime endpoints. Leave blank to use env/default.
        </Text>

        <Text style={themed($fieldLabel)}>Core URL</Text>
        <Text style={themed($subtitle)}>Currently using: {coreUrl}</Text>
        <TextInput
          style={themed($urlInput)}
          placeholder="e.g., http://192.168.1.100:3000"
          placeholderTextColor={theme.colors.textDim}
          value={coreInput}
          onChangeText={setCoreInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!isSaving}
        />

        <Text style={themed($fieldLabel)}>Runtime URL</Text>
        <Text style={themed($subtitle)}>Currently using: {runtimeUrl}</Text>
        <TextInput
          style={themed($urlInput)}
          placeholder="e.g., http://192.168.1.100:8010"
          placeholderTextColor={theme.colors.textDim}
          value={runtimeInput}
          onChangeText={setRuntimeInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!isSaving}
        />

        <View style={themed($buttonRow)}>
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
        <View style={themed($buttonColumn)}>
          <Button
            compact
            text="AWS us-west-2 (dev)"
            onPress={() => applyPreset(AWS_DEV_CORE_URL, AWS_DEV_RUNTIME_URL)}
            flexContainer={false}
            flex
          />
          <Button
            compact
            text="Local (laptop)"
            onPress={() => applyPreset(DEFAULT_CORE_URL, DEFAULT_RUNTIME_URL)}
            flexContainer={false}
            flex
          />
        </View>
      </View>
    </GlassView>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s6,
  paddingVertical: spacing.s4,
})

const $textContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  flexWrap: "wrap",
  fontSize: 16,
  color: colors.text,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  flexWrap: "wrap",
  fontSize: 12,
  marginTop: 5,
  color: colors.textDim,
})

const $fieldLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 13,
  fontWeight: "600",
  color: colors.text,
  marginTop: 14,
})

const $urlInput: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  borderColor: colors.primary,
  borderRadius: spacing.s3,
  paddingHorizontal: 12,
  paddingVertical: 10,
  fontSize: 14,
  marginTop: 6,
  marginBottom: 4,
  color: colors.text,
})

const $buttonRow: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "space-between",
  marginTop: 12,
})

const $buttonColumn: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  gap: 12,
  justifyContent: "space-between",
  marginTop: 12,
})
