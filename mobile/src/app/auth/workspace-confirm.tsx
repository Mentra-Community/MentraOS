import {View} from "react-native"

import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useDeployment} from "@/services/deployment"
import {useNavigationStore} from "@/stores/navigation"

export default function WorkspaceConfirmScreen() {
  const {candidate, clearCandidate, store} = useDeployment()
  const {goBack, replace} = useNavigationStore.getState()
  const {theme} = useAppTheme()

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

  const activate = () => {
    store.activate(candidate)
    clearCandidate()
    replace("/auth/workspace-signin")
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("workspace:confirmTitle")}
        leftText={translate("common:cancel")}
        onLeftPress={() => {
          clearCandidate()
          goBack()
        }}
      />
      <View className="flex-1 p-4">
        <View className="items-center py-8">
          <Icon name="office-building" size={52} color={theme.colors.foreground} />
          <Text preset="heading" className="text-2xl font-bold text-foreground text-center mt-5">
            {translate("workspace:connectTo", {name: candidate.manifest.displayName})}
          </Text>
        </View>

        <View className="border border-border rounded-xl p-4 gap-4">
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
        <View className="flex-1" />
        <Button
          preset="primary"
          text={translate("workspace:continueTo", {name: candidate.manifest.displayName})}
          onPress={activate}
        />
      </View>
    </Screen>
  )
}
