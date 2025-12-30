import {ActivityIndicator, View} from "react-native"
import {TextStyle, ViewStyle} from "react-native"

import {Button, Icon, Screen} from "@/components/ignite"
import {Text} from "@/components/ignite"
import {translate} from "@/i18n"
import {ThemedStyle} from "@/theme"

// Types
type ScreenState = "loading" | "connection" | "auth" | "outdated" | "success"

interface StatusConfig {
  icon: string
  iconColor: string
  title: string
  description: string
}

interface CloudConnectionErrorProps {
  state: ScreenState
  theme: any
  themed: any
  statusConfig: StatusConfig
  localVersion: string | null
  cloudVersion: string | null
  isUpdating: boolean
  isRetrying: boolean
  isUsingCustomUrl: boolean
  canSkipUpdate: boolean
  loadingStatus: string
  onRetry: () => void
  onUpdate: () => void
  onResetUrl: () => void
  onContinueAnyway: () => void
}

export function CloudConnectionError({
  state,
  theme,
  themed,
  statusConfig,
  localVersion,
  cloudVersion,
  isUpdating,
  isRetrying,
  isUsingCustomUrl,
  canSkipUpdate,
  loadingStatus,
  onRetry,
  onUpdate,
  onResetUrl,
  onContinueAnyway,
}: CloudConnectionErrorProps) {
  // Render
  if (state === "loading") {
    return (
      <Screen preset="fixed" safeAreaEdges={["bottom"]}>
        <View style={themed($centerContainer)}>
          <ActivityIndicator size="large" color={theme.colors.tint} />
          <Text style={themed($loadingText)}>{loadingStatus}</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <View style={themed($mainContainer)}>
        <View style={themed($infoContainer)}>
          <View style={themed($iconContainer)}>
            <Icon name={statusConfig.icon} size={80} color={statusConfig.iconColor} />
          </View>

          <Text style={themed($title)}>{statusConfig.title}</Text>
          <Text style={themed($description)}>{statusConfig.description}</Text>

          {state === "outdated" && (
            <>
              {localVersion && <Text style={themed($versionText)}>Local: v{localVersion}</Text>}
              {cloudVersion && <Text style={themed($versionText)}>Latest: v{cloudVersion}</Text>}
            </>
          )}

          <View style={themed($buttonContainer)}>
            {state === "connection" ||
              (state === "auth" && (
                <Button
                  flexContainer
                  onPress={onRetry}
                  style={themed($primaryButton)}
                  text={isRetrying ? translate("versionCheck:retrying") : translate("versionCheck:retryConnection")}
                  disabled={isRetrying}
                  LeftAccessory={
                    isRetrying ? () => <ActivityIndicator size="small" color={theme.colors.textAlt} /> : undefined
                  }
                />
              ))}

            {state === "outdated" && (
              <Button
                flexContainer
                preset="primary"
                onPress={onUpdate}
                disabled={isUpdating}
                tx="versionCheck:update"
              />
            )}

            {(state === "connection" || state === "auth") && isUsingCustomUrl && (
              <Button
                flexContainer
                onPress={onResetUrl}
                style={themed($secondaryButton)}
                tx={isRetrying ? "versionCheck:resetting" : "versionCheck:resetUrl"}
                preset="secondary"
                disabled={isRetrying}
                LeftAccessory={
                  isRetrying ? () => <ActivityIndicator size="small" color={theme.colors.text} /> : undefined
                }
              />
            )}

            {(state === "connection" || state == "auth" || (state === "outdated" && canSkipUpdate)) && (
              <Button
                flex
                flexContainer
                preset="warning"
                RightAccessory={() => <Icon name="arrow-right" size={24} color={theme.colors.text} />}
                onPress={onContinueAnyway}
                tx="versionCheck:continueAnyway"
              />
            )}
          </View>
        </View>
      </View>
    </Screen>
  )
}

// Styles
const $centerContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
})

const $loadingText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  marginTop: spacing.s4,
  fontSize: 16,
  color: colors.text,
})

const $mainContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.s6,
})

const $infoContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingTop: spacing.s8,
})

const $iconContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s8,
})

const $title: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 28,
  fontWeight: "bold",
  textAlign: "center",
  marginBottom: spacing.s4,
  color: colors.text,
})

const $description: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  textAlign: "center",
  marginBottom: spacing.s8,
  lineHeight: 24,
  paddingHorizontal: spacing.s6,
  color: colors.textDim,
})

const $versionText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  textAlign: "center",
  marginBottom: spacing.s2,
  color: colors.textDim,
})

const $buttonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  width: "100%",
  alignItems: "center",
  paddingBottom: spacing.s8,
  gap: spacing.s8,
})

const $primaryButton: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
})

const $secondaryButton: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
})
