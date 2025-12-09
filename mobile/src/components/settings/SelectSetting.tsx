// SelectSetting.tsx
import {useEffect, useState} from "react"
import {
  View,
  ViewStyle,
  TextStyle,
  TouchableOpacity,
  Modal,
  FlatList,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
} from "react-native"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"

import {Icon, Text} from "@/components/ignite"
import {translate} from "@/i18n"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

type Option = {
  label: string
  value: string
}

type SelectSettingProps = {
  label: string
  value: string
  options: Option[]
  onValueChange: (value: string) => void
  description?: string
  defaultValue?: string
  isFirst?: boolean
  isLast?: boolean
}

const SelectSetting: React.FC<SelectSettingProps> = ({
  label,
  value,
  options,
  onValueChange,
  description,
  defaultValue,
  isFirst,
  isLast,
}) => {
  const {theme, themed} = useAppTheme()
  const [modalVisible, setModalVisible] = useState(false)

  const groupedStyle: ViewStyle | undefined =
    isFirst !== undefined || isLast !== undefined
      ? {
          borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
          borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
          borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
          borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
          marginBottom: isLast ? 0 : theme.spacing.s2,
        }
      : undefined

  // If the current value doesn't match any option, use the defaultValue
  useEffect(() => {
    if (options.length > 0 && !options.find(option => option.value === value)) {
      // Value doesn't match any option
      if (defaultValue !== undefined && options.find(option => option.value === defaultValue)) {
        // Default value exists and is valid, use it
        onValueChange(defaultValue)
      }
    }
  }, [value, options, defaultValue, onValueChange])

  const selectedLabel = options.find(option => option.value === value)?.label || translate("appSettings:select")

  // Use vertical layout for long labels
  const isVertical = selectedLabel.length > 20

  return (
    <View style={themed($container)}>
      <TouchableOpacity
        style={[themed($selectButton), groupedStyle, isVertical && themed($selectButtonVertical)]}
        onPress={() => setModalVisible(true)}
        activeOpacity={0.7}>
        <Text text={label} style={[themed($label), isVertical && themed($labelVertical)]} />
        <View style={[themed($valueContainer), isVertical && themed($valueContainerVertical)]}>
          <Text text={selectedLabel} style={themed($valueText)} />
          <Icon icon="caretRight" size={16} color={theme.colors.textDim} />
        </View>
      </TouchableOpacity>
      {description && <Text text={description} style={themed($description)} />}

      <Modal
        visible={modalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{flex: 1}}>
          <TouchableWithoutFeedback onPress={() => setModalVisible(false)}>
            <View style={themed($modalOverlay)}>
              <TouchableWithoutFeedback>
                <View style={themed($modalContent)}>
                  <View style={themed($modalHeader)}>
                    <Text text={label} style={themed($modalLabel)} />
                  </View>
                  <FlatList
                    data={options}
                    keyExtractor={item => item.value}
                    keyboardShouldPersistTaps="always"
                    style={themed($optionsList)}
                    renderItem={({item}) => (
                      <Pressable
                        style={themed($optionItem)}
                        onPress={() => {
                          onValueChange(item.value)
                          setModalVisible(false)
                        }}>
                        {item.value === value ? (
                          <MaterialCommunityIcons name="check" size={24} color={theme.colors.primary} />
                        ) : (
                          <View style={{width: 24, height: 24}} />
                        )}
                        <Text text={item.label} style={themed($optionText)} />
                      </Pressable>
                    )}
                  />
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
})

const $selectButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  width: "100%",
  backgroundColor: colors.primary_foreground,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
  borderRadius: spacing.s4,
})

const $selectButtonVertical: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "column",
  alignItems: "stretch",
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  flex: 1,
  fontSize: 14,
  fontWeight: "600",
  color: colors.text,
})

const $labelVertical: ThemedStyle<TextStyle> = ({spacing}) => ({
  flex: 0,
  marginBottom: spacing.s2,
})

const $valueContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.s1,
})

const $valueContainerVertical: ThemedStyle<ViewStyle> = () => ({
  justifyContent: "space-between",
  width: "100%",
})

const $valueText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.textDim,
})

const $description: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 12,
  color: colors.textDim,
  marginTop: spacing.s1,
  paddingHorizontal: spacing.s4,
})

const $modalOverlay: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  backgroundColor: "rgba(0,0,0,0.25)",
  justifyContent: "center",
  alignItems: "center",
})

const $modalContent: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  width: "90%",
  maxHeight: "70%",
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  padding: spacing.s4,
  shadowColor: "#000",
  shadowOffset: {width: 0, height: 2},
  shadowOpacity: 0.2,
  shadowRadius: spacing.s2,
  elevation: 5,
})

const $modalHeader: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: spacing.s3,
})

const $modalLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "600",
  color: colors.text,
})

const $optionsList: ThemedStyle<ViewStyle> = () => ({
  flexGrow: 0,
  maxHeight: 300,
})

const $optionItem: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  paddingVertical: spacing.s3,
  paddingRight: spacing.s4,
})

const $optionText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  flex: 1,
  fontSize: 16,
  color: colors.text,
  marginLeft: spacing.s2,
})

export default SelectSetting
