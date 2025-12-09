import {ErrorInfo} from "react"
import {ScrollView, TextStyle, View, ViewStyle} from "react-native"

import {Button, Icon, Screen, Text} from "@/components/ignite"
import type {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export interface ErrorDetailsProps {
  error: Error
  errorInfo: ErrorInfo | null
  onReset(): void
}

/**
 * Renders the error details screen.
 * @param {ErrorDetailsProps} props - The props for the `ErrorDetails` component.
 * @returns {JSX.Element} The rendered `ErrorDetails` component.
 */
export function ErrorDetails(props: ErrorDetailsProps) {
  const {theme, themed} = useAppTheme()
  return (
    <Screen preset="fixed" safeAreaEdges={["top", "bottom"]} contentContainerStyle={themed($contentContainer)}>
      <View style={$topSection}>
        <Icon icon="ladybug" size={64} color={theme.colors.palette.angry500} />
        <Text style={themed($heading)} preset="subheading" tx="errorScreen:title" />
        <Text tx="errorScreen:friendlySubtitle" />
      </View>

      <ScrollView style={themed($errorSection)} contentContainerStyle={themed($errorSectionContentContainer)}>
        <Text style={themed($errorContent)} weight="bold" text={`${props.error}`.trim()} />
        <Text selectable style={themed($errorBacktrace)} text={`${props.errorInfo?.componentStack ?? ""}`.trim()} />
      </ScrollView>

      <Button preset="default" onPress={props.onReset} tx="errorScreen:reset" />
    </Screen>
  )
}

const $contentContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  paddingHorizontal: spacing.s6,
  paddingTop: spacing.s8,
  flex: 1,
  paddingBottom: spacing.s8,
})

const $topSection: ViewStyle = {
  flex: 1,
  alignItems: "center",
}

const $heading: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.error,
  marginBottom: spacing.s4,
})

const $errorSection: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flex: 2,
  backgroundColor: colors.separator,
  marginVertical: spacing.s6,
  borderRadius: 6,
})

const $errorSectionContentContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.s4,
})

const $errorContent: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.error,
})

const $errorBacktrace: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  marginTop: spacing.s4,
  color: colors.textDim,
})
