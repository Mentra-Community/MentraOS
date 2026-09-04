import {useFocusEffect, useNavigation} from "expo-router"
import {useCallback, useEffect, useRef, useState} from "react"
import {ActivityIndicator, ScrollView, View} from "react-native"

import {WorkspaceBrand} from "@/components/auth/WorkspaceBrand"
import {Button, Header, Screen, Text} from "@/components/ignite"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useDeployment} from "@/services/deployment"
import {useNavigationStore} from "@/stores/navigation"
import {LogoutUtils} from "@/utils/LogoutUtils"

export default function WorkspaceConfirmScreen() {
  const {candidate, clearCandidate, store} = useDeployment()
  const {goBack, replace} = useNavigationStore.getState()
  const navigation = useNavigation()
  const {theme} = useAppTheme()
  const [activating, setActivating] = useState(false)
  const activatingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )

  const cancel = useCallback(() => {
    if (activatingRef.current) return
    clearCandidate()
    goBack()
  }, [clearCandidate, goBack])

  // Android hardware back routes through the navigation store; keep it in
  // step with the header action so activation cannot be abandoned midway.
  focusEffectPreventBack(cancel)

  // iOS swipe-back and any other removal bypass the store. Block removal
  // while the local teardown runs so the captured candidate is never
  // activated on a screen the user has already left.
  useFocusEffect(
    useCallback(
      () =>
        navigation.addListener("beforeRemove", (event) => {
          if (activatingRef.current) event.preventDefault()
        }),
      [navigation],
    ),
  )

  if (!candidate) {
    return (
      <Screen preset="fixed">
        <Header
          title={translate("workspace:title")}
          leftIcon="chevron-left"
          leftIconAccessibilityLabel={translate("common:back")}
          onLeftPress={goBack}
        />
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
    if (activatingRef.current) return
    activatingRef.current = true
    setActivating(true)
    try {
      // Workspace activation is a hard local identity boundary. Clear any
      // consumer settings, cached miniapp data, and connected device before
      // persisting the customer deployment. Do not call Mentra sign-out: a
      // fresh workspace enrollment must not contact Mentra infrastructure.
      await LogoutUtils.performCompleteLogout({skipAuthSignOut: true})
      if (!mounted.current) return
      store.activate(candidate)
      clearCandidate()
      replace("/auth/workspace-signin")
    } finally {
      activatingRef.current = false
      if (mounted.current) setActivating(false)
    }
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("workspace:confirmTitle")}
        leftIcon="chevron-left"
        leftIconAccessibilityLabel={translate("common:back")}
        onLeftPress={cancel}
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
