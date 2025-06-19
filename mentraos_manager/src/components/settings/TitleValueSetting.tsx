import {useAppTheme} from "@/utils/useAppTheme"
import React from "react"
import {View, Text, StyleSheet} from "react-native"

type TitleValueSettingProps = {
  label: string
  value: string
}

const TitleValueSetting: React.FC<TitleValueSettingProps> = ({label, value}) => {
  const {theme, themed} = useAppTheme()
  return (
    <View style={styles.container}>
      <Text style={[styles.label, {color: theme.colors.text}]}>{label}</Text>
      <Text style={[styles.value, {color: theme.colors.text}]}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 10,
    width: "100%",
  },
  label: {
    fontSize: 16,
    fontWeight: "bold",
  },
  value: {
    fontSize: 16,
    marginTop: 5,
  },
})

export default TitleValueSetting
