import colorTokensRaw from "./colors.json"

// normalize keys on import
const colorTokens = Object.entries(colorTokensRaw).reduce((acc, [key, value]) => {
  // replace spaces and hyphens with underscores, and remove duplicate underscores
  const newKey = key.replace(/\s+/g, "_").replace(/-/g, "_").replace(/_+/g, "_")
  acc[newKey] = value
  return acc
}, {} as ColorTokens)

type ColorToken = {
  type: string
  modes: {
    [key: string]: string
  }
}

type ColorTokens = {
  [key: string]: ColorToken
}

/**
 * Map a variable name to its color value.
 *
 * @param variableName - The name of the color variable (e.g., 'slate_50', 'primary')
 * @param mode - The mode to use (default: 'mode 1', can also be 'light mode', 'dark mode')
 * @returns The hex color value as a string, or null if not found
 */
export function mapVariableToColor(variableName: string, mode: string = "mode 1"): string | null {
  const tokens = colorTokens as ColorTokens

  // Normalize the variable name - try as-is first, then with underscores
  let normalizedName = variableName.replace(/[-\s]/g, "_")

  // If not found and the name contains digits, try adding underscore before last digits
  if (!(normalizedName in tokens) && /\d+$/.test(normalizedName)) {
    normalizedName = normalizedName.replace(/(\D)(\d+)$/, "$1_$2")
    // remove duplicate underscores
    normalizedName = normalizedName.replace(/_+/g, "_")
  }

  if (!normalizedName) {
    return null
  }

  if (!(normalizedName in tokens)) {
    console.log(`Color token not found: ${normalizedName}`)
    return null
  }

  const token = tokens[normalizedName]
  const modes = token.modes

  // Try to get the color for the specified mode
  let value = null
  if (mode in modes) {
    value = modes[mode]
  } else {
    // get the first object in the modes object:
    const firstMode = Object.keys(modes)[0]
    value = modes[firstMode]
  }

  // If the value is a reference to another variable, resolve it recursively
  if (typeof value === "string" && !value.startsWith("#")) {
    return mapVariableToColor(value, mode)
  }
  return value
}

/**
 * Get a dictionary mapping all variable names to their resolved color values.
 *
 * @param mode - The mode to use (default: 'mode 1')
 * @returns Object with variable names as keys and hex colors as values
 */
export function getAllColors(mode: string = "mode 1"): Record<string, string> {
  const tokens = colorTokens as ColorTokens
  const colorMap: Record<string, string> = {}

  for (let variableName in tokens) {
    const color = mapVariableToColor(variableName, mode)
    if (color) {
      // replace hyphens and spaces with underscores:
      variableName = variableName.replace(/[-\s]/g, "_")
      colorMap[variableName] = color
    }
  }

  return colorMap
}

/**
 * Get available modes for a specific variable.
 *
 * @param variableName - The name of the color variable
 * @returns Array of available mode names
 */
export function getAvailableModes(variableName: string): string[] {
  const tokens = colorTokens as ColorTokens

  if (variableName in tokens) {
    return Object.keys(tokens[variableName].modes)
  }

  return []
}

// Example usage:
// const primaryColor = mapVariableToColor('primary', 'light mode');
// const allLightColors = getAllColors('light mode');
// const modes = getAvailableModes('primary');
