import {useState, useEffect, useRef} from "react"
import {Image, ImageStyle, View, ViewStyle, TextStyle} from "react-native"
import Canvas, {Image as CanvasImage} from "react-native-canvas"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {ThemedStyle} from "@/theme"
import {engine} from "@mentra/engine"

// Native glasses display resolution. Canvas (positioned_text / bitmap) layouts
// give coordinates in this space; the mirror scales them to its rendered size.
const GLASSES_WIDTH = 560
const GLASSES_HEIGHT = 240

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
  const currentEvent = useEngineSnapshot(engine.display.mirror.current, (onChange) =>
    engine.display.mirror.onMirror(onChange),
  )
  const batteryLevel = useEngineSnapshot(engine.glasses.status, (onChange) => engine.glasses.onStatus(onChange)).battery

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
    canvasRef?: React.RefObject<Canvas | null>,
    containerRef?: React.RefObject<View | null>,
    setContainerWidth?: (width: number) => void,
  ) => {
    switch (layout.layoutType) {
      case "reference_card": {
        const {title, text} = layout
        return (
          <>
            <Text style={[textStyle, styles.cardTitle]}>{title}</Text>
            <Text style={[textStyle, styles.cardContent]}>{text}</Text>
          </>
        )
      }
      case "text_wall":
      case "text_line": {
        let {text} = layout
        text = parseText(text)
        // Render each line separately to match glasses display exactly
        const lines = text.split("\n")
        return (
          <View style={{gap: 2}}>
            {lines.map((line: string, index: number) => (
              <Text key={index} style={[textStyle, styles.cardContent]} numberOfLines={1}>
                {line || "\u00A0"} {/* Non-breaking space for empty lines */}
              </Text>
            ))}
          </View>
        )
      }
      case "double_text_wall": {
        let {topText, bottomText} = layout
        topText = parseText(topText)
        bottomText = parseText(bottomText)
        return (
          <View style={{flexDirection: "row", gap: 2}}>
            <Text style={[textStyle, styles.cardContent, {width: "50%"}]} numberOfLines={4}>
              {topText || topText === "" ? topText : ""}
            </Text>
            <Text style={[textStyle, styles.cardContent, {width: "50%"}]} numberOfLines={4}>
              {bottomText || bottomText === "" ? bottomText : ""}
            </Text>
          </View>
        )
      }
      case "text_rows": {
        const rows = layout.text || []
        return rows.map((row: string, index: number) => (
          <Text key={index} style={[textStyle, styles.cardContent]}>
            {parseText(row)}
          </Text>
        ))
      }
      case "bitmap_view": {
        return (
          <View
            ref={containerRef}
            style={{flex: 1, width: "100%", height: "100%", justifyContent: "center"}}
            onLayout={(event) => {
              const {width} = event.nativeEvent.layout
              if (setContainerWidth) {
                setContainerWidth(width)
              }
            }}>
            <Canvas ref={canvasRef} style={{width: "100%", alignItems: "center"}} />
          </View>
        )
      }
      case "positioned_text": {
        // Canvas showText: text placed at an absolute (x, y) in the glasses'
        // native coordinate space (GLASSES_WIDTH x GLASSES_HEIGHT). The mirror
        // renders the full screen scaled to fit its container, so we lay the box
        // out absolutely and scale every coordinate by the same factor.
        let {text, x, y, width, height, borderWidth, borderRadius} = layout
        text = parseText(typeof text === "string" ? text : "")

        // Scale from native px -> rendered px. We only know the width until the
        // container measures, so default to 1 (unscaled) before first layout.
        const scale = containerWidth ? containerWidth / GLASSES_WIDTH : 1

        const boxStyle: ViewStyle = {
          position: "absolute",
          left: (Number(x) || 0) * scale,
          top: (Number(y) || 0) * scale,
        }
        if (typeof width === "number") boxStyle.width = width * scale
        if (typeof height === "number") boxStyle.height = height * scale
        if (typeof borderWidth === "number" && borderWidth > 0) {
          boxStyle.borderWidth = Math.max(1, borderWidth * scale)
          boxStyle.borderColor = (textStyle?.color as string) ?? "#00ff88aa"
        }
        if (typeof borderRadius === "number") {
          boxStyle.borderRadius = borderRadius * scale
        }

        return (
          <View
            ref={containerRef}
            style={{width: "100%", height: "100%"}}
            onLayout={(event) => {
              const {width: w} = event.nativeEvent.layout
              if (setContainerWidth) {
                setContainerWidth(w)
              }
            }}>
            <View style={boxStyle}>
              {text.split("\n").map((line: string, index: number) => (
                <Text key={index} style={[textStyle, styles.cardContent]}>
                  {line || " "}
                </Text>
              ))}
            </View>
          </View>
        )
      }
      case "scene": {
        const sceneWidth = Number(layout.width) || GLASSES_WIDTH
        const scale = containerWidth ? containerWidth / sceneWidth : 1
        const elements = Array.isArray(layout.elements) ? layout.elements : []

        return (
          <View
            ref={containerRef}
            style={{width: "100%", height: "100%", overflow: "hidden"}}
            onLayout={(event) => {
              const {width} = event.nativeEvent.layout
              if (setContainerWidth) {
                setContainerWidth(width)
              }
            }}>
            {elements.map((element: any, index: number) => {
              const box = element?.box ?? {}
              const elementStyle = element?.style ?? {}
              const frameStyle: ImageStyle = {
                position: "absolute",
                left: (Number(box.x) || 0) * scale,
                top: (Number(box.y) || 0) * scale,
                width: Math.max(0, Number(box.w) || 0) * scale,
                height: Math.max(0, Number(box.h) || 0) * scale,
                overflow: "hidden",
              }
              const border = Number(elementStyle.border) || (element?.type === "rect" ? 1 : 0)
              if (border > 0) {
                frameStyle.borderWidth = Math.max(1, border * scale)
                frameStyle.borderColor = (textStyle?.color as string) ?? "#00ff88aa"
              }
              const radius = Number(elementStyle.radius) || 0
              if (radius > 0) {
                frameStyle.borderRadius = radius * scale
              }

              const key = typeof element?.id === "string" ? element.id : `scene-${index}`
              if (element?.type === "image" && typeof element.data === "string" && element.data !== "") {
                const uri = element.data.startsWith("data:") ? element.data : `data:image/png;base64,${element.data}`
                return <Image key={key} source={{uri}} style={frameStyle} resizeMode="contain" />
              }

              if (element?.type === "text") {
                const text = parseText(typeof element.text === "string" ? element.text : "")
                return (
                  <View key={key} style={frameStyle}>
                    {text.split("\n").map((line: string, lineIndex: number) => (
                      <Text key={lineIndex} style={[textStyle, styles.cardContent]}>
                        {line || " "}
                      </Text>
                    ))}
                  </View>
                )
              }

              return <View key={key} style={frameStyle} />
            })}
          </View>
        )
      }
      case "clear_view":
        return null
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

  // positioned_text places content at absolute native coords from the top-left,
  // so the screen must match the glasses aspect ratio and drop its inner padding
  // for the scaled coordinates to land where they should.
  const isPositioned = layout.layoutType === "positioned_text" || layout.layoutType === "scene"
  const positionedWidth = layout.layoutType === "scene" ? Number(layout.width) || GLASSES_WIDTH : GLASSES_WIDTH
  const positionedHeight = layout.layoutType === "scene" ? Number(layout.height) || GLASSES_HEIGHT : GLASSES_HEIGHT
  const positionedOverride: ViewStyle = isPositioned
    ? {
        aspectRatio: positionedWidth / positionedHeight,
        minHeight: undefined,
        maxHeight: undefined,
        padding: 0,
        paddingHorizontal: 0,
        paddingVertical: 0,
        overflow: "hidden",
      }
    : {}

  if (fullscreen) {
    return <View style={[themed($glassesScreenFullscreen), positionedOverride]}>{content}</View>
  }

  return <View style={[themed($glassesScreen), style, positionedOverride]}>{content}</View>
}

const $glassesScreen: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  width: "100%",
  minHeight: 170,
  maxHeight: 170,
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  paddingHorizontal: spacing.s2,
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
    fontSize: 10,
  },
  cardTitle: {
    fontFamily: "glassesMirror",
    fontSize: 10,
  },
}

export default GlassesDisplayMirror
