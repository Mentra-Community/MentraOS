import {useState} from "react"
import {ActivityIndicator, TouchableOpacity, View} from "react-native"

import MicrosoftIcon from "assets/icons/component/MicrosoftIcon"

import {OrganizationBrand} from "@/components/auth/OrganizationBrand"
import {Button, Screen, Text} from "@/components/ignite"
import {useAuth} from "@/contexts/AuthContext"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useDeployment} from "@/services/deployment"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"

export default function OrganizationSignInScreen() {
  const {activeDeployment} = useDeployment()
  const {replaceAll} = useNavigationStore.getState()
  const {signInOrganization, leaveOrganization} = useAuth()
  const {theme} = useAppTheme()
  const [loading, setLoading] = useState(false)

  const cancelOrganization = async () => {
    if (loading) return
    setLoading(true)
    try {
      // Await durable local selection; native MSAL cleanup remains best effort.
      await leaveOrganization("consumer")
      replaceAll("/auth/start")
    } catch (error) {
      showAlert(translate("common:error"), error instanceof Error ? error.message : String(error), [
        {text: translate("common:ok")},
      ])
      setLoading(false)
    }
  }

  focusEffectPreventBack((event) => {
    if (event && event.actionType !== "GO_BACK" && event.actionType !== "POP") return
    cancelOrganization()
  })

  if (activeDeployment.kind !== "organization") {
    return (
      <Screen preset="fixed">
        <View className="flex-1 items-center justify-center p-6">
          <Text className="text-center text-muted-foreground mb-6">
            {translate("organization:noActiveOrganization")}
          </Text>
          <Button text={translate("organization:returnToMentra")} onPress={() => replaceAll("/auth/start")} />
        </View>
      </Screen>
    )
  }

  const signIn = async () => {
    setLoading(true)
    try {
      await signInOrganization()
      replaceAll("/")
    } catch (error) {
      console.warn("Organization sign-in failed", error)
      showAlert(translate("organization:signInFailedTitle"), translate("organization:signInFailedDescription"), [
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
            <OrganizationBrand
              displayName={activeDeployment.manifest.displayName}
              logoUrls={activeDeployment.manifest.branding?.logoUrls}
              showFallbackName
            />
          </View>

          <Text className="text-xl text-secondary-foreground text-center mb-8">
            {translate("organization:signInDescription")}
          </Text>

          <Button
            preset="secondary"
            text={translate("organization:continueWithMicrosoft")}
            onPress={() => void signIn()}
            disabled={loading}
            LeftAccessory={
              loading ? () => <ActivityIndicator color={theme.colors.foreground} /> : () => <MicrosoftIcon />
            }
          />

          <TouchableOpacity className="self-center mt-6 px-4 py-2" disabled={loading} onPress={cancelOrganization}>
            <Text
              className="text-sm text-secondary-foreground font-semibold"
              text={translate("organization:returnToMentra")}
            />
          </TouchableOpacity>
        </View>
      </View>
    </Screen>
  )
}
