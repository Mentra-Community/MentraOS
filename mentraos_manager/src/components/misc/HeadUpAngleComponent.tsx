import React, {useRef, useState} from "react"
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  PanResponder,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  Platform,
} from "react-native"
import Svg, {Path, Circle} from "react-native-svg"
import {useAppTheme} from "@/utils/useAppTheme"
import {PillButton} from "@/components/ignite/PillButton"

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

const HeadUpAngleArcModal: React.FC<HeadUpAngleArcModalProps> = ({
  visible,
  initialAngle,
  maxAngle = 60,
  onCancel,
  onSave,
}) => {
  const {theme} = useAppTheme()
  const [angle, setAngle] = useState<number>(initialAngle)
  const svgSize = 500
  const radius = 300
  const cx = svgSize / 5
  const cy = svgSize / 1.2
  const startAngle = 0

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
    <Modal visible={visible} animationType="fade" transparent={true} onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{flex: 1}}>
        <TouchableWithoutFeedback onPress={onCancel}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, {backgroundColor: theme.colors.background}]}>
              <TouchableWithoutFeedback>
                <View style={styles.modalHeader}>
                  <Text style={[styles.modalLabel, {color: theme.colors.text}]}>Adjust Head-Up Angle</Text>
                  <TouchableOpacity hitSlop={10} onPress={onCancel}>
                    <Text style={[styles.closeButton, {color: theme.colors.text, marginRight: -8}]}>✕</Text>
                  </TouchableOpacity>
                </View>
              </TouchableWithoutFeedback>

              <Text style={[styles.subtitle, {color: theme.colors.text}]}>
                Drag the slider to adjust your HeadUp angle.
              </Text>

              <View style={styles.svgWrapper} {...panResponder.panHandlers}>
                <Svg width={svgSize} height={svgSize}>
                  <Path d={backgroundArcPath} stroke={theme.colors.border} strokeWidth={7} fill="none" />
                  <Path d={currentArcPath} stroke={"#007AFF"} strokeWidth={7} fill="none" />
                  <Circle cx={knobPos.x} cy={knobPos.y} r={15} fill={"#007AFF"} />
                </Svg>
              </View>

              <Text style={[styles.angleLabel, {color: theme.colors.text}]}>{Math.round(angle)}°</Text>

              <View style={styles.buttonRow}>
                <PillButton text="Cancel" variant="secondary" onPress={onCancel} buttonStyle={styles.buttonFlex} />
                <PillButton
                  text="Save"
                  variant="primary"
                  onPress={() => onSave(Math.round(angle))}
                  buttonStyle={styles.buttonFlex}
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

const styles = StyleSheet.create({
  angleLabel: {
    fontSize: 36,
    fontWeight: "bold",
    marginVertical: 20,
  },
  buttonFlex: {
    flex: 1,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 16,
    justifyContent: "space-between",
    width: "80%",
  },
  closeButton: {
    fontSize: 22,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  modalContent: {
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
  },
  modalHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 12,
    width: "100%",
  },
  modalLabel: {
    fontSize: 18,
    fontWeight: "bold",
  },
  modalOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.25)",
    flex: 1,
    justifyContent: "center",
  },
  subtitle: {
    fontSize: 14,
    marginBottom: 20,
    textAlign: "center",
  },
  svgWrapper: {
    alignItems: "center",
    height: 400,
    justifyContent: "center",
    width: 400,
  },
})
