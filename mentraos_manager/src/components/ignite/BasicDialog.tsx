import AppleIcon from "assets/icons/component/AppleIcon"
import * as React from "react"
import {StyleSheet, View} from "react-native"
import {SafeAreaView} from "react-native-safe-area-context"
import {Spacer} from "../misc/Spacer"
import {spacing} from "@/theme"
import {PillButton} from "./PillButton"
import {useAppTheme} from "@/utils/useAppTheme"
import {color} from "react-native-elements/dist/helpers"
import {Text} from "./Text"
interface BasicDialogProps {
  title: string
  description?: string | React.ReactNode
  icon?: React.ReactNode
  leftButtonText?: string
  rightButtonText: string
  onLeftPress?: () => void
  onRightPress: () => void
}

const BasicDialog = ({
  title,
  description,
  icon,
  leftButtonText,
  rightButtonText,
  onLeftPress,
  onRightPress,
}: BasicDialogProps) => {
  const {
    theme: {isDark},
  } = useAppTheme()
  return (
    <View style={[styles.basicDialog, styles.basicDialogFlexBox, {backgroundColor: isDark ? "#141834" : "white"}]}>
      <View style={[styles.titleDescription, styles.basicDialogFlexBox]}>
        {icon}
        {title && (
          <Text text={title} style={[styles.headline, styles.labelTypo1, {color: isDark ? "#d5d8f5" : "black"}]} />
        )}
        {description && (
          <Text
            text={typeof description === "string" ? description : undefined}
            style={[styles.labelTypo, {color: isDark ? "#d5d8f5" : "black"}]}>
            {typeof description !== "string" ? description : undefined}
          </Text>
        )}
      </View>
      <Spacer height={spacing.xxl} />
      <View style={styles.actions}>
        <View style={[styles.actions1, styles.actions1FlexBox]}>
          {leftButtonText && (
            <PillButton
              text={leftButtonText}
              variant="secondary"
              onPress={onLeftPress}
              buttonStyle={styles.leftButtonStyle}
            />
          )}
          <PillButton
            text={rightButtonText}
            variant="primary"
            onPress={onRightPress}
            buttonStyle={styles.rightButtonStyle}
          />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  actions: {
    alignItems: "flex-end",
    alignSelf: "stretch",
    overflow: "hidden",
  },
  actions1: {
    gap: 8,
    overflow: "hidden",
    paddingBottom: 20,
    paddingLeft: 8,
    paddingRight: 24,
    paddingTop: 20,
  },
  actions1FlexBox: {
    alignItems: "center",
    flexDirection: "row",
  },
  basicDialog: {
    borderRadius: 28,
    elevation: 4,
    justifyContent: "center",
    maxWidth: "100%",
    minWidth: "50%",
    shadowColor: "rgba(0, 0, 0, 0.25)",
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 1,
    shadowRadius: 4,
    width: "100%",
  },

  basicDialogFlexBox: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  headline: {
    alignSelf: "stretch",
    color: "#f9f8fe",
    textAlign: "center",
  },
  labelTypo: {
    textAlign: "left",
  },
  labelTypo1: {
    color: "#f9f8fe",
    fontSize: 17,
    fontWeight: "500",
    letterSpacing: 1.7,
  },
  leftButtonStyle: {
    marginRight: 8,
  },
  oneForeground: {
    color: "#abaaff",
  },
  rightButtonStyle: {
    // Right button takes remaining space
  },
  supportingText: {
    alignSelf: "stretch",
    fontSize: 15,
    letterSpacing: 0.6,
    lineHeight: 20,
  },
  titleDescription: {
    alignSelf: "stretch",
    gap: 16,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingTop: 24,
  },
})

export default BasicDialog
