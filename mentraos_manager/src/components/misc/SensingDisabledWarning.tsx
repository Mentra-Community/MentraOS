// SensingDisabledWarning.tsx
import React from "react"
import {View, Text, StyleSheet, TouchableOpacity} from "react-native"
import Icon from "react-native-vector-icons/MaterialCommunityIcons"
import {router} from "expo-router"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import {translate} from "@/i18n"

const SensingDisabledWarning: React.FC = () => {
  const {status} = useStatus()

  if (status.core_info.sensing_enabled) {
    return null
  }

  return (
    <View style={[styles.sensingWarningContainer, {backgroundColor: "#FFF3E0", borderColor: "#FFB74D"}]}>
      <View style={styles.warningContent}>
        <Icon name="microphone-off" size={22} color="#FF9800" />
        <Text style={styles.warningText}>{translate("warning:sensingDisabled")}</Text>
      </View>
      <TouchableOpacity
        style={styles.settingsButton}
        onPress={() => {
          router.push("/settings/privacy")
        }}>
        <Text style={styles.settingsButtonTextBlue}>Settings</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  sensingWarningContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    borderRadius: 12, // Match ConnectedDeviceInfo
    borderWidth: 1, // Restore border for the warning
    marginVertical: 16,
    // marginHorizontal: 8,
    alignSelf: "center",
  },
  settingsButton: {
    padding: 5,
  },
  settingsButtonTextBlue: {
    color: "#007AFF",
    fontSize: 14,
    fontWeight: "bold",
  },
  warningContent: {
    alignItems: "center",
    flexDirection: "row",
    flex: 1,
  },
  warningText: {
    color: "#E65100",
    flex: 1,
    fontSize: 14,
    fontWeight: "500",
    marginLeft: 10,
  },
})

export default SensingDisabledWarning
