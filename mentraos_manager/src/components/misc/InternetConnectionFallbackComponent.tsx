import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import React from "react"
import {View, Text, TouchableOpacity, StyleSheet, TextStyle} from "react-native"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"

interface InternetConnectionFallbackComponentProps {
  retry: () => void
}

export default function InternetConnectionFallbackComponent({retry}: InternetConnectionFallbackComponentProps) {
  const {theme, themed} = useAppTheme()

  return (
    <View style={styles.fallbackContainer}>
      <MaterialCommunityIcons name="alert-circle-outline" size={60} color={theme.colors.text} />
      <Text style={themed($fallbackText)}>MentraOS Store not yet available in 2.0.</Text>
      {/*<TouchableOpacity*/}
      {/*  style={[styles.retryButton, { backgroundColor: theme.selectedChipBg }]}*/}
      {/*  onPress={retry}>*/}
      {/*  <Text style={[styles.retryButtonText, { color: theme.selectedChipText }]}>*/}
      {/*    Retry*/}
      {/*  </Text>*/}
      {/*</TouchableOpacity>*/}
    </View>
  )
}

const $fallbackText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  textAlign: "center",
  marginVertical: 20,
})

const styles = StyleSheet.create({
  fallbackContainer: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  fallbackText: {
    fontFamily: "Montserrat-Regular",
    fontSize: 16,
    marginVertical: 20,
    textAlign: "center",
  },
  retryButton: {
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryButtonText: {
    fontFamily: "Montserrat-SemiBold",
    fontSize: 16,
    fontWeight: "600",
  },
})
