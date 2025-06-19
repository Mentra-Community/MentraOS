import React, {useState} from "react"
import {Modal, View, Text, TouchableOpacity, StyleSheet, FlatList, SafeAreaView, Pressable} from "react-native"
import {useAppTheme} from "@/utils/useAppTheme"

export type PickerItem = {
  label: string
  value: string
}

type PickerSelectProps = {
  items: PickerItem[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: PickerItem // Optional placeholder like { label: 'Select...', value: '' }
  style?: {
    /** Styles for the main touchable that shows the currently selected value */
    touchable?: object
    /** Styles for the text inside the main touchable */
    touchableText?: object
    /** Styles for the entire modal background container (when open) */
    modalContainer?: object
    /** Styles for the individual item touchable */
    itemTouchable?: object
    /** Styles for the item text */
    itemText?: object
    /** Styles for the selected item text */
    selectedItemText?: object
  }
  /** Choose between 'none', 'fade', or 'slide' to control modal animation */
  modalAnimationType?: "none" | "fade" | "slide"
}

const PickerSelect: React.FC<PickerSelectProps> = ({
  items,
  value,
  onValueChange,
  placeholder,
  style = {},
  modalAnimationType = "none", // default: no animation
}) => {
  const [modalVisible, setModalVisible] = useState(false)
  const {theme} = useAppTheme()

  // Find the currently selected item.
  const selectedItem = items.find(item => item.value === value)

  // If you are using a placeholder item, you can insert it into the items array
  // or handle the logic however you want. Here’s a simple approach:
  const data = placeholder ? [placeholder, ...items] : items

  const handleItemPress = (itemValue: string) => {
    onValueChange(itemValue)
    setModalVisible(false)
  }

  return (
    <View>
      {/* The main touchable that shows the selected value and opens the modal */}
      <TouchableOpacity
        style={[
          styles.touchable,
          {backgroundColor: theme.colors.background, borderColor: theme.colors.border},
          style.touchable,
        ]}
        onPress={() => setModalVisible(true)}>
        <Text style={[styles.touchableText, {color: theme.colors.text}, style.touchableText]}>
          {selectedItem ? selectedItem.label : (placeholder?.label ?? "Select...")}
        </Text>
      </TouchableOpacity>

      {/* Modal to show all the items */}
      <Modal
        visible={modalVisible}
        transparent
        animationType={modalAnimationType} // 'none' | 'fade' | 'slide'
        onRequestClose={() => setModalVisible(false)}>
        {/* A semi-transparent background so tapping outside also closes the menu */}
        <Pressable
          style={[styles.modalContainer, {backgroundColor: theme.colors.modalOverlay}, style.modalContainer]}
          onPress={() => setModalVisible(false)}>
          {/* Use SafeAreaView or another container to prevent touches from closing the modal */}
          <SafeAreaView style={{backgroundColor: theme.colors.background, borderRadius: 8}}>
            <FlatList
              data={data}
              keyExtractor={(item, index) => `${item.value}-${index}`}
              renderItem={({item}) => {
                const isSelected = item.value === value
                return (
                  <TouchableOpacity
                    style={[styles.itemTouchable, {borderBottomColor: theme.colors.border}, style.itemTouchable]}
                    onPress={() => handleItemPress(item.value)}>
                    <Text
                      style={[
                        styles.itemText,
                        {color: theme.colors.text},
                        style.itemText,
                        isSelected && [{color: theme.colors.buttonPrimary, fontWeight: "bold"}, style.selectedItemText],
                      ]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                )
              }}
            />
          </SafeAreaView>
        </Pressable>
      </Modal>
    </View>
  )
}

export default PickerSelect

const styles = StyleSheet.create({
  itemText: {
    fontSize: 16,
  },
  itemTouchable: {
    borderBottomWidth: 1,
    padding: 16,
  },
  modalContainer: {
    flex: 1,
    justifyContent: "center",
    padding: 16,
  },
  selectedItemText: {
    // Colors handled dynamically with theme
  },
  touchable: {
    padding: 12,
    // borderWidth: 1,
    // borderRadius: 4,
  },
  touchableText: {
    fontSize: 16,
  },
})
