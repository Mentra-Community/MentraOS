import {useState, useEffect, useRef} from "react"
import {View, ViewStyle, TextStyle} from "react-native"
import Canvas, {Image as CanvasImage} from "react-native-canvas"

import {Text} from "@/components/ignite"
import {useDisplayStore} from "@/stores/display"
import {useGlassesStore} from "@/stores/glasses"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/contexts/ThemeContext"

interface GlassesDisplayMirrorProps {
  fallbackMessage?: string
  style?: ViewStyle
  fullscreen?: boolean
  demoText?: string
}

const GlassesDisplayMirror: React.FC<GlassesDisplayMirrorProps> = ({
  fallbackMessage = "",
  style,
  fullscreen = false,
  demoText = "",
}) => {
  const {themed} = useAppTheme()
  const canvasRef = useRef<Canvas>(null)
  const containerRef = useRef<View | null>(null)
  const [containerWidth, setContainerWidth] = useState<number | null>(null)
  const {currentEvent} = useDisplayStore()
  const batteryLevel = useGlassesStore(state => state.batteryLevel)

  // Use demo layout if in demo mode, otherwise use real layout
  const layout = demoText !== "" ? {layoutType: "text_wall", text: demoText} : currentEvent.layout

  const processBitmap = async () => {
    if (layout?.layoutType !== "bitmap_view" || !layout.data) {
      return
    }

    // First process the BMP to get base64
    const uri = `data:image/bmp;base64,${layout.data}`
    if (!canvasRef.current) {
      return
    }

    // Process with canvas to make black pixels transparent
    const canvas = canvasRef.current
    const ctx = canvas.getContext("2d")

    // Create image from base64
    const img = new CanvasImage(canvas)
    img.src = uri

    img.addEventListener("load", async () => {
      const WIDTH = img.width
      const HEIGHT = img.height

      let leftPadding = 0
      let topPadding = 0
      // console.log("WIDTH", WIDTH)
      // console.log("HEIGHT", HEIGHT)
      // special case for G1 bitmaps:
      if (WIDTH == 576 && HEIGHT == 135) {
        leftPadding = 29
        topPadding = 21
      }

      const ratio = (WIDTH - leftPadding) / (HEIGHT - topPadding)

      const targetWidth = containerWidth ? containerWidth : 400

      const croppedWidth = targetWidth
      const croppedHeight = targetWidth / ratio

      canvas.width = croppedWidth
      canvas.height = croppedHeight

      const x1 = -leftPadding
      const y1 = -topPadding
      const x2 = croppedWidth + leftPadding
      const y2 = croppedHeight + topPadding

      // console.log("croppedWidth", croppedWidth)
      // console.log("croppedHeight", croppedHeight)
      // console.log("x1", x1)
      // console.log("y1", y1)
      // console.log("x2", x2)
      // console.log("y2", y2)

      // Draw image to canvas
      ctx.drawImage(img, x1, y1, x2, y2)

      // Apply tint using composite operation
      ctx.globalCompositeOperation = "multiply" // or 'overlay', 'screen'
      ctx.fillStyle = "#00ff88" // Your tint color
      ctx.fillRect(0, 0, croppedWidth, croppedHeight)
    })
  }

  const parseText = (text: string) => {
    // Replace date/time placeholders
    const now = new Date()

    // Format date as MM/dd
    const dateStr = `${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getDate().toString().padStart(2, "0")}`

    // Format time as hh:mm (12-hour)
    const hours12 = now.getHours() % 12 || 12
    const minutes = now.getMinutes().toString().padStart(2, "0")
    const time12Str = `${hours12.toString().padStart(2, "0")}:${minutes}`

    // Format time as HH:mm (24-hour)
    const hours24 = now.getHours().toString().padStart(2, "0")
    const time24Str = `${hours24}:${minutes}`

    // Replace battery level placeholder
    const batteryStr = typeof batteryLevel === "number" && batteryLevel >= 0 ? `${batteryLevel}%` : ""

    // Replace all placeholders
    return text
      .replace(/\$DATE\$/g, dateStr)
      .replace(/\$TIME12\$/g, time12Str)
      .replace(/\$TIME24\$/g, time24Str)
      .replace(/\$GBATT\$/g, batteryStr)
      .replace(/\$CONNECTION_STATUS\$/g, "Connected")
  }

  /**
   * Render logic for each layoutType
   */
  const renderLayout = (
    layout: any,
    textStyle?: TextStyle,
    canvasRef?: React.RefObject<Canvas>,
    containerRef?: React.RefObject<View | null>,
    setContainerWidth?: (width: number) => void,
  ) => {
    switch (layout.layoutType) {
      case "reference_card": {
        const {title, text} = layout
        return (
          <>
            <Text style={[styles.cardTitle, textStyle]}>{title}</Text>
            <Text style={[styles.cardContent, textStyle]}>{text}</Text>
          </>
        )
      }
      case "text_wall":
      case "text_line": {
        let {text} = layout
        text = parseText(text)
        text = text.replace(/\n/g, " ")
        return <Text style={[styles.cardContent, textStyle]}>{text || text === "" ? text : ""}</Text>
      }
      case "double_text_wall": {
        let {topText, bottomText} = layout
        topText = parseText(topText)
        bottomText = parseText(bottomText)
        return (
          <View style={{flexDirection: "row", gap: 2}}>
            <Text style={[styles.cardContent, textStyle, {width: "50%"}]} numberOfLines={4}>
              {topText || topText === "" ? topText : ""}
            </Text>
            <Text style={[styles.cardContent, textStyle, {width: "50%"}]} numberOfLines={4}>
              {bottomText || bottomText === "" ? bottomText : ""}
            </Text>
          </View>
        )
      }
      case "text_rows": {
        const rows = layout.text || []
        return rows.map((row: string, index: number) => (
          <Text key={index} style={[styles.cardContent, textStyle]}>
            {parseText(row)}
          </Text>
        ))
      }
      case "bitmap_view": {
        return (
          <View
            ref={containerRef}
            style={{flex: 1, width: "100%", height: "100%", justifyContent: "center"}}
            onLayout={event => {
              const {width} = event.nativeEvent.layout
              if (setContainerWidth) {
                setContainerWidth(width)
              }
            }}>
            <Canvas ref={canvasRef} style={{width: "100%", alignItems: "center"}} />
          </View>
        )
      }
      default:
        return <Text style={[styles.cardContent, textStyle]}>Unknown layout type: {layout.layoutType}</Text>
    }
  }

  // Process bitmap data when layout or container width changes
  useEffect(() => {
    if (containerWidth) {
      processBitmap()
    }
  }, [layout, containerWidth])

  if (!layout || !layout.layoutType) {
    if (!fallbackMessage) {
      return null
    }
    return (
      <View style={[themed($glassesScreen), style]}>
        <View style={themed($emptyContainer)}>
          <Text style={themed($emptyText)}>{fallbackMessage}</Text>
        </View>
      </View>
    )
  }

  // Use green text for fullscreen, normal text color for non-fullscreen
  const textStyle = fullscreen ? themed($glassesTextFullscreen) : themed($glassesText)
  const content = <>{renderLayout(layout, textStyle, canvasRef, containerRef, setContainerWidth)}</>

  if (fullscreen) {
    return <View style={themed($glassesScreenFullscreen)}>{content}</View>
  }

  return <View style={[themed($glassesScreen), style]}>{content}</View>
}

const $glassesScreen: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  width: "100%",
  minHeight: 170,
  maxHeight: 170,
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  paddingHorizontal: spacing.s4,
  paddingVertical: spacing.s3,
})

const $glassesScreenFullscreen: ThemedStyle<ViewStyle> = () => ({
  backgroundColor: "transparent",
  minHeight: 120,
  padding: 16,
  width: "100%",
})

const $glassesText: ThemedStyle<TextStyle> = ({colors, typography}) => ({
  color: colors.text,
  fontFamily: typography.fonts.glassesMirror.normal,
  fontSize: 14,
  fontWeight: 600,
})

const $glassesTextFullscreen: ThemedStyle<TextStyle> = ({typography}) => ({
  color: "#00ff88aa",
  fontFamily: typography.fonts.glassesMirror.normal,
  fontSize: 14,
  fontWeight: 600,
})

const $emptyContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
})

const $emptyText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  fontFamily: "Montserrat-Regular",
  fontSize: 20,
  opacity: 0.5,
})

const styles = {
  cardContent: {
    fontFamily: "glassesMirror",
    fontSize: 16,
  },
  cardTitle: {
    fontFamily: "glassesMirror",
    fontSize: 18,
    // marginBottom: 5,
  },
}

export default GlassesDisplayMirror
