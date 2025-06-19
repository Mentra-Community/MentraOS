import React from "react"
import {View, ActivityIndicator, StyleSheet, SafeAreaView} from "react-native"
import {Text} from "@/components/ignite"

const LoadingComponent = ({
  message = "Loading...",
  theme,
}: {
  message?: string
  theme?: {backgroundColor?: string; textColor?: string}
}) => {
  return (
    <SafeAreaView style={[styles.safeArea, {backgroundColor: theme?.backgroundColor || "#ffffff"}]}>
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#999999" />
        <Text text={message} style={[styles.text, {color: theme?.textColor || "#000000"}]} />
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  loadingContainer: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    marginHorizontal: 20,
  },
  safeArea: {
    flex: 1,
  },
  text: {
    fontSize: 18,
    marginBottom: 20,
    textAlign: "center",
  },
})

export default LoadingComponent
