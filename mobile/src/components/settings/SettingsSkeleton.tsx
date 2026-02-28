import React from "react"
import {View, StyleSheet} from "react-native"

const SettingsSkeleton: React.FC = () => {
  // Render 5 placeholder rows for settings
  return (
    <View style={styles.container}>
      {[...Array(5)].map((_, idx) => (
        <View key={idx} style={styles.skeletonRow}>
          <View style={styles.skeletonLabel} />
          <View style={styles.skeletonControl} />
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
    paddingVertical: 8,
  },
  skeletonControl: {
    backgroundColor: "#ececec",
    borderRadius: 6,
    flex: 1,
    height: 18,
  },
  skeletonLabel: {
    backgroundColor: "#e0e0e0",
    borderRadius: 6,
    height: 18,
    marginRight: 16,
    width: 120,
  },
  skeletonRow: {
    alignItems: "center",
    flexDirection: "row",
    marginBottom: 8,
  },
})

export default SettingsSkeleton
