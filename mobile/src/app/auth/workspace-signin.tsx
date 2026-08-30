import {useState} from "react"
import {ActivityIndicator, View} from "react-native"

import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useDeployment} from "@/services/deployment"
import {useNavigationStore} from "@/stores/navigation"
import {useAuth} from "@/contexts/AuthContext"
import showAlert from "@/utils/AlertUtils"

export default function WorkspaceSignInScreen() {
  const {activeDeployment, store} = useDeployment()
  const {replaceAll} = useNavigationStore.getState()
  const {theme} = useAppTheme()
  const {signInWorkspace} = useAuth()
  const [loading, setLoading] = useState(false)

  if (activeDeployment.kind !== "workspace") {
    return (
      <Screen preset="fixed">
        <Header title={translate("workspace:title")} />
        <View className="flex-1 items-center justify-center p-6">
          <Text className="text-center text-muted-foreground mb-6">{translate("workspace:noActiveWorkspace")}</Text>
          <Button text={translate("workspace:returnToMentra")} onPress={() => replaceAll("/auth/start")} />
        </View>
      </Screen>
    )
  }

  const cancelWorkspace = () => {
    store.returnToMentra()
    replaceAll("/auth/start")
  }

  const signIn = async () => {
    setLoading(true)
    try {
      await signInWorkspace()
      replaceAll("/")
    } catch (error) {
      console.warn("Workspace sign-in failed", error)
      showAlert(translate("workspace:signInFailedTitle"), translate("workspace:signInFailedDescription"), [
        {text: translate("common:ok")},
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <Screen preset="fixed">
      <Header
        title={activeDeployment.manifest.displayName}
        rightText={translate("workspace:change")}
        onRightPress={() => replaceAll("/auth/workspace")}
      />
      <View className="flex-1 items-center justify-center p-6">
        <Icon name="office-building" size={64} color={theme.colors.foreground} />
        <Text preset="heading" className="text-2xl font-bold text-foreground text-center mt-6">
          {activeDeployment.manifest.displayName}
        </Text>
        <Text className="text-base text-muted-foreground text-center mt-3 mb-10">
          {translate("workspace:signInDescription")}
        </Text>
        <Button
          preset="primary"
          text={translate("workspace:continueWithMicrosoft")}
          onPress={signIn}
          disabled={loading}
          LeftAccessory={loading ? () => <ActivityIndicator /> : undefined}
        />
        <Button
          preset="secondary"
          text={translate("workspace:returnToMentra")}
          onPress={cancelWorkspace}
          className="mt-4"
        />
      </View>
    </Screen>
  )
}
