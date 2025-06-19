// SelectSetting.tsx
import React, {useState} from "react"
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
} from "react-native"
import {useAppTheme} from "@/utils/useAppTheme"
import {Icon, Text} from "@/components/ignite"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"

type Option = {
  label: string
  value: string
}

type Theme = {
  backgroundColor: string
  textColor: string
}

type SelectSettingProps = {
  label: string
  value: string
  options: Option[]
  onValueChange: (value: string) => void
  description?: string
}

const SelectSetting: React.FC<SelectSettingProps> = ({label, value, options, onValueChange, description}) => {
  const {theme, themed} = useAppTheme()
  const [modalVisible, setModalVisible] = useState(false)

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
        <Text text={label} style={[styles.label, {color: theme.colors.text}]} />
        <View style={styles.valueContainer}>
          <Text text={selectedLabel} style={[styles.selectText, {color: theme.colors.textDim}]} />
          <Icon icon="caretRight" size={16} color={theme.colors.textDim} style={styles.chevron} />
        </View>
      </TouchableOpacity>
      {description && <Text text={description} style={[styles.description, {color: theme.colors.textDim}]} />}
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
                    <Text text={label} style={[styles.modalLabel, {color: theme.colors.textDim}]} />
                  </View>
                  <FlatList
                    data={options}
                    keyExtractor={item => item.value}
                    keyboardShouldPersistTaps="always"
                    style={[styles.optionsList, {backgroundColor: theme.colors.background}]}
                    contentContainerStyle={{backgroundColor: theme.colors.background}}
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
                          text={item.label}
                          style={[styles.optionText, {color: theme.colors.text, flex: 1, marginLeft: theme.spacing.xs}]}
                        />
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
  description: {
    flexWrap: "wrap",
    fontSize: 12,
    marginTop: 4,
    paddingHorizontal: 20,
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

export default SelectSetting
