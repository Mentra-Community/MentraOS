import AppleIcon from "assets/icons/component/AppleIcon";
import * as React from "react";
import {StyleSheet, View} from "react-native";
import {SafeAreaView} from "react-native-safe-area-context";
import { Spacer } from "../misc/Spacer";
import { spacing } from "@/theme";
import { PillButton } from "./PillButton";
import { useAppTheme } from "@/utils/useAppTheme";
import { color } from "react-native-elements/dist/helpers";
import { Text } from "./Text";
interface BasicDialogProps {
  title: string;
  description?: string | React.ReactNode;
  icon?: React.ReactNode;
  leftButtonText?: string;
  rightButtonText: string;
  onLeftPress?: () => void;
  onRightPress: () => void;
  
}

const BasicDialog = ({
  title,
  description,
  icon,
  leftButtonText,
  rightButtonText,
  onLeftPress,
  onRightPress
}: BasicDialogProps) => {
	const { theme: { isDark }, } = useAppTheme();
  return (
    <View style={[styles.basicDialog, styles.basicDialogFlexBox, { backgroundColor: isDark ? "#141834" : "white" }]}>
      <View style={[styles.titleDescription, styles.basicDialogFlexBox]}>
        {icon}
        {title && <Text text={title} style={[styles.headline, styles.labelTypo1, {color: isDark ? "#d5d8f5": "black"}]} />}
        {description && (
          <Text text={typeof description === 'string' ? description : undefined} style={[styles.labelTypo, {color: isDark ? "#d5d8f5": "black"} ]}>
            {typeof description !== 'string' ? description : undefined}
          </Text>
        )}
      </View>
	  <Spacer  height={spacing.xxl}/>
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
  );
};

const styles = StyleSheet.create({
  	basicDialogFlexBox: {
    		alignItems: "center",
    		justifyContent: "center",
    		overflow: "hidden"
  	},
  	labelTypo1: {
    		color: "#f9f8fe",
    		fontWeight: "500",
    		letterSpacing: 1.7,
    		fontSize: 17
  	},
  	labelTypo: {
    		textAlign: "left"
  	},
  	actions1FlexBox: {
    		flexDirection: "row",
    		alignItems: "center"
  	},
  
  	headline: {
    		textAlign: "center",
    		color: "#f9f8fe",
    		alignSelf: "stretch"
  	},
  	oneForeground: {
    		color: "#abaaff"
  	},
  	supportingText: {
    		fontSize: 15,
    		letterSpacing: 0.6,
    		lineHeight: 20,
    		alignSelf: "stretch"
  	},
  	titleDescription: {
    		paddingHorizontal: 24,
    		paddingTop: 24,
    		gap: 16,
    		alignSelf: "stretch",
    		justifyContent: "center"
  	},
  	actions1: {
    		paddingLeft: 8,
    		paddingTop: 20,
    		paddingRight: 24,
    		paddingBottom: 20,
    		gap: 8,
    		overflow: "hidden"
  	},
  	leftButtonStyle: {
    		marginRight: 8,
  	},
  	rightButtonStyle: {
    		// Right button takes remaining space
  	},
  	actions: {
    		alignItems: "flex-end",
    		alignSelf: "stretch",
    		overflow: "hidden"
  	},
  	basicDialog: {
    		shadowColor: "rgba(0, 0, 0, 0.25)",
    		shadowOffset: {
      			width: 0,
      			height: 4
    		},
    		shadowRadius: 4,
    		elevation: 4,
    		shadowOpacity: 1,
    		borderRadius: 28,
    		width: "100%",
    		minWidth: "50%",
    		maxWidth: "100%",
    		justifyContent: "center"
  	}
});

export default BasicDialog;
