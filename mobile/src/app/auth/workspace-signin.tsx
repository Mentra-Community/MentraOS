import {useState} from "react"
import {ActivityIndicator, TouchableOpacity, View} from "react-native"

import MicrosoftIcon from "assets/icons/component/MicrosoftIcon"

import {WorkspaceBrand} from "@/components/auth/WorkspaceBrand"
import {Button, Screen, Text} from "@/components/ignite"
import {useAuth} from "@/contexts/AuthContext"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useDeployment} from "@/services/deployment"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"

export default function WorkspaceSignInScreen() {
  const {activeDeployment} = useDeployment()
  const {replaceAll} = useNavigationStore.getState()
  const {signInWorkspace, leaveWorkspace} = useAuth()
  const {theme} = useAppTheme()
  const [loading, setLoading] = useState(false)

  const cancelWorkspace = () => {
    if (loading) return
    setLoading(true)
    // leaveWorkspace changes the deployment synchronously before its
    // best-effort native account cleanup. Navigate immediately so the user is
    // never stranded here by an MSAL callback failure.
    void leaveWorkspace("consumer")
    replaceAll("/auth/start")
  }

  focusEffectPreventBack((event) => {
    if (event && event.actionType !== "GO_BACK" && event.actionType !== "POP") return
    cancelWorkspace()
  })

  if (activeDeployment.kind !== "workspace") {
    return (
      <Screen preset="fixed">
        <View className="flex-1 items-center justify-center p-6">
          <Text className="text-center text-muted-foreground mb-6">{translate("workspace:noActiveWorkspace")}</Text>
          <Button text={translate("workspace:returnToMentra")} onPress={() => replaceAll("/auth/start")} />
        </View>
      </Screen>
    )
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
      <View className="flex-1">
        <View className="flex-1 justify-center p-4">
          <View className="items-center mb-6">
            <WorkspaceBrand
              displayName={activeDeployment.manifest.displayName}
              logoUrls={activeDeployment.manifest.branding?.logoUrls}
              showFallbackName
            />
          </View>

          <Text className="text-xl text-secondary-foreground text-center mb-8">
            {translate("workspace:signInDescription")}
          </Text>

          <Button
            preset="secondary"
            text={translate("workspace:continueWithMicrosoft")}
            onPress={() => void signIn()}
            disabled={loading}
            LeftAccessory={
              loading ? () => <ActivityIndicator color={theme.colors.foreground} /> : () => <MicrosoftIcon />
            }
          />

          <TouchableOpacity className="self-center mt-6 px-4 py-2" disabled={loading} onPress={cancelWorkspace}>
            <Text
              className="text-sm text-secondary-foreground font-semibold"
              text={translate("workspace:returnToMentra")}
            />
          </TouchableOpacity>
        </View>
      </View>
    </Screen>
  )
}
