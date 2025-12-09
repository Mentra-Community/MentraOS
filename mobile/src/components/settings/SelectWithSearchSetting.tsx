// SelectWithSearchSetting.tsx
import {useState, useMemo, useEffect} from "react"
import {
  View,
  ViewStyle,
  TextStyle,
  TextInput,
  Modal,
  TouchableOpacity,
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

import SearchIcon from "assets/icons/component/SearchIcon"

type Option = {
  label: string
  value: string
}

type SelectWithSearchSettingProps = {
  label: string
  value: string
  options: Option[]
  onValueChange: (value: string) => void
  defaultValue?: string
  isFirst?: boolean
  isLast?: boolean
}

const SelectWithSearchSetting = ({
  label,
  value,
  options,
  onValueChange,
  defaultValue,
  isFirst,
  isLast,
}: SelectWithSearchSettingProps) => {
  const {theme, themed} = useAppTheme()

  const [search, setSearch] = useState("")
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

  // Filter options based on search
  const filteredOptions = useMemo(() => {
    if (!search) return options
    return options.filter(option => option.label.toLowerCase().includes(search.toLowerCase()))
  }, [search, options])

  const selectedLabel = options.find(option => option.value === value)?.label || translate("appSettings:select")

  return (
    <View style={themed($container)}>
      <TouchableOpacity
        style={[themed($selectButton), groupedStyle]}
        onPress={() => setModalVisible(true)}
        activeOpacity={0.7}>
        <Text text={label} style={themed($label)} />
        <View style={themed($valueContainer)}>
          <Text text={selectedLabel} style={themed($valueText)} />
          <Icon icon="caretRight" size={16} color={theme.colors.textDim} />
        </View>
      </TouchableOpacity>

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
                  <View style={themed($searchContainer)}>
                    <SearchIcon size={20} color={theme.colors.textDim} />
                    <TextInput
                      style={themed($searchInput)}
                      placeholder={translate("appSettings:search")}
                      placeholderTextColor={theme.colors.textDim}
                      value={search}
                      onChangeText={setSearch}
                      autoFocus
                    />
                    {search.length > 0 && (
                      <TouchableOpacity
                        onPress={() => setSearch("")}
                        hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                        <MaterialCommunityIcons name="close" size={20} color={theme.colors.textDim} />
                      </TouchableOpacity>
                    )}
                  </View>
                  <FlatList
                    data={filteredOptions}
                    keyExtractor={item => item.value}
                    keyboardShouldPersistTaps="always"
                    style={themed($optionsList)}
                    renderItem={({item}) => (
                      <Pressable
                        style={themed($optionItem)}
                        onPress={() => {
                          onValueChange(item.value)
                          setModalVisible(false)
                          setSearch("")
                        }}>
                        {item.value === value ? (
                          <MaterialCommunityIcons name="check" size={24} color={theme.colors.primary} />
                        ) : (
                          <View style={{width: 24, height: 24}} />
                        )}
                        <Text text={item.label} style={themed($optionText)} />
                      </Pressable>
                    )}
                    ListEmptyComponent={
                      <Text style={themed($emptyText)}>{translate("appSettings:noOptionsFound")}</Text>
                    }
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

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  flex: 1,
  fontSize: 14,
  fontWeight: "600",
  color: colors.text,
})

const $valueContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.s1,
})

const $valueText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.textDim,
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

const $searchContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  borderWidth: 1,
  borderColor: colors.border,
  backgroundColor: colors.background,
  borderRadius: 100,
  marginBottom: spacing.s3,
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s2,
})

const $searchInput: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  flex: 1,
  fontSize: 16,
  color: colors.text,
  marginHorizontal: spacing.s2,
  paddingVertical: 0,
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

const $emptyText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 15,
  textAlign: "center",
  marginTop: 20,
  color: colors.textDim,
})

export default SelectWithSearchSetting
