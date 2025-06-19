import React from "react"
import {View, Text, StyleSheet, Image} from "react-native"

interface GlassesDisplayMirrorFullscreenProps {
  layout: any
  fallbackMessage?: string
}

const GlassesDisplayMirrorFullscreen: React.FC<GlassesDisplayMirrorFullscreenProps> = ({
  layout,
  fallbackMessage = "No display data available",
}) => {
  return (
    <View style={styles.glassesDisplayContainer}>
      <View style={styles.glassesScreen}>
        {layout && layout.layoutType ? renderLayout(layout) : <Text style={styles.glassesText}>{fallbackMessage}</Text>}
      </View>
    </View>
  )
}

/**
 * Render logic for each layoutType
 */
function renderLayout(layout: any) {
  const textStyle = styles.glassesText

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
      const {text} = layout
      // Even if text is empty, show a placeholder message for text_wall layouts
      return <Text style={[styles.cardContent, textStyle]}>{text || text === "" ? text : ""}</Text>
    }
    case "double_text_wall": {
      const {topText, bottomText} = layout
      return (
        <>
          <Text style={[styles.cardContent, textStyle]}>{topText}</Text>
          <Text style={[styles.cardContent, textStyle]}>{bottomText}</Text>
        </>
      )
    }
    case "text_rows": {
      // layout.text is presumably an array of strings
      const rows = layout.text || []
      return rows.map((row: string, index: number) => (
        <Text key={index} style={[styles.cardContent, textStyle]}>
          {row}
        </Text>
      ))
    }
    case "bitmap_view": {
      // layout.data is a base64 string. We can show an image in RN by creating a data URL
      // e.g. { uri: "data:image/png;base64,<base64string>" }
      const {data} = layout
      const imageUri = `data:image/png;base64,${data}`
      return (
        <Image
          source={{uri: imageUri}}
          style={{width: 200, height: 200, resizeMode: "contain", tintColor: "#00FF00"}}
        />
      )
    }
    default:
      return <Text style={[styles.cardContent, textStyle]}>Unknown layout type: {layout.layoutType}</Text>
  }
}

const styles = StyleSheet.create({
  cardContent: {
    fontFamily: "Montserrat-Regular",
    fontSize: 18,
  },
  cardTitle: {
    fontFamily: "Montserrat-Bold",
    fontSize: 22,
    marginBottom: 10,
  },
  emptyTextWall: {
    alignItems: "center",
    borderColor: "#00FF00",
    borderStyle: "dashed",
    borderWidth: 1,
    height: 100,
    justifyContent: "center",
    width: "100%",
  },
  glassesDisplayContainer: {
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    width: "100%",
  },
  glassesScreen: {
    backgroundColor: "transparent",
    minHeight: 120,
    padding: 15,
    width: "100%",
  },
  glassesText: {
    color: "#00FF00", // Bright green color for monochrome display
    fontFamily: "Montserrat-Regular",
    fontSize: 18,
    // Add text shadow for better visibility against any background
    textShadowColor: "rgba(0, 0, 0, 0.9)",
    textShadowOffset: {width: 1, height: 1},
    textShadowRadius: 3,
  },
})

export default GlassesDisplayMirrorFullscreen
