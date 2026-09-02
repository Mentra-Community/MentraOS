import {useState} from "react"
import {ActivityIndicator, ScrollView, View} from "react-native"

import {WorkspaceBrand} from "@/components/auth/WorkspaceBrand"
import {Button, Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useDeployment} from "@/services/deployment"
import {useNavigationStore} from "@/stores/navigation"
import {LogoutUtils} from "@/utils/LogoutUtils"

export default function WorkspaceConfirmScreen() {
  const {candidate, clearCandidate, store} = useDeployment()
  const {goBack, replace} = useNavigationStore.getState()
  const {theme} = useAppTheme()
  const [activating, setActivating] = useState(false)

  if (!candidate) {
    return (
      <Screen preset="fixed">
        <Header title={translate("workspace:title")} leftIcon="chevron-left" onLeftPress={goBack} />
        <View className="flex-1 items-center justify-center p-6">
          <Text className="text-center text-muted-foreground mb-6">{translate("workspace:candidateExpired")}</Text>
          <Button text={translate("workspace:enterAnotherUrl")} onPress={() => replace("/auth/workspace")} />
        </View>
      </Screen>
    )
  }

  const hostname = new URL(candidate.workspaceOrigin).hostname
  const authLabel =
    candidate.manifest.auth.mode === "microsoft-entra"
      ? translate("workspace:microsoftOrganizationAccount")
      : translate("workspace:mentraAccount")

  const activate = async () => {
    if (activating) return
    setActivating(true)
    try {
      // Workspace activation is a hard local identity boundary. Clear any
      // consumer settings, cached miniapp data, and connected device before
      // persisting the customer deployment. Do not call Mentra sign-out: a
      // fresh workspace enrollment must not contact Mentra infrastructure.
      await LogoutUtils.performCompleteLogout({skipAuthSignOut: true})
      store.activate(candidate)
      clearCandidate()
      replace("/auth/workspace-signin")
    } finally {
      setActivating(false)
    }
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("workspace:confirmTitle")}
        leftIcon="chevron-left"
        onLeftPress={() => {
          clearCandidate()
          goBack()
        }}
      />
      <ScrollView contentContainerClassName="flex-grow" showsVerticalScrollIndicator={false}>
        <View className="flex-1 p-4">
          <View className="items-center pt-6 pb-8">
            <WorkspaceBrand
              displayName={candidate.manifest.displayName}
              logoUrls={candidate.manifest.branding?.logoUrls}
            />
            <Text preset="heading" className="text-2xl font-bold text-foreground text-center mt-5">
              {translate("workspace:connectTo", {name: candidate.manifest.displayName})}
            </Text>
          </View>

          <View className="bg-primary-foreground rounded-2xl p-4 gap-4">
            <View>
              <Text className="text-xs text-muted-foreground">{translate("workspace:workspaceLabel")}</Text>
              <Text className="text-base text-foreground mt-1">{hostname}</Text>
            </View>
            <View>
              <Text className="text-xs text-muted-foreground">{translate("workspace:signInLabel")}</Text>
              <Text className="text-base text-foreground mt-1">{authLabel}</Text>
            </View>
          </View>

          <Text className="text-sm text-muted-foreground mt-4">{translate("workspace:confirmDescription")}</Text>
          <Button
            className="mt-6"
            preset="primary"
            text={translate("common:continue")}
            onPress={() => void activate()}
            disabled={activating}
            LeftAccessory={activating ? () => <ActivityIndicator color={theme.colors.background} /> : undefined}
          />
        </View>
      </ScrollView>
    </Screen>
  )
}
