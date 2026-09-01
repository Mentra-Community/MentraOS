import {useState} from "react"
import {ActivityIndicator, Keyboard, View} from "react-native"

import {Button, Header, Screen, Text, TextField} from "@/components/ignite"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {DeploymentResolutionError, resolveDeploymentCandidate, useDeployment} from "@/services/deployment"

export default function WorkspaceScreen() {
  const [workspaceUrl, setWorkspaceUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const {goBack, push} = useNavigationStore.getState()
  const {setCandidate, clearCandidate} = useDeployment()

  const resolveWorkspace = async () => {
    Keyboard.dismiss()
    setError(null)
    setLoading(true)
    try {
      const candidate = await resolveDeploymentCandidate(workspaceUrl, {
        allowInsecureLocalhost: __DEV__,
      })
      setCandidate(candidate)
      push("/auth/workspace-confirm")
    } catch (cause) {
      const message =
        cause instanceof DeploymentResolutionError ? cause.message : translate("workspace:unknownResolutionError")
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("workspace:title")}
        leftIcon="chevron-left"
        onLeftPress={() => {
          clearCandidate()
          goBack()
        }}
      />
      <View className="flex-1 p-4">
        <Text preset="heading" className="text-2xl font-bold text-foreground mb-2">
          {translate("workspace:heading")}
        </Text>
        <Text className="text-base text-muted-foreground mb-8">{translate("workspace:description")}</Text>

        <TextField
          label={translate("workspace:urlLabel")}
          placeholder={translate("workspace:urlPlaceholder")}
          value={workspaceUrl}
          onChangeText={setWorkspaceUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
          returnKeyType="go"
          onSubmitEditing={resolveWorkspace}
          status={error ? "error" : undefined}
          helper={error ?? translate("workspace:urlHelper")}
          editable={!loading}
          autoFocus
        />

        <View className="flex-1" />
        <Button
          preset="primary"
          text={translate("common:continue")}
          onPress={resolveWorkspace}
          disabled={loading || !workspaceUrl.trim()}
          LeftAccessory={loading ? () => <ActivityIndicator /> : undefined}
        />
      </View>
    </Screen>
  )
}
