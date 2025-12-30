import {useRef, useState, useEffect} from "react"
import {
  View,
  Modal,
  TouchableOpacity,
  PanResponder,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  Platform,
  ViewStyle,
  TextStyle,
} from "react-native"
import Svg, {Path, Circle} from "react-native-svg"

import {Text} from "@/components/ignite"
import {PillButton} from "@/components/ignite/PillButton"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

interface HeadUpAngleArcModalProps {
  visible: boolean
  initialAngle: number
  maxAngle?: number
  onCancel: () => void
  onSave: (angle: number) => void
}

const deg2rad = (deg: number) => (Math.PI / 180) * deg

const pointOnCircle = (cx: number, cy: number, r: number, angleDeg: number): {x: number; y: number} => {
  const angleRad = deg2rad(angleDeg)
  return {
    x: cx + r * Math.cos(angleRad),
    y: cy - r * Math.sin(angleRad),
  }
}

const describeArc = (cx: number, cy: number, r: number, startAngle: number, endAngle: number): string => {
  const start = pointOnCircle(cx, cy, r, startAngle)
  const end = pointOnCircle(cx, cy, r, endAngle)
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1

  return [`M ${start.x} ${start.y}`, `A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`].join(" ")
}

const HeadUpAngleArcModal = ({visible, initialAngle, maxAngle = 60, onCancel, onSave}: HeadUpAngleArcModalProps) => {
  const {theme, themed} = useAppTheme()
  const [angle, setAngle] = useState<number>(initialAngle)
  const initialAngleRef = useRef(initialAngle)
  const svgSize = 500
  const radius = 300
  const cx = svgSize / 5
  const cy = svgSize / 1.2
  const startAngle = 0

  useEffect(() => {
    if (visible) {
      setAngle(initialAngle)
      initialAngleRef.current = initialAngle
    }
  }, [visible, initialAngle])

  const computeAngleFromTouch = (x: number, y: number): number => {
    const dx = x - cx
    const dy = cy - y
    let theta = Math.atan2(dy, dx) * (180 / Math.PI)
    if (theta < 0) {
      theta = 0
    }
    theta = Math.max(0, Math.min(theta, maxAngle))
    return theta
  }

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: evt => {
        const newAngle = computeAngleFromTouch(evt.nativeEvent.locationX, evt.nativeEvent.locationY)
        setAngle(newAngle)
      },
      onPanResponderMove: evt => {
        const newAngle = computeAngleFromTouch(evt.nativeEvent.locationX, evt.nativeEvent.locationY)
        setAngle(newAngle)
      },
    }),
  ).current

  const backgroundArcPath = describeArc(cx, cy, radius, startAngle, maxAngle)
  const currentArcPath = describeArc(cx, cy, radius, startAngle, angle)
  const knobPos = pointOnCircle(cx, cy, radius, angle)

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={true}
      onRequestClose={() => {
        setAngle(initialAngleRef.current)
        onCancel()
      }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{flex: 1}}>
        <TouchableWithoutFeedback
          onPress={() => {
            setAngle(initialAngleRef.current)
            onCancel()
          }}>
          <View style={themed($modalOverlay)}>
            <View style={themed($modalContent)}>
              <TouchableWithoutFeedback>
                <View style={themed($modalHeader)}>
                  <Text text="Adjust Head-Up Angle" style={themed($modalLabel)} weight="bold" />
                  <TouchableOpacity
                    hitSlop={10}
                    onPress={() => {
                      setAngle(initialAngleRef.current)
                      onCancel()
                    }}>
                    <Text text="✕" style={themed($closeButton)} />
                  </TouchableOpacity>
                </View>
              </TouchableWithoutFeedback>

              <Text text="Drag the slider to adjust your HeadUp angle." style={themed($subtitle)} />

              <View style={themed($svgWrapper)} {...panResponder.panHandlers}>
                <Svg width={svgSize} height={svgSize}>
                  <Path d={backgroundArcPath} stroke={theme.colors.border} strokeWidth={7} fill="none" />
                  <Path d={currentArcPath} stroke={"#007AFF"} strokeWidth={7} fill="none" />
                  <Circle cx={knobPos.x} cy={knobPos.y} r={15} fill={"#007AFF"} />
                </Svg>
              </View>

              <Text text={`${Math.round(angle)}°`} style={themed($angleLabel)} weight="bold" />

              <View style={themed($buttonRow)}>
                <PillButton
                  text="Save"
                  variant="primary"
                  onPress={() => onSave(Math.round(angle))}
                  buttonStyle={themed($buttonFlex)}
                />
              </View>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </Modal>
  )
}

export default HeadUpAngleArcModal

const $angleLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 36,
  marginVertical: 20,
  color: colors.text,
})

const $buttonFlex: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $buttonRow: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  gap: 20,
  justifyContent: "space-between",
  width: "80%",
  marginTop: -10,
})

const $closeButton: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 22,
  paddingHorizontal: 8,
  paddingVertical: 2,
  color: colors.text,
  marginRight: -8,
})

const $modalContent: ThemedStyle<ViewStyle> = ({colors}) => ({
  alignItems: "center",
  borderRadius: 10,
  elevation: 5,
  maxHeight: "80%",
  padding: 16,
  shadowColor: "#000",
  shadowOffset: {width: 0, height: 2},
  shadowOpacity: 0.2,
  shadowRadius: 8,
  width: "90%",
  backgroundColor: colors.background,
})

const $modalHeader: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  flexDirection: "row",
  justifyContent: "space-between",
  marginBottom: 12,
  width: "100%",
})

const $modalLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  color: colors.text,
})

const $modalOverlay: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  backgroundColor: "rgba(0,0,0,0.25)",
  flex: 1,
  justifyContent: "center",
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  marginBottom: 20,
  textAlign: "center",
  color: colors.text,
})

const $svgWrapper: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  height: 400,
  justifyContent: "center",
  width: 400,
})
