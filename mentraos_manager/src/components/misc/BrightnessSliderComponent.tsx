import React, {useRef, useState, useEffect} from "react"
import {View, StyleSheet, PanResponder, LayoutChangeEvent} from "react-native"

interface BrightnessSliderComponentProps {
  value: number
  onValueChange: (value: number) => void
  minimumValue?: number
  maximumValue?: number
}

const BrightnessSliderComponent: React.FC<BrightnessSliderComponentProps> = ({
  value,
  onValueChange,
  minimumValue = 0,
  maximumValue = 100,
}) => {
  const [sliderWidth, setSliderWidth] = useState(0)

  // Use a ref to always hold the latest onValueChange callback.
  const onValueChangeRef = useRef(onValueChange)
  useEffect(() => {
    onValueChangeRef.current = onValueChange
  }, [onValueChange])

  const computeValueFromTouch = (touchX: number) => {
    // If the slider width is not set yet, do nothing.
    if (sliderWidth === 0) {
      return value
    }
    // Clamp ratio between 0 and 1.
    const ratio = Math.max(0, Math.min(1, touchX / sliderWidth))
    return Math.round(minimumValue + ratio * (maximumValue - minimumValue))
  }

  const panResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: evt => {
      const newValue = computeValueFromTouch(evt.nativeEvent.locationX)
      onValueChange(newValue)
    },
    onPanResponderMove: evt => {
      const newValue = computeValueFromTouch(evt.nativeEvent.locationX)
      onValueChange(newValue)
    },
  })

  const handleLayout = (e: LayoutChangeEvent) => {
    setSliderWidth(e.nativeEvent.layout.width)
  }

  // Calculate thumb's horizontal position based on the current value.
  const thumbPosition = sliderWidth * ((value - minimumValue) / (maximumValue - minimumValue))

  return (
    <View style={styles.container} onLayout={handleLayout} {...panResponder.panHandlers}>
      {/* Full track */}
      <View style={styles.track} />
      {/* Filled portion of the track */}
      <View style={[styles.filledTrack, {width: thumbPosition}]} />
      {/* Draggable thumb */}
      <View style={[styles.thumb, {left: thumbPosition - styles.thumb.width / 2}]} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    height: 40,
    justifyContent: "center",
  },
  filledTrack: {
    backgroundColor: "#2196F3",
    borderRadius: 2,
    height: 4,
    position: "absolute",
  },
  thumb: {
    backgroundColor: "#2196F3",
    borderRadius: 10,
    height: 20,
    position: "absolute",
    top: 10,
    width: 20, // centers the thumb vertically (40 - 20)/2
  },
  track: {
    backgroundColor: "#D1D1D6",
    borderRadius: 2,
    height: 4,
  },
})

export default BrightnessSliderComponent
