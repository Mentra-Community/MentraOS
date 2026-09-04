import {useEffect, useRef, useState} from "react"
import {ActivityIndicator, Keyboard, ScrollView, TextInput, View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {DeploymentResolutionError, resolveDeploymentCandidate, useDeployment} from "@/services/deployment"
import {useNavigationStore} from "@/stores/navigation"

export default function WorkspaceScreen() {
  const [workspaceUrl, setWorkspaceUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const {goBack, push} = useNavigationStore.getState()
  const {setCandidate, clearCandidate} = useDeployment()
  const {theme} = useAppTheme()
  const requestGeneration = useRef(0)

  useEffect(
    () => () => {
      requestGeneration.current += 1
    },
    [],
  )

  const resolveWorkspace = async () => {
    const generation = requestGeneration.current + 1
    requestGeneration.current = generation
    Keyboard.dismiss()
    setError(null)
    setLoading(true)
    try {
      const candidate = await resolveDeploymentCandidate(workspaceUrl, {
        allowInsecureLocalhost: __DEV__,
      })
      if (generation !== requestGeneration.current) return
      setCandidate(candidate)
      push("/auth/workspace-confirm")
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      console.warn("Workspace resolution failed", cause)
      const message = workspaceResolutionMessage(cause)
      setError(message)
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("workspace:title")}
        leftIcon="chevron-left"
        onLeftPress={() => {
          requestGeneration.current += 1
          clearCandidate()
          goBack()
        }}
      />
      <ScrollView
        contentContainerClassName="flex-grow"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <View className="flex-1 p-4">
          <Text preset="heading" className="text-2xl font-bold text-foreground mb-2">
            {translate("workspace:heading")}
          </Text>
          <Text className="text-base text-muted-foreground mb-8">{translate("workspace:description")}</Text>

          <View className="mb-3">
            <Text className="text-sm font-medium text-foreground mb-2" text={translate("workspace:urlLabel")} />
            <View
              className={`flex-row items-center h-12 border rounded-lg px-3 bg-background dark:bg-transparent dark:shadow-sm ${
                error ? "border-destructive" : "border-border"
              }`}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                className="flex-1 text-base text-foreground"
                editable={!loading}
                hitSlop={{top: 16, bottom: 16}}
                keyboardType="url"
                placeholder={translate("workspace:urlPlaceholder")}
                placeholderTextColor={theme.colors.textDim}
                returnKeyType="go"
                textContentType="URL"
                value={workspaceUrl}
                onChangeText={setWorkspaceUrl}
                onSubmitEditing={() => void resolveWorkspace()}
              />
            </View>
            <Text
              className={`text-xs mt-2 ${error ? "text-destructive" : "text-muted-foreground"}`}
              text={error ?? translate("workspace:urlHelper")}
            />
          </View>

          <Button
            className="mt-3"
            preset="primary"
            text={translate("common:continue")}
            onPress={() => void resolveWorkspace()}
            disabled={loading || !workspaceUrl.trim()}
            LeftAccessory={loading ? () => <ActivityIndicator color={theme.colors.background} /> : undefined}
          />
        </View>
      </ScrollView>
    </Screen>
  )
}

function workspaceResolutionMessage(cause: unknown): string {
  if (!(cause instanceof DeploymentResolutionError)) return translate("workspace:unknownResolutionError")
  if (cause.code === "invalid-workspace") return cause.message
  if (cause.code === "not-found") return translate("workspace:notFoundError")
  if (cause.code === "network") return translate("workspace:unknownResolutionError")
  return translate("workspace:configurationError")
}
