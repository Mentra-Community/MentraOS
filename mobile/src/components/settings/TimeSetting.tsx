import {useState, useEffect, useRef} from "react"
import {View, Pressable, Modal, ScrollView, Platform, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

type TimeSettingProps = {
  label: string
  value: number // Total seconds
  onValueChange: (value: number) => void
  containerStyle?: ViewStyle
  showSeconds?: boolean
  isFirst?: boolean
  isLast?: boolean
}

const TimeSetting: React.FC<TimeSettingProps> = ({
  label,
  value,
  onValueChange,
  containerStyle,
  showSeconds = true,
  isFirst,
  isLast,
}) => {
  const {theme, themed} = useAppTheme()

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
  const [modalVisible, setModalVisible] = useState(false)
  const [localHours, setLocalHours] = useState(0)
  const [localMinutes, setLocalMinutes] = useState(0)
  const [localSeconds, setLocalSeconds] = useState(0)

  // Refs for scroll positions
  const hoursScrollRef = useRef<ScrollView>(null)
  const minutesScrollRef = useRef<ScrollView>(null)
  const secondsScrollRef = useRef<ScrollView>(null)

  // Helper to ensure a safe number
  const safeNumber = (n: any) => (typeof n === "number" && !isNaN(n) ? n : 0)

  // Convert total seconds to hours, minutes, seconds
  useEffect(() => {
    const totalSeconds = safeNumber(value)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60

    setLocalHours(hours)
    setLocalMinutes(minutes)
    setLocalSeconds(seconds)
  }, [value])

  const REPEATS = 5 // Must be odd for perfect centering
  const ITEM_HEIGHT = 44
  const _VISIBLE_ITEMS = 3
  const CENTER_SLOT = Math.floor(REPEATS / 2)

  // Function to scroll to center the selected value
  const scrollToCenter = (scrollRef: React.RefObject<ScrollView>, value: number, max: number) => {
    if (scrollRef.current) {
      // Center slot index for the selected value
      const centerIndex = CENTER_SLOT * max + value
      const targetOffset = centerIndex * ITEM_HEIGHT
      scrollRef.current.scrollTo({y: targetOffset, animated: false})
    }
  }

  // Function to check if an item is in the center position
  const isItemInCenter = (itemIndex: number, value: number, max: number) => {
    // Center slot index for the selected value
    const centerIndex = CENTER_SLOT * max + value
    return itemIndex === centerIndex
  }

  // Scroll to center when modal opens or values change
  useEffect(() => {
    if (modalVisible) {
      setTimeout(() => {
        scrollToCenter(hoursScrollRef, localHours, 100)
        scrollToCenter(minutesScrollRef, localMinutes, 60)
        scrollToCenter(secondsScrollRef, localSeconds, 60)
      }, 100)
    }
  }, [modalVisible, localHours, localMinutes, localSeconds])

  const formatTime = (hours: number, minutes: number, seconds: number) => {
    hours = safeNumber(hours)
    minutes = safeNumber(minutes)
    seconds = safeNumber(seconds)
    if (showSeconds) {
      return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    } else {
      return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`
    }
  }

  const handleConfirm = () => {
    const totalSeconds = localHours * 3600 + localMinutes * 60 + localSeconds
    onValueChange(totalSeconds)
    setModalVisible(false)
  }

  const handleCancel = () => {
    // Reset to original values
    const totalSeconds = safeNumber(value)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60

    setLocalHours(hours)
    setLocalMinutes(minutes)
    setLocalSeconds(seconds)
    setModalVisible(false)
  }

  const _generateTimeArray = (max: number) => {
    return Array.from({length: max}, (_, i) => i)
  }

  const generateInfiniteArray = (max: number, repeats: number = REPEATS) => {
    const baseArray = Array.from({length: max}, (_, i) => i)
    return Array.from({length: repeats}, () => baseArray).flat()
  }

  const hoursArray = generateInfiniteArray(100) // 0-99, repeated 5 times
  const minutesArray = generateInfiniteArray(60) // 0-59, repeated 5 times
  const secondsArray = generateInfiniteArray(60) // 0-59, repeated 5 times

  // When calculating currentHours/currentMinutes/currentSeconds:
  const currentTotalSeconds = safeNumber(value)
  const currentHours = Math.floor(currentTotalSeconds / 3600)
  const currentMinutes = Math.floor((currentTotalSeconds % 3600) / 60)
  const currentSeconds = currentTotalSeconds % 60

  // Add a helper to trigger scrollToCenter on layout
  const handleScrollViewLayout = (scrollRef: React.RefObject<ScrollView>, value: number, max: number) => () => {
    scrollToCenter(scrollRef, value, max)
  }

  return (
    <View style={[themed($container), groupedStyle, containerStyle]}>
      <Text style={themed($label)} weight="semiBold" text={label} />

      <Pressable
        style={themed($timeButton)}
        onPress={() => setModalVisible(true)}
        android_ripple={{color: "rgba(0, 0, 0, 0.1)"}}>
        <Text style={themed($timeText)}>{formatTime(currentHours, currentMinutes, currentSeconds)}</Text>
        <Text style={themed($chevronText)}>›</Text>
      </Pressable>

      <Modal visible={modalVisible} animationType="slide" transparent={true} onRequestClose={handleCancel}>
        <View style={themed($modalOverlay)}>
          <View style={themed($modalContent)}>
            <View style={themed($modalHeader)}>
              <Text style={themed($modalTitle)} weight="semiBold" text={label} />
            </View>

            <View style={themed($pickerContainer)}>
              {/* Hours Picker */}
              <View style={themed($pickerColumn)}>
                <Text style={themed($pickerLabel)}>Hours</Text>
                <ScrollView
                  ref={hoursScrollRef}
                  style={themed($pickerScroll)}
                  showsVerticalScrollIndicator={false}
                  snapToInterval={ITEM_HEIGHT}
                  snapToAlignment="center"
                  decelerationRate="fast"
                  scrollEventThrottle={16}
                  contentContainerStyle={{paddingTop: ITEM_HEIGHT, paddingBottom: ITEM_HEIGHT}}
                  onLayout={handleScrollViewLayout(hoursScrollRef, localHours, 100)}
                  onMomentumScrollEnd={event => {
                    const offsetY = event.nativeEvent.contentOffset.y
                    const index = Math.round(offsetY / ITEM_HEIGHT)
                    const actualHour = index % 100
                    setLocalHours(actualHour)
                  }}>
                  {hoursArray.map((hour, index) => (
                    <Pressable
                      key={`${hour}-${index}`}
                      style={[
                        themed($pickerItem),
                        isItemInCenter(index, localHours, 100) && themed($pickerItemSelected),
                      ]}
                      onPress={() => setLocalHours(hour)}>
                      <Text
                        style={[
                          themed($pickerItemText),
                          isItemInCenter(index, localHours, 100) && themed($pickerItemTextSelected),
                        ]}>
                        {hour.toString().padStart(2, "0")}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>

              {/* Minutes Picker */}
              <View style={themed($pickerColumn)}>
                <Text style={themed($pickerLabel)}>Minutes</Text>
                <ScrollView
                  ref={minutesScrollRef}
                  style={themed($pickerScroll)}
                  showsVerticalScrollIndicator={false}
                  snapToInterval={ITEM_HEIGHT}
                  snapToAlignment="center"
                  decelerationRate="fast"
                  scrollEventThrottle={16}
                  contentContainerStyle={{paddingTop: ITEM_HEIGHT, paddingBottom: ITEM_HEIGHT}}
                  onLayout={handleScrollViewLayout(minutesScrollRef, localMinutes, 60)}
                  onMomentumScrollEnd={event => {
                    const offsetY = event.nativeEvent.contentOffset.y
                    const index = Math.round(offsetY / ITEM_HEIGHT)
                    const actualMinute = index % 60
                    setLocalMinutes(actualMinute)
                  }}>
                  {minutesArray.map((minute, index) => (
                    <Pressable
                      key={`${minute}-${index}`}
                      style={[
                        themed($pickerItem),
                        isItemInCenter(index, localMinutes, 60) && themed($pickerItemSelected),
                      ]}
                      onPress={() => setLocalMinutes(minute)}>
                      <Text
                        style={[
                          themed($pickerItemText),
                          isItemInCenter(index, localMinutes, 60) && themed($pickerItemTextSelected),
                        ]}>
                        {minute.toString().padStart(2, "0")}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>

              {/* Seconds Picker (if enabled) */}
              {showSeconds && (
                <View style={themed($pickerColumn)}>
                  <Text style={themed($pickerLabel)}>Seconds</Text>
                  <ScrollView
                    ref={secondsScrollRef}
                    style={themed($pickerScroll)}
                    showsVerticalScrollIndicator={false}
                    snapToInterval={ITEM_HEIGHT}
                    snapToAlignment="center"
                    decelerationRate="fast"
                    scrollEventThrottle={16}
                    contentContainerStyle={{paddingTop: ITEM_HEIGHT, paddingBottom: ITEM_HEIGHT}}
                    onLayout={handleScrollViewLayout(secondsScrollRef, localSeconds, 60)}
                    onMomentumScrollEnd={event => {
                      const offsetY = event.nativeEvent.contentOffset.y
                      const index = Math.round(offsetY / ITEM_HEIGHT)
                      const actualSecond = index % 60
                      setLocalSeconds(actualSecond)
                    }}>
                    {secondsArray.map((second, index) => (
                      <Pressable
                        key={`${second}-${index}`}
                        style={[
                          themed($pickerItem),
                          isItemInCenter(index, localSeconds, 60) && themed($pickerItemSelected),
                        ]}
                        onPress={() => setLocalSeconds(second)}>
                        <Text
                          style={[
                            themed($pickerItemText),
                            isItemInCenter(index, localSeconds, 60) && themed($pickerItemTextSelected),
                          ]}>
                          {second.toString().padStart(2, "0")}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              )}
            </View>

            <View style={themed($modalFooter)}>
              <Pressable style={themed($cancelButton)} onPress={handleCancel}>
                <Text style={themed($cancelButtonText)}>Cancel</Text>
              </Pressable>
              <Pressable style={themed($confirmButton)} onPress={handleConfirm}>
                <Text style={themed($confirmButtonText)}>Confirm</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
  width: "100%",
})

const $label: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.text,
  marginBottom: spacing.s2,
})

const $timeButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  backgroundColor: colors.backgroundAlt,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 6,
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s2,
  minHeight: Platform.OS === "ios" ? 44 : 48,
})

const $timeText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.text,
  fontFamily: "monospace",
})

const $chevronText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  color: colors.textDim,
  fontWeight: "bold",
})

const $modalOverlay: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  backgroundColor: "rgba(0, 0, 0, 0.5)",
  justifyContent: "center",
  alignItems: "center",
})

const $modalContent: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.backgroundAlt,
  borderRadius: 12,
  padding: spacing.s6,
  width: "90%",
  maxWidth: 400,
})

const $modalHeader: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  marginBottom: spacing.s6,
})

const $modalTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  color: colors.text,
})

const $pickerContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-around",
  marginBottom: spacing.s6,
})

const $pickerColumn: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  flex: 1,
})

const $pickerLabel: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.textDim,
  marginBottom: spacing.s2,
  fontWeight: "500",
})

const $pickerScroll: ThemedStyle<ViewStyle> = () => ({
  height: 132, // 3 items visible (44 * 3)
})

const $pickerItem: ThemedStyle<ViewStyle> = ({spacing}) => ({
  height: 44,
  justifyContent: "center",
  alignItems: "center",
  paddingHorizontal: spacing.s3,
})

const $pickerItemSelected: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.palette?.primary300 || "#007AFF",
  borderRadius: 6,
})

const $pickerItemText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.text,
  fontFamily: "monospace",
})

const $pickerItemTextSelected: ThemedStyle<TextStyle> = () => ({
  color: "#FFFFFF",
  fontWeight: "600",
})

const $modalFooter: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  gap: spacing.s4,
})

const $cancelButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flex: 1,
  backgroundColor: colors.backgroundAlt,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 6,
  paddingVertical: spacing.s3,
  alignItems: "center",
})

const $confirmButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flex: 1,
  backgroundColor: colors.palette?.primary300 || "#007AFF",
  borderRadius: 6,
  paddingVertical: spacing.s3,
  alignItems: "center",
})

const $cancelButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.text,
  fontWeight: "500",
})

const $confirmButtonText: ThemedStyle<TextStyle> = () => ({
  fontSize: 16,
  color: "#FFFFFF",
  fontWeight: "600",
})

export default TimeSetting
