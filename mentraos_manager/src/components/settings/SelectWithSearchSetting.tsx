// SelectWithSearchSetting.tsx
import {useAppTheme} from "@/utils/useAppTheme"
import React, {useState, useMemo} from "react"
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Modal,
  TouchableOpacity,
  FlatList,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
} from "react-native"
import {Icon} from "@/components/ignite"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"
import SearchIcon from "../../../assets/icons/component/SearchIcon"

type Option = {
  label: string
  value: string
}

type Theme = {
  backgroundColor: string
  textColor: string
}

type SelectWithSearchSettingProps = {
  label: string
  value: string
  options: Option[]
  onValueChange: (value: string) => void
}

const SelectWithSearchSetting: React.FC<SelectWithSearchSettingProps> = ({label, value, options, onValueChange}) => {
  const {theme, themed} = useAppTheme()

  const [search, setSearch] = useState("")
  const [modalVisible, setModalVisible] = useState(false)

  // Filter options based on search
  const filteredOptions = useMemo(() => {
    if (!search) return options
    return options.filter(option => option.label.toLowerCase().includes(search.toLowerCase()))
  }, [search, options])

  const selectedLabel = options.find(option => option.value === value)?.label || "Select..."

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[
          styles.selectRow,
          {
            backgroundColor: theme.colors.background,
            borderRadius: theme.spacing.sm,
            paddingVertical: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg - theme.spacing.xxs, // 20px
          },
        ]}
        onPress={() => setModalVisible(true)}
        activeOpacity={0.7}>
        <Text style={[styles.label, {color: theme.colors.text}]}>{label}</Text>
        <View style={styles.valueContainer}>
          <Text style={[styles.selectText, {color: theme.colors.textDim}]}>{selectedLabel}</Text>
          <Icon icon="caretRight" size={16} color={theme.colors.textDim} style={styles.chevron} />
        </View>
      </TouchableOpacity>
      <Modal
        visible={modalVisible}
        animationType="fade"
        transparent={true}
        style={{flex: 1}}
        onRequestClose={() => setModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{flex: 1}}>
          <TouchableWithoutFeedback onPress={() => setModalVisible(false)}>
            <View style={styles.modalOverlay}>
              <TouchableWithoutFeedback>
                <View
                  style={[
                    styles.modalContent,
                    {
                      backgroundColor: theme.colors.background,
                      borderColor: theme.colors.border,
                      borderWidth: 1,
                      padding: theme.spacing.md,
                      borderRadius: theme.spacing.sm,
                      shadowRadius: theme.spacing.xs,
                    },
                  ]}>
                  <View style={[styles.modalHeader, {marginBottom: theme.spacing.sm}]}>
                    <Text style={[styles.modalLabel, {color: theme.colors.textDim}]}>{label}</Text>
                  </View>
                  <View
                    style={[
                      styles.searchContainer,
                      {
                        borderColor: theme.colors.inputBorderHighlight,
                        backgroundColor: theme.colors.background,
                        borderRadius: 100, // Pill shape
                        marginBottom: theme.spacing.sm,
                        paddingHorizontal: theme.spacing.sm,
                        paddingVertical: theme.spacing.xs,
                      },
                    ]}>
                    <SearchIcon size={20} color={theme.colors.textDim} />
                    <TextInput
                      style={[
                        styles.searchInput,
                        {
                          color: theme.colors.text,
                          flex: 1,
                          marginHorizontal: theme.spacing.xs,
                        },
                      ]}
                      placeholder="Search"
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
                    style={styles.optionsList}
                    renderItem={({item}) => (
                      <Pressable
                        style={[
                          styles.optionItem,
                          {
                            paddingVertical: theme.spacing.sm,
                            paddingRight: theme.spacing.md,
                          },
                        ]}
                        onPress={() => {
                          onValueChange(item.value)
                          setModalVisible(false)
                          setSearch("")
                        }}>
                        <MaterialCommunityIcons
                          name="check"
                          size={24}
                          color={
                            item.value === value
                              ? theme.colors.checkmark || theme.colors.palette.primary300
                              : "transparent"
                          }
                        />
                        <Text
                          style={[
                            styles.optionText,
                            {color: theme.colors.text, flex: 1, marginLeft: theme.spacing.xs},
                          ]}>
                          {item.label}
                        </Text>
                      </Pressable>
                    )}
                    ListEmptyComponent={
                      <Text style={[styles.emptyText, {color: theme.colors.text + "99"}]}>No options found</Text>
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

const styles = StyleSheet.create({
  chevron: {
    marginLeft: 2,
  },
  closeButton: {
    fontSize: 22,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  container: {
    width: "100%",
  },
  emptyText: {
    fontSize: 15,
    marginTop: 20,
    textAlign: "center",
  },
  label: {
    flex: 1,
    fontSize: 15,
  },
  modalContent: {
    elevation: 5,
    maxHeight: "70%",
    shadowColor: "#000",
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.2,
    width: "90%",
  },
  modalHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  modalLabel: {
    fontSize: 16,
    fontWeight: "normal",
  },
  modalOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.25)",
    flex: 1,
    justifyContent: "center",
  },
  optionItem: {
    alignItems: "center",
    flexDirection: "row",
    paddingLeft: 0,
  },
  optionText: {
    fontSize: 16,
  },
  optionsList: {
    flexGrow: 0,
    maxHeight: 250,
  },
  searchContainer: {
    alignItems: "center",
    borderWidth: 1,
    flexDirection: "row",
  },
  searchInput: {
    fontSize: 16,
    paddingVertical: 0, // Remove default padding
  },
  selectRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  selectText: {
    fontSize: 15,
  },
  valueContainer: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
  },
})

export default SelectWithSearchSetting
