import {useEffect, useRef, useState} from "react"
import {ActivityIndicator, Keyboard, ScrollView, TextInput, View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {DeploymentResolutionError, resolveDeploymentCandidate, useDeployment} from "@/services/deployment"
import {useNavigationStore} from "@/stores/navigation"

export default function OrganizationScreen() {
  const [organizationUrl, setOrganizationUrl] = useState("")
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

  const resolveOrganization = async () => {
    const generation = requestGeneration.current + 1
    requestGeneration.current = generation
    Keyboard.dismiss()
    setError(null)
    setLoading(true)
    try {
      const candidate = await resolveDeploymentCandidate(organizationUrl, {
        allowInsecureLocalhost: __DEV__,
      })
      if (generation !== requestGeneration.current) return
      setCandidate(candidate)
      push("/auth/organization-confirm")
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      console.warn("Organization resolution failed", cause)
      const message = organizationResolutionMessage(cause)
      setError(message)
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("organization:title")}
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
            {translate("organization:heading")}
          </Text>
          <Text className="text-base text-muted-foreground mb-8">{translate("organization:description")}</Text>

          <View className="mb-3">
            <Text className="text-sm font-medium text-foreground mb-2" text={translate("organization:urlLabel")} />
            <View
              className={`flex-row items-center h-12 border rounded-lg px-3 bg-background dark:bg-transparent dark:shadow-sm ${
                error ? "border-destructive" : "border-border"
              }`}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                className="flex-1 h-full py-0 text-[16px] text-foreground"
                editable={!loading}
                hitSlop={{top: 16, bottom: 16}}
                keyboardType="url"
                placeholder={translate("organization:urlPlaceholder")}
                placeholderTextColor={theme.colors.textDim}
                returnKeyType="go"
                textContentType="URL"
                value={organizationUrl}
                onChangeText={setOrganizationUrl}
                onSubmitEditing={() => void resolveOrganization()}
              />
            </View>
            <Text
              className={`text-xs mt-2 ${error ? "text-destructive" : "text-muted-foreground"}`}
              text={error ?? translate("organization:urlHelper")}
            />
          </View>

          <Button
            className="mt-3"
            preset="primary"
            text={translate("common:continue")}
            onPress={() => void resolveOrganization()}
            disabled={loading || !organizationUrl.trim()}
            LeftAccessory={loading ? () => <ActivityIndicator color={theme.colors.background} /> : undefined}
          />
        </View>
      </ScrollView>
    </Screen>
  )
}

function organizationResolutionMessage(cause: unknown): string {
  if (!(cause instanceof DeploymentResolutionError)) return translate("organization:unknownResolutionError")
  if (cause.code === "invalid-organization") return cause.message
  if (cause.code === "not-found") return translate("organization:notFoundError")
  if (cause.code === "network") return translate("organization:unknownResolutionError")
  return translate("organization:configurationError")
}
