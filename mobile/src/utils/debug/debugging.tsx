// @ts-nocheck

import {Text} from "@/components/ignite/Text"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import {useEffect, useRef, useState} from "react"
import {ScrollView, TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"

export const DebugHitSlop = ({children, hitSlop, style, ...props}) => {
  if (!__DEV__ || !hitSlop) return children

  const hitSlopStyle = {
    position: "absolute",
    top: -(hitSlop.top || hitSlop || 0),
    bottom: -(hitSlop.bottom || hitSlop || 0),
    left: -(hitSlop.left || hitSlop || 0),
    right: -(hitSlop.right || hitSlop || 0),
    borderWidth: 1,
    borderColor: "rgba(255, 0, 0, 0.5)",
    borderStyle: "dashed",
    backgroundColor: "rgba(255, 0, 0, 0.1)",
    pointerEvents: "none",
  }

  return (
    <View style={style}>
      {children}
      <View style={hitSlopStyle} />
    </View>
  )
}

/**
 * Deep compares two objects and returns detailed differences
 */
function deepCompare(obj1: any, obj2: any, path: string = ""): DiffResult[] {
  const differences: DiffResult[] = []

  // Handle null/undefined cases
  if (obj1 === null || obj1 === undefined || obj2 === null || obj2 === undefined) {
    if (obj1 !== obj2) {
      differences.push({
        path: path || "root",
        type: "changed",
        oldValue: obj1,
        newValue: obj2,
      })
    }
    return differences
  }

  // Handle primitive types
  if (typeof obj1 !== "object" || typeof obj2 !== "object") {
    if (obj1 !== obj2) {
      differences.push({
        path: path || "root",
        type: "changed",
        oldValue: obj1,
        newValue: obj2,
      })
    }
    return differences
  }

  // Handle arrays
  if (Array.isArray(obj1) || Array.isArray(obj2)) {
    if (!Array.isArray(obj1) || !Array.isArray(obj2)) {
      differences.push({
        path: path || "root",
        type: "type_changed",
        oldValue: obj1,
        newValue: obj2,
      })
      return differences
    }

    const maxLength = Math.max(obj1.length, obj2.length)
    for (let i = 0; i < maxLength; i++) {
      const currentPath = path ? `${path}[${i}]` : `[${i}]`

      if (i >= obj1.length) {
        differences.push({
          path: currentPath,
          type: "added",
          oldValue: undefined,
          newValue: obj2[i],
        })
      } else if (i >= obj2.length) {
        differences.push({
          path: currentPath,
          type: "removed",
          oldValue: obj1[i],
          newValue: undefined,
        })
      } else {
        differences.push(...deepCompare(obj1[i], obj2[i], currentPath))
      }
    }
    return differences
  }

  // Handle objects
  const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)])

  for (const key of allKeys) {
    const currentPath = path ? `${path}.${key}` : key

    if (!(key in obj1)) {
      differences.push({
        path: currentPath,
        type: "added",
        oldValue: undefined,
        newValue: obj2[key],
      })
    } else if (!(key in obj2)) {
      differences.push({
        path: currentPath,
        type: "removed",
        oldValue: obj1[key],
        newValue: undefined,
      })
    } else {
      differences.push(...deepCompare(obj1[key], obj2[key], currentPath))
    }
  }

  return differences
}

/**
 * Pretty prints the differences between two objects
 */
function prettyPrintDiff(obj1: any, obj2: any, options: PrintOptions = {}): void {
  const {colorize = true, compact = false} = options

  const differences = deepCompare(obj1, obj2)

  if (differences.length === 0) {
    console.log(colorize ? "\x1b[32m✓ Objects are identical\x1b[0m" : "✓ Objects are identical")
    return
  }

  console.log(colorize ? "\x1b[33m═══ Object Differences ═══\x1b[0m" : "═══ Object Differences ═══")
  console.log(`Found ${differences.length} difference(s)\n`)

  // Group differences by type
  const grouped = {
    added: differences.filter(d => d.type === "added"),
    removed: differences.filter(d => d.type === "removed"),
    changed: differences.filter(d => d.type === "changed"),
    type_changed: differences.filter(d => d.type === "type_changed"),
  }

  // Print additions
  if (grouped.added.length > 0) {
    console.log(colorize ? "\x1b[32m+ Added Properties:\x1b[0m" : "+ Added Properties:")
    grouped.added.forEach(diff => {
      if (compact) {
        console.log(`  ${diff.path}: ${JSON.stringify(diff.newValue)}`)
      } else {
        console.log(`  Path: ${diff.path}`)
        console.log(`  Value: ${JSON.stringify(diff.newValue, null, 2).split("\n").join("\n  ")}`)
        console.log("")
      }
    })
  }

  // Print removals
  if (grouped.removed.length > 0) {
    console.log(colorize ? "\x1b[31m- Removed Properties:\x1b[0m" : "- Removed Properties:")
    grouped.removed.forEach(diff => {
      if (compact) {
        console.log(`  ${diff.path}: ${JSON.stringify(diff.oldValue)}`)
      } else {
        console.log(`  Path: ${diff.path}`)
        console.log(`  Value: ${JSON.stringify(diff.oldValue, null, 2).split("\n").join("\n  ")}`)
        console.log("")
      }
    })
  }

  // Print changes
  if (grouped.changed.length > 0) {
    console.log(colorize ? "\x1b[36m~ Changed Properties:\x1b[0m" : "~ Changed Properties:")
    grouped.changed.forEach(diff => {
      if (compact) {
        console.log(`  ${diff.path}: ${JSON.stringify(diff.oldValue)} → ${JSON.stringify(diff.newValue)}`)
      } else {
        console.log(`  Path: ${diff.path}`)
        console.log(`  Old: ${JSON.stringify(diff.oldValue, null, 2).split("\n").join("\n  ")}`)
        console.log(`  New: ${JSON.stringify(diff.newValue, null, 2).split("\n").join("\n  ")}`)
        console.log("")
      }
    })
  }

  // Print type changes
  if (grouped.type_changed.length > 0) {
    console.log(colorize ? "\x1b[35m⚠ Type Changes:\x1b[0m" : "⚠ Type Changes:")
    grouped.type_changed.forEach(diff => {
      const oldType = Array.isArray(diff.oldValue) ? "array" : typeof diff.oldValue
      const newType = Array.isArray(diff.newValue) ? "array" : typeof diff.newValue

      if (compact) {
        console.log(`  ${diff.path}: ${oldType} → ${newType}`)
      } else {
        console.log(`  Path: ${diff.path}`)
        console.log(`  Changed from ${oldType} to ${newType}`)
        console.log(`  Old: ${JSON.stringify(diff.oldValue, null, 2).split("\n").join("\n  ")}`)
        console.log(`  New: ${JSON.stringify(diff.newValue, null, 2).split("\n").join("\n  ")}`)
        console.log("")
      }
    })
  }
}

/**
 * Returns differences as a formatted string
 */
function getDiffString(obj1: any, obj2: any, _options: PrintOptions = {}): string {
  const differences = deepCompare(obj1, obj2)

  if (differences.length === 0) {
    return "✓ Objects are identical"
  }

  let output = "═══ Object Differences ═══\n"
  output += `Found ${differences.length} difference(s)\n\n`

  const grouped = {
    added: differences.filter(d => d.type === "added"),
    removed: differences.filter(d => d.type === "removed"),
    changed: differences.filter(d => d.type === "changed"),
    type_changed: differences.filter(d => d.type === "type_changed"),
  }

  if (grouped.added.length > 0) {
    output += "+ Added Properties:\n"
    grouped.added.forEach(diff => {
      output += `  ${diff.path}: ${JSON.stringify(diff.newValue)}\n`
    })
    output += "\n"
  }

  if (grouped.removed.length > 0) {
    output += "- Removed Properties:\n"
    grouped.removed.forEach(diff => {
      output += `  ${diff.path}: ${JSON.stringify(diff.oldValue)}\n`
    })
    output += "\n"
  }

  if (grouped.changed.length > 0) {
    output += "~ Changed Properties:\n"
    grouped.changed.forEach(diff => {
      output += `  ${diff.path}: ${JSON.stringify(diff.oldValue)} → ${JSON.stringify(diff.newValue)}\n`
    })
    output += "\n"
  }

  if (grouped.type_changed.length > 0) {
    output += "⚠ Type Changes:\n"
    grouped.type_changed.forEach(diff => {
      const oldType = Array.isArray(diff.oldValue) ? "array" : typeof diff.oldValue
      const newType = Array.isArray(diff.newValue) ? "array" : typeof diff.newValue
      output += `  ${diff.path}: ${oldType} → ${newType}\n`
    })
  }

  return output
}

// Type definitions
interface DiffResult {
  path: string
  type: "added" | "removed" | "changed" | "type_changed"
  oldValue: any
  newValue: any
}

interface PrintOptions {
  showEqual?: boolean
  colorize?: boolean
  compact?: boolean
}

// Export functions
export {deepCompare, getDiffString, prettyPrintDiff}

// Example usage:
/*
const obj1 = {
  name: "John",
  age: 30,
  address: {
    city: "New York",
    zip: "10001"
  },
  hobbies: ["reading", "gaming"],
  active: true
};

const obj2 = {
  name: "John",
  age: 31,
  address: {
    city: "Boston",
    zip: "10001",
    country: "USA"
  },
  hobbies: ["reading", "gaming", "cooking"],
  email: "john@example.com"
};

// Pretty print to console with colors
prettyPrintDiff(obj1, obj2);

// Get compact output
prettyPrintDiff(obj1, obj2, { compact: true });

// Get as string
const diffString = getDiffString(obj1, obj2);
console.log(diffString);

// Get raw diff data
const differences = deepCompare(obj1, obj2);
console.log(differences);
*/

export const ConsoleLogger = () => {
  const [logs, setLogs] = useState([])
  const [isVisible, setIsVisible] = useState(true)
  const scrollViewRef = useRef(null)
  const {themed} = useAppTheme()

  useEffect(() => {
    const originalLog = console.log
    const originalWarn = console.warn
    const originalError = console.error

    const addLog = (type: string, args: any[]) => {
      const message = args.map(arg => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg))).join(" ")

      setLogs(prev => {
        const newLogs = [
          ...prev,
          {
            type,
            message,
            timestamp: new Date().toLocaleTimeString(),
          },
        ]
        return newLogs.slice(-500) // Keep only last 100
      })
    }

    console.log = (...args) => {
      addLog("log", args)
      originalLog(...args)
    }

    console.warn = (...args) => {
      addLog("warn", args)
      originalWarn(...args)
    }

    console.error = (...args) => {
      addLog("error", args)
      originalError(...args)
    }

    return () => {
      console.log = originalLog
      console.warn = originalWarn
      console.error = originalError
    }
  }, [])

  if (!isVisible) {
    return (
      <TouchableOpacity style={themed($toggleButton)} onPress={() => setIsVisible(true)}>
        <Text style={themed($toggleButtonText)}>Show Console</Text>
      </TouchableOpacity>
    )
  }

  return (
    <View style={themed($container)}>
      <View style={themed($header)}>
        <Text style={themed($headerText)}>Console ({logs.length}/100)</Text>
        <View style={themed($headerButtons)}>
          <TouchableOpacity style={themed($clearButton)} onPress={() => setLogs([])}>
            <Text style={themed($buttonText)}>Clear</Text>
          </TouchableOpacity>
          <TouchableOpacity style={themed($hideButton)} onPress={() => setIsVisible(false)}>
            <Text style={themed($buttonText)}>Hide</Text>
          </TouchableOpacity>
        </View>
      </View>
      <ScrollView
        ref={scrollViewRef}
        style={themed($logContainer)}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd()}>
        {logs.map((log: any, index: number) => (
          <View key={index} style={themed($logEntry)}>
            <Text style={themed($timestamp)}>{log.timestamp}</Text>
            <Text
              style={[
                themed($logText),
                log.type === "error" && themed($errorText),
                log.type === "warn" && themed($warnText),
              ]}>
              [{log.type.toUpperCase()}] {log.message}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  top: 50,
  left: 0,
  right: 0,
  height: 250,
  backgroundColor: colors.background,
  borderTopWidth: 2,
  borderTopColor: colors.border,
  zIndex: 1000,
})

const $header: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  padding: spacing.s3 || 8,
  backgroundColor: colors.background,
  borderBottomWidth: 1,
  borderBottomColor: colors.border || "#333",
})

const $headerText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 14,
})

const $headerButtons: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  gap: spacing.s2 || 8,
})

const $clearButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.tint,
  paddingHorizontal: spacing.s4 || 12,
  paddingVertical: spacing.s2 || 4,
  borderRadius: spacing.s2 || 4,
})

const $hideButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.tint,
  paddingHorizontal: spacing.s4 || 12,
  paddingVertical: spacing.s2 || 4,
  borderRadius: spacing.s2 || 4,
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 12,
})

const $logContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.s3 || 8,
})

const $logEntry: ThemedStyle<ViewStyle> = () => ({
  marginBottom: 4,
})

const $timestamp: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim || "#888",
  fontSize: 10,
  fontFamily: "monospace",
})

const $logText: ThemedStyle<TextStyle> = () => ({
  color: "#0f0", // Most themes won't have neon green, so fall back to legacy color
  fontFamily: "monospace",
  fontSize: 11,
})

const $errorText: ThemedStyle<TextStyle> = () => ({
  color: "#f00",
})

const $warnText: ThemedStyle<TextStyle> = () => ({
  color: "#ff0",
})

const $toggleButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  position: "absolute",
  bottom: 20,
  right: 20,
  backgroundColor: colors.tint,
  paddingHorizontal: spacing.s5 || 16,
  paddingVertical: spacing.s3 || 8,
  borderRadius: spacing.s3 || 8,
  borderWidth: 1,
  borderColor: colors.border || "#333",
  zIndex: 1000,
})

const $toggleButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 12,
})
