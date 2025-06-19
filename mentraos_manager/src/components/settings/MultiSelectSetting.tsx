import React from "react"
import {View, Text, TouchableOpacity, StyleSheet} from "react-native"
import CheckBox from "@/components/misc/CheckBox"
import {useAppTheme} from "@/utils/useAppTheme"

type Option = {
  label: string
  value: string
}

type MultiSelectSettingProps = {
  label: string
  values: string[]
  options: Option[]
  onValueChange: (selectedValues: string[]) => void
}

const MultiSelectSetting: React.FC<MultiSelectSettingProps> = ({label, values = [], options, onValueChange}) => {
  const {theme, themed} = useAppTheme()
  const toggleValue = (value: string) => {
    if (values.includes(value)) {
      onValueChange(values.filter(v => v !== value))
    } else {
      onValueChange([...values, value])
    }
  }

  return (
    <View style={styles.container}>
      <Text style={[styles.label, {color: theme.colors.text}]}>{label}</Text>
      {options.map(opt => (
        <TouchableOpacity key={opt.value} style={styles.option} onPress={() => toggleValue(opt.value)}>
          <CheckBox
            checked={values.includes(opt.value)}
            onChange={() => toggleValue(opt.value)}
            //tintColors={{ true: '#1EB1FC', false: theme.textColor }}
          />
          <Text style={[styles.optionLabel, {color: theme.colors.text}]}>{opt.label}</Text>
        </TouchableOpacity>
      ))}
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
    marginBottom: 5,
  },
  option: {
    alignItems: "center",
    flexDirection: "row",
    marginVertical: 5,
  },
  optionLabel: {
    fontSize: 16,
    marginLeft: 8,
  },
})

export default MultiSelectSetting
